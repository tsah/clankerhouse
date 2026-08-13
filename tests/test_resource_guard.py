import json
import os
import pathlib
import signal
import tempfile
import unittest
from dataclasses import replace

from clankerhouse.resource_guard import Config, ResourceGuard, parse_meminfo, parse_psi


class FakeSystem:
    def __init__(self):
        self.proc = pathlib.Path("/fake/proc")
        self.sysfs = pathlib.Path("/fake/sys")
        self.files = {
            str(self.proc / "sys/kernel/random/boot_id"): "boot-a\n",
            str(self.sysfs / "class/dmi/id/sys_vendor"): "Amazon EC2\n",
            str(self.sysfs / "class/dmi/id/product_name"): "m7g.large\n",
        }
        self.stats = {}
        self.uids = {}
        self.commands = {}
        self.comms = {}
        self.child_map = {}
        self.rss = {}
        self.signals = []
        self.dead_after_term = False

    def read_text(self, path):
        try:
            return self.files[str(path)]
        except KeyError:
            raise FileNotFoundError(path)

    def boot_id(self):
        return self.read_text(self.proc / "sys/kernel/random/boot_id").strip()

    def uid(self, pid):
        return self.uids.get(pid)

    def stat(self, pid):
        return self.stats.get(pid)

    def cmdline(self, pid):
        return self.commands.get(pid, [])

    def comm(self, pid):
        return self.comms.get(pid, "")

    def rss_bytes(self, pid):
        return self.rss.get(pid, 0)

    def children(self, pid):
        return list(self.child_map.get(pid, []))

    def kill(self, pid, sig):
        self.signals.append((pid, sig))
        if sig == signal.SIGTERM and self.dead_after_term:
            self.stats.pop(pid, None)

    def alive(self, pid):
        return pid in self.stats


class FakeTmux:
    def __init__(self, listing=""):
        self.listing = listing
        self.identities = {}

    def list_panes(self):
        return self.listing

    def pane_identity(self, pane):
        return self.identities.get(pane)


class ResourceGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temporary.name)
        self.config = Config(
            samples=2,
            interval=0,
            term_grace=0,
            state_home=root / "state",
            runtime_dir=root / "run",
        )
        self.system = FakeSystem()
        self.tmux = FakeTmux()
        self.clock = 1_700_000_000.0

    def tearDown(self):
        self.temporary.cleanup()

    def guard(self, config=None):
        return ResourceGuard(
            config or self.config,
            system=self.system,
            tmux=self.tmux,
            sleep=lambda _seconds: None,
            now=lambda: self.clock,
        )

    def memory(self, available_kib=400_000, total_kib=8 * 1024 * 1024, swap_kib=0, some=12, full=0):
        self.system.files[str(self.system.proc / "meminfo")] = (
            f"MemTotal:       {total_kib} kB\n"
            f"MemAvailable:   {available_kib} kB\n"
            f"SwapTotal:      {swap_kib} kB\n"
        )
        self.system.files[str(self.system.proc / "pressure/memory")] = (
            f"some avg10={some:.2f} avg60=1.00 avg300=1.00 total=1\n"
            f"full avg10={full:.2f} avg60=0.00 avg300=0.00 total=0\n"
        )

    def add_process(self, pid, parent, harness, start=100):
        self.system.stats[parent] = (1, 10)
        self.system.stats[pid] = (parent, start)
        self.system.uids[pid] = os.getuid()
        self.system.commands[pid] = [f"/usr/bin/{harness}"]
        self.system.child_map.setdefault(parent, []).append(pid)

    def report(self, pane, harness, clanker_id, state):
        safe = pane.replace("%", "%")
        directory = self.config.runtime_dir / f"clankerhouse-{os.getuid()}" / "clanker-state"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{safe}.json").write_text(json.dumps({
            "pane": pane, "harness": harness, "clankerId": clanker_id, "state": state,
        }), encoding="utf-8")

    def incidents(self):
        directory = self.config.state_dir / "incidents"
        return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.json"))]

    def test_proc_parsers_require_linux_fields(self):
        values = parse_meminfo("MemTotal: 1000 kB\nMemAvailable: 100 kB\nSwapTotal: 0 kB\n")
        self.assertEqual(values["MemAvailable"], 100 * 1024)
        self.assertEqual(parse_psi("some avg10=10.50 total=1\nfull avg10=2.25 total=1\n"), (10.5, 2.25))
        with self.assertRaises(ValueError):
            parse_meminfo("MemTotal: 1000 kB\n")

    def test_ec2_swapless_threshold_is_max_of_512_mib_and_ten_percent(self):
        self.memory(total_kib=4 * 1024 * 1024)
        sample = self.guard().sample()
        self.assertTrue(sample.ec2_swapless)
        self.assertEqual(sample.threshold_bytes, 512 * 1024 * 1024)

        self.memory(total_kib=16 * 1024 * 1024)
        sample = self.guard().sample()
        self.assertEqual(sample.threshold_bytes, int(16 * 1024 * 1024 * 1024 * 0.10))

    def test_generic_threshold_is_seven_and_a_half_percent(self):
        self.system.files[str(self.system.sysfs / "class/dmi/id/sys_vendor")] = "Other Vendor"
        self.system.files[str(self.system.sysfs / "class/dmi/id/product_name")] = "machine"
        self.memory(total_kib=8 * 1024 * 1024)
        sample = self.guard().sample()
        self.assertFalse(sample.ec2_swapless)
        self.assertEqual(sample.threshold_bytes, int(8 * 1024 * 1024 * 1024 * 0.075))

    def test_pressure_must_be_low_memory_and_psi_and_sustained(self):
        config = replace(self.config, samples=2, dry_run=True)
        guard = self.guard(config)
        self.memory(available_kib=100_000, some=11)
        guard.run_once()
        self.assertEqual(guard.consecutive, 1)
        self.assertEqual(self.incidents(), [])

        self.memory(available_kib=100_000, some=1, full=1)
        guard.run_once()
        self.assertEqual(guard.consecutive, 0)

        self.memory(available_kib=100_000, some=1, full=2)
        guard.run_once()
        guard.run_once()
        self.assertEqual(self.incidents(), [])
        snapshot = json.loads(guard.snapshot_path.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["mitigation_skipped"], "no_non_focused_candidate")

    def test_discovers_only_exact_tagged_clankers_and_excludes_focused(self):
        self.add_process(101, 11, "pi")
        self.add_process(102, 12, "claude")
        self.add_process(103, 13, "opencode")
        self.add_process(104, 14, "pi-helper")
        self.tmux.listing = "\n".join((
            "%1\tpi\tid-1\t101\t11\t0\t1\t1\ts1\t/cwd1\t/wt1",
            "%2\tclaude\tid-2\t0\t12\t1\t1\t1\ts2\t/cwd2\t/wt2",
            "%3\topencode\tid-3\t103\t13\t0\t1\t0\ts3\t/cwd3\t/wt3",
            "%4\tpi-helper\tid-4\t104\t14\t0\t1\t1\ts4\t/cwd4\t/wt4",
            "%5\tpi\t\t101\t11\t0\t1\t1\ts5\t/cwd5\t/wt5",
        ))
        self.report("%1", "pi", "id-1", "working")
        self.report("%2", "claude", "id-2", "done")
        candidates = self.guard().discover()
        self.assertEqual([value.pane for value in candidates], ["%1", "%2", "%3"])
        self.assertEqual([value.pane for value in candidates if value.focused], ["%2"])

    def test_selection_orders_done_idle_unknown_blocked_working(self):
        guard = self.guard()
        panes = []
        for index, (harness, state) in enumerate((
            ("pi", "working"), ("claude", "blocked"), ("opencode", "unknown"), ("pi", "idle"), ("claude", "done"),
        ), start=1):
            pid, parent, pane, clanker_id = 200 + index, 20 + index, f"%{index}", f"id-{index}"
            self.add_process(pid, parent, harness)
            panes.append(f"{pane}\t{harness}\t{clanker_id}\t{pid}\t{parent}\t0\t1\t1\tsession-{index}\t/cwd-{index}\t/wt-{index}")
            self.report(pane, harness, clanker_id, state)
        self.tmux.listing = "\n".join(panes)
        selected = guard.select(guard.discover())
        self.assertEqual(selected.state, "idle")  # pane id tie-break within done/idle
        self.assertEqual(selected.pane, "%4")

    def test_selection_prefers_largest_rss_within_same_state(self):
        self.add_process(281, 28, "pi")
        self.add_process(291, 29, "claude")
        self.system.rss[281] = 100
        self.system.rss[291] = 500
        self.tmux.listing = "\n".join((
            "%1\tpi\tid-1\t281\t28\t0\t1\t1\ts1\t/cwd1\t/wt1",
            "%2\tclaude\tid-2\t291\t29\t0\t1\t1\ts2\t/cwd2\t/wt2",
        ))
        self.report("%1", "pi", "id-1", "idle")
        self.report("%2", "claude", "id-2", "idle")
        selected = self.guard().select(self.guard().discover())
        self.assertEqual(selected.pane, "%2")

    def test_duplicate_clanker_ids_are_rejected(self):
        self.add_process(281, 28, "pi")
        self.add_process(291, 29, "claude")
        self.tmux.listing = "\n".join((
            "%1\tpi\tduplicate\t281\t28\t0\t1\t1\ts1\t/cwd1\t/wt1",
            "%2\tclaude\tduplicate\t291\t29\t0\t1\t1\ts2\t/cwd2\t/wt2",
        ))
        self.assertEqual(self.guard().discover(), [])

    def test_revalidation_checks_start_ticks_identity_ancestry_and_uid(self):
        self.add_process(301, 31, "pi", start=500)
        self.tmux.listing = "%1\tpi\tid\t301\t31\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("pi", "id", 301, 31, False)
        guard = self.guard()
        candidate = guard.discover()[0]
        self.assertTrue(guard.validate(candidate))
        self.tmux.identities["%1"] = ("pi", "id", 301, 31, True)
        self.assertFalse(guard.validate(candidate))
        self.tmux.identities["%1"] = ("pi", "id", 301, 31, False)
        self.system.stats[301] = (31, 501)
        self.assertFalse(guard.validate(candidate))
        self.system.stats[301] = (99, 500)
        self.assertFalse(guard.validate(candidate))
        self.system.stats[301] = (31, 500)
        self.system.commands[301] = ["/usr/bin/not-pi"]
        self.assertFalse(guard.validate(candidate))

    def test_term_then_optional_kill_only_once_per_boot(self):
        self.add_process(401, 41, "pi")
        self.tmux.listing = "%1\tpi\tid\t401\t41\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("pi", "id", 401, 41, False)
        self.report("%1", "pi", "id", "done")
        self.memory(available_kib=100_000, some=20)
        config = replace(self.config, samples=1)
        guard = self.guard(config)
        guard.run_once()
        self.assertEqual(self.system.signals, [(401, signal.SIGTERM), (401, signal.SIGKILL)])
        guard.run_once()
        self.assertEqual(len(self.system.signals), 2)
        snapshot = json.loads(guard.snapshot_path.read_text(encoding="utf-8"))
        self.assertTrue(snapshot["acted"])
        incident = self.incidents()[0]
        self.assertEqual(incident["kind"], "resource_pressure_termination")
        self.assertEqual(incident["status"], "open")
        self.assertEqual(incident["clanker"], {
            "clankerId": "id", "harness": "pi", "pane": "%1", "sessionName": "session",
            "worktreePath": "/worktree", "cwd": "/cwd",
        })
        self.assertTrue(incident["evidence"]["forced"])
        self.assertEqual(incident["evidence"]["reason"], "sustained_memory_pressure")
        self.assertIsInstance(incident["id"], str)
        self.assertGreater(incident["occurredAt"], 0)

        same_boot = self.guard(config)
        same_boot.run_once()
        self.assertEqual(len(self.system.signals), 2)

    def test_no_kill_when_process_exits_after_term(self):
        self.add_process(501, 51, "claude")
        self.system.dead_after_term = True
        self.tmux.listing = "%1\tclaude\tid\t501\t51\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("claude", "id", 501, 51, False)
        self.memory(available_kib=100_000, some=20)
        self.guard(replace(self.config, samples=1)).run_once()
        self.assertEqual(self.system.signals, [(501, signal.SIGTERM)])

    def test_dry_run_records_without_signalling_or_consuming_boot(self):
        self.add_process(601, 61, "opencode")
        self.tmux.listing = "%1\topencode\tid\t601\t61\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.memory(available_kib=100_000, some=20)
        guard = self.guard(replace(self.config, samples=1, dry_run=True))
        guard.run_once()
        self.assertEqual(self.system.signals, [])
        self.assertFalse(guard.snapshot["acted"])
        self.assertEqual(self.incidents(), [])
        self.assertEqual(guard.snapshot["dry_run_selected"]["clanker_id"], "id")

    def test_prior_unclean_boot_is_reconciled_and_shutdown_is_marked(self):
        self.config.state_dir.mkdir(parents=True)
        snapshot = self.config.state_dir / "resource-guard-snapshot.json"
        snapshot.write_text(json.dumps({
            "boot_id": "boot-old", "clean_shutdown": False, "acted": True,
            "clankers": [
                {"clanker_id": "working-id", "harness": "pi", "state": "working", "session_name": "work", "worktree_path": "/wt", "cwd": "/cwd"},
                {"clanker_id": "blocked-id", "harness": "claude", "state": "blocked", "session_name": "blocked", "worktree_path": "", "cwd": "/blocked"},
                {"clanker_id": "unknown-id", "harness": "opencode", "state": "unknown", "session_name": "unknown", "worktree_path": "", "cwd": "/unknown"},
                {"clanker_id": "done-id", "harness": "pi", "state": "done", "session_name": "done", "worktree_path": "", "cwd": "/done"},
                {"clanker_id": "idle-id", "harness": "pi", "state": "idle", "session_name": "idle", "worktree_path": "", "cwd": "/idle"},
            ],
        }), encoding="utf-8")
        guard = self.guard()
        incidents = self.incidents()
        self.assertEqual(len(incidents), 3)
        self.assertEqual({item["kind"] for item in incidents}, {"unclean_boot_clanker_loss"})
        self.assertEqual({item["clanker"]["clankerId"] for item in incidents}, {"working-id", "blocked-id", "unknown-id"})
        self.assertEqual({item["evidence"]["reason"] for item in incidents}, {"previous_boot_ended_unclean"})
        self.assertFalse(guard.snapshot["acted"])
        guard.clean_shutdown()
        self.assertTrue(json.loads(snapshot.read_text(encoding="utf-8"))["clean_shutdown"])

    def test_one_shot_marks_a_clean_shutdown(self):
        self.memory(available_kib=7 * 1024 * 1024, some=0)
        guard = self.guard()
        guard.run(once=True)
        snapshot = json.loads(guard.snapshot_path.read_text(encoding="utf-8"))
        self.assertTrue(snapshot["clean_shutdown"])


if __name__ == "__main__":
    unittest.main()
