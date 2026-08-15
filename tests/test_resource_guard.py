import json
import os
import pathlib
import signal
import sqlite3
import tempfile
import unittest
from dataclasses import replace

from resource_guard import Config, ResourceGuard, parse_meminfo, parse_psi


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
        self.root_reads = 0
        self.process_io = {}

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

    def open_process(self, pid, start_ticks):
        stat = self.stat(pid)
        return pid if stat and stat[1] == start_ticks else None

    def signal_process(self, handle, sig):
        self.kill(handle, sig)

    def close_process(self, _handle):
        pass

    def kill(self, pid, sig):
        self.signals.append((pid, sig))
        if sig == signal.SIGTERM and self.dead_after_term:
            self.stats.pop(pid, None)

    def alive(self, pid):
        return pid in self.stats

    def root_read_bytes(self):
        return self.root_reads

    def process_io_bytes(self, pid):
        return self.process_io.get(pid, 0)


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
        self.commands = []

    def tearDown(self):
        self.temporary.cleanup()

    def guard(self, config=None):
        return ResourceGuard(
            config or self.config,
            system=self.system,
            tmux=self.tmux,
            sleep=lambda _seconds: None,
            now=lambda: self.clock,
            run_command=lambda argv: self.commands.append(argv) or 0,
        )

    def memory(self, available_kib=400_000, total_kib=8 * 1024 * 1024, swap_kib=0, some=12, full=0, io_some=0, io_full=0, cpu_some=0):
        self.system.files[str(self.system.proc / "meminfo")] = (
            f"MemTotal:       {total_kib} kB\n"
            f"MemAvailable:   {available_kib} kB\n"
            f"SwapTotal:      {swap_kib} kB\n"
        )
        self.system.files[str(self.system.proc / "pressure/memory")] = (
            f"some avg10={some:.2f} avg60=1.00 avg300=1.00 total=1\n"
            f"full avg10={full:.2f} avg60=0.00 avg300=0.00 total=0\n"
        )
        self.system.files[str(self.system.proc / "pressure/io")] = (
            f"some avg10={io_some:.2f} avg60=1.00 avg300=1.00 total=1\n"
            f"full avg10={io_full:.2f} avg60=0.00 avg300=0.00 total=0\n"
        )
        self.system.files[str(self.system.proc / "pressure/cpu")] = (
            f"some avg10={cpu_some:.2f} avg60=0.00 avg300=0.00 total=0\n"
            "full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"
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

    def test_defaults_wait_five_minutes_and_cool_down_for_two_minutes(self):
        config = Config.from_env({"HOME": str(pathlib.Path(self.temporary.name) / "home")})
        self.assertEqual((config.samples - 1) * config.interval, 300)
        self.assertEqual(config.cooldown, 120)

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

    def test_pure_io_pressure_trips_with_healthy_memory_and_publishes_admission_block(self):
        self.memory(available_kib=7 * 1024 * 1024, some=0, io_some=20, io_full=2)
        guard = self.guard(replace(self.config, samples=1, dry_run=True))
        sample = guard.run_once()
        self.assertEqual(sample.io_psi_some, 20)
        self.assertEqual(guard.consecutive, 1)
        admission = json.loads((self.config.state_dir / "recovery-admission.json").read_text(encoding="utf-8"))
        self.assertIsNone(admission["healthySince"])
        self.assertEqual(admission["ioPsiFull"], 2)
        metrics = guard.metrics_path.read_text(encoding="utf-8")
        self.assertIn('clankerhouse_pressure_ratio{resource="io",scope="full"} 0.02', metrics)

    def test_root_read_throughput_preserves_an_ssh_reserve(self):
        self.memory(available_kib=7 * 1024 * 1024, some=0)
        guard = self.guard(replace(self.config, samples=1, dry_run=True))
        guard.run_once()
        self.clock += 1
        self.system.root_reads += 100 * 1024 * 1024
        sample = guard.run_once()
        self.assertEqual(sample.root_read_bytes_per_second, 100 * 1024 * 1024)
        self.assertEqual(guard.snapshot["pressure_kind"], "io")
        admission = json.loads(guard.admission_path.read_text(encoding="utf-8"))
        self.assertIsNone(admission["healthySince"])

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

    def test_mitigation_skips_a_lower_ranked_clanker_when_another_has_attributable_work(self):
        self.add_process(271, 27, "pi")
        self.add_process(281, 28, "pi")
        self.system.stats[282] = (281, 282)
        self.system.uids[282] = os.getuid()
        self.system.comms[282] = "worker"
        self.system.rss[282] = 512 * 1024 * 1024
        self.system.child_map[281] = [282]
        self.tmux.listing = "\n".join((
            "%1\tpi\tdone-id\t271\t27\t0\t1\t1\tdone\t/cwd1\t/wt1",
            "%2\tpi\tworking-id\t281\t28\t0\t1\t1\tworking\t/cwd2\t/wt2",
        ))
        self.tmux.identities["%1"] = ("pi", "done-id", 271, 27, False)
        self.tmux.identities["%2"] = ("pi", "working-id", 281, 28, False)
        self.report("%1", "pi", "done-id", "done")
        self.report("%2", "pi", "working-id", "working")
        self.memory(available_kib=100_000, some=20)

        self.guard(replace(self.config, samples=1)).run_once()

        self.assertEqual(self.system.signals, [(282, signal.SIGTERM), (282, signal.SIGKILL)])

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

    def test_pressure_stops_a_heavy_child_workload_without_signalling_the_clanker(self):
        self.add_process(401, 41, "pi")
        self.system.stats[402] = (401, 200)
        self.system.uids[402] = os.getuid()
        self.system.commands[402] = ["/usr/bin/cargo", "test"]
        self.system.comms[402] = "cargo"
        self.system.rss[402] = 512 * 1024 * 1024
        self.system.child_map[401] = [402]
        self.tmux.listing = "%1\tpi\tid\t401\t41\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("pi", "id", 401, 41, False)
        self.report("%1", "pi", "id", "working")
        self.memory(available_kib=100_000, some=20)

        guard = self.guard(replace(self.config, samples=1))
        guard.run_once()

        self.assertEqual(self.system.signals, [(402, signal.SIGTERM), (402, signal.SIGKILL)])
        self.assertNotIn((401, signal.SIGTERM), self.system.signals)
        incident = self.incidents()[0]
        self.assertEqual(incident["kind"], "resource_pressure_workload_stop")
        self.assertEqual(incident["clanker"]["clankerId"], "id")
        self.assertEqual(incident["evidence"]["process"]["pid"], 402)
        self.assertEqual(incident["evidence"]["process"]["command"], "cargo")

    def test_stops_the_entire_validated_workload_subtree(self):
        self.add_process(461, 46, "pi")
        self.system.stats[462] = (461, 262)
        self.system.stats[463] = (462, 263)
        self.system.uids.update({462: os.getuid(), 463: os.getuid()})
        self.system.comms[462] = "bash"
        self.system.rss[463] = 512 * 1024 * 1024
        self.system.child_map[461] = [462]
        self.system.child_map[462] = [463]
        self.tmux.listing = "%6\tpi\tclanker-6\t461\t46\t0\t1\t1\ts6\t/cwd6\t/wt6"
        self.tmux.identities["%6"] = ("pi", "clanker-6", 461, 46, False)
        self.memory(available_kib=100_000, some=20)

        self.guard(replace(self.config, samples=1)).run_once()

        self.assertEqual(self.system.signals, [
            (463, signal.SIGTERM), (462, signal.SIGTERM),
            (463, signal.SIGKILL), (462, signal.SIGKILL),
        ])
        self.assertFalse(any(pid == 461 for pid, _signal in self.system.signals))

    def test_stopped_workload_is_followed_by_a_steering_message(self):
        self.add_process(411, 41, "pi")
        self.system.stats[412] = (411, 201)
        self.system.uids[412] = os.getuid()
        self.system.commands[412] = ["/usr/bin/cargo", "test", "--token=secret"]
        self.system.comms[412] = "cargo"
        self.system.rss[412] = 512 * 1024 * 1024
        self.system.child_map[411] = [412]
        self.tmux.listing = "%1\tpi\tclanker-1\t411\t41\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("pi", "clanker-1", 411, 41, False)
        self.memory(available_kib=100_000, some=20)

        self.guard(replace(self.config, samples=1)).run_once()

        self.assertEqual(self.commands[0][:5], ["clankers", "send", "clanker-1", "--delivery", "steer"])
        message = self.commands[0][self.commands[0].index("--text") + 1]
        self.assertIn("Resource Guard stopped child process cargo", message)
        self.assertIn("sustained memory pressure", message)
        self.assertIn("Incident:", message)
        self.assertNotIn("secret", message)
        self.assertEqual(self.incidents()[0]["evidence"]["steering"], {"attempted": True, "delivered": True})

    def test_io_pressure_targets_the_workload_with_attributed_io(self):
        self.add_process(421, 42, "pi")
        self.system.stats[422] = (421, 202)
        self.system.uids[422] = os.getuid()
        self.system.comms[422] = "rg"
        self.system.child_map[421] = [422]
        self.system.process_io[422] = 0
        self.tmux.listing = "%2\tpi\tclanker-2\t421\t42\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%2"] = ("pi", "clanker-2", 421, 42, False)
        self.memory(available_kib=7 * 1024 * 1024, some=0)
        guard = self.guard(replace(self.config, samples=1))
        guard.run_once()

        self.clock += 1
        self.system.root_reads += 100 * 1024 * 1024
        self.system.process_io[422] += 80 * 1024 * 1024
        guard.run_once()

        self.assertEqual(self.system.signals, [(422, signal.SIGTERM), (422, signal.SIGKILL)])
        self.assertIn("sustained I/O pressure", self.commands[0][-1])

    def test_one_workload_is_stopped_per_episode_then_pressure_is_resampled_after_cooldown(self):
        for harness_pid, pane_pid, child_pid, pane, clanker_id in (
            (431, 43, 432, "%3", "clanker-3"),
            (441, 44, 442, "%4", "clanker-4"),
        ):
            self.add_process(harness_pid, pane_pid, "pi")
            self.system.stats[child_pid] = (harness_pid, child_pid)
            self.system.uids[child_pid] = os.getuid()
            self.system.comms[child_pid] = "worker"
            self.system.rss[child_pid] = 512 * 1024 * 1024
            self.system.child_map[harness_pid] = [child_pid]
            self.tmux.identities[pane] = ("pi", clanker_id, harness_pid, pane_pid, False)
        self.tmux.listing = "\n".join((
            "%3\tpi\tclanker-3\t431\t43\t0\t1\t1\ts3\t/cwd3\t/wt3",
            "%4\tpi\tclanker-4\t441\t44\t0\t1\t1\ts4\t/cwd4\t/wt4",
        ))
        self.memory(available_kib=100_000, some=20)
        guard = self.guard(replace(self.config, samples=2, cooldown=120))

        guard.run_once()
        self.clock += 5
        guard.run_once()
        self.assertEqual(len(self.system.signals), 2)
        self.clock += 119
        guard.run_once()
        self.assertEqual(len(self.system.signals), 2)
        self.clock += 1
        guard.run_once()
        self.assertEqual(len(self.system.signals), 2)
        self.clock += 5
        guard.run_once()
        self.assertEqual(len(self.system.signals), 4)

    def test_same_boot_restart_preserves_the_post_action_cooldown(self):
        self.add_process(471, 47, "pi")
        self.system.stats[472] = (471, 272)
        self.system.uids[472] = os.getuid()
        self.system.comms[472] = "worker"
        self.system.rss[472] = 512 * 1024 * 1024
        self.system.child_map[471] = [472]
        self.tmux.listing = "%8\tpi\tclanker-8\t471\t47\t0\t1\t1\ts8\t/cwd8\t/wt8"
        self.tmux.identities["%8"] = ("pi", "clanker-8", 471, 47, False)
        self.memory(available_kib=100_000, some=20)
        config = replace(self.config, samples=1, cooldown=120)
        self.guard(config).run_once()
        self.assertEqual(len(self.system.signals), 2)

        self.clock += 10
        restarted = self.guard(config)
        restarted.run_once()

        self.assertEqual(len(self.system.signals), 2)
        self.assertTrue(restarted.snapshot["cooling_down"])

    def test_pressure_durably_stops_a_tracked_clanker_when_no_workload_is_attributable(self):
        self.add_process(451, 45, "pi")
        self.tmux.listing = "%5\tpi\tclanker-5\t451\t45\t0\t1\t1\ts5\t/cwd5\t/wt5"
        self.tmux.identities["%5"] = ("pi", "clanker-5", 451, 45, False)
        self.config.state_dir.mkdir(parents=True)
        with sqlite3.connect(self.config.state_dir / "recovery.sqlite3") as connection:
            connection.execute("CREATE TABLE desired_clankers (clanker_id TEXT PRIMARY KEY, desired_state TEXT NOT NULL, owner_unit TEXT)")
            connection.execute("INSERT INTO desired_clankers VALUES ('clanker-5', 'running', 'clankerhouse-clanker-5.scope')")
        self.memory(available_kib=100_000, some=20)

        self.guard(replace(self.config, samples=1)).run_once()

        self.assertEqual(self.system.signals, [])
        self.assertEqual(self.commands, [[
            "clankers", "recovery", "stop", "clanker-5", "--reason", "resource-pressure", "--no-pane-kill", "--if-present",
        ]])
        self.assertEqual(self.incidents()[0]["kind"], "resource_pressure_clanker_stop")

    def test_no_kill_when_child_workload_exits_after_term(self):
        self.add_process(501, 51, "claude")
        self.system.stats[502] = (501, 250)
        self.system.uids[502] = os.getuid()
        self.system.comms[502] = "worker"
        self.system.rss[502] = 512 * 1024 * 1024
        self.system.child_map[501] = [502]
        self.system.dead_after_term = True
        self.tmux.listing = "%1\tclaude\tid\t501\t51\t0\t1\t1\tsession\t/cwd\t/worktree"
        self.tmux.identities["%1"] = ("claude", "id", 501, 51, False)
        self.memory(available_kib=100_000, some=20)
        self.guard(replace(self.config, samples=1)).run_once()
        self.assertEqual(self.system.signals, [(502, signal.SIGTERM)])

    def test_untracked_clanker_without_an_attributable_workload_is_not_signalled(self):
        self.add_process(551, 55, "pi")
        self.tmux.listing = "%7\tpi\tuntracked\t551\t55\t0\t1\t1\ts7\t/cwd7\t/wt7"
        self.tmux.identities["%7"] = ("pi", "untracked", 551, 55, False)
        self.memory(available_kib=100_000, some=20)

        guard = self.guard(replace(self.config, samples=1))
        guard.run_once()

        self.assertEqual(self.system.signals, [])
        self.assertEqual(self.commands, [])
        self.assertEqual(self.incidents(), [])
        self.assertEqual(guard.snapshot["mitigation_skipped"], "no_attributable_workload_or_stoppable_clanker")

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
