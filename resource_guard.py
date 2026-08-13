#!/usr/bin/env python3
"""Conservative Linux memory-pressure guard for tagged tmux clankers.

The guard deliberately has no third-party dependencies.  It only considers panes
which explicitly advertise @dotfiles_harness=pi|claude|opencode|codex, and revalidates a
process immediately before each signal.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import pathlib
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable, Mapping
from typing import Any

MIB = 1024 * 1024
HARNESSES = frozenset(("pi", "claude", "opencode", "codex"))
STATE_RANK = {"done": 0, "idle": 0, "unknown": 1, "blocked": 2, "working": 3}


def _env_int(env: Mapping[str, str], name: str, default: int, minimum: int = 0) -> int:
    try:
        return max(minimum, int(env.get(name, str(default))))
    except ValueError:
        return default


def _env_float(env: Mapping[str, str], name: str, default: float, minimum: float = 0.0) -> float:
    try:
        return max(minimum, float(env.get(name, str(default))))
    except ValueError:
        return default


def _env_bool(env: Mapping[str, str], name: str, default: bool = False) -> bool:
    value = env.get(name)
    return default if value is None else value.lower() in ("1", "true", "yes", "on")


@dataclasses.dataclass(frozen=True)
class Config:
    samples: int = 12
    interval: float = 5.0
    ec2_floor_bytes: int = 512 * MIB
    ec2_percent: float = 10.0
    generic_percent: float = 7.5
    psi_some: float = 10.0
    psi_full: float = 2.0
    term_grace: float = 5.0
    dry_run: bool = False
    state_home: pathlib.Path = pathlib.Path.home() / ".local/state"
    runtime_dir: pathlib.Path = pathlib.Path("/tmp")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        home = pathlib.Path(env.get("HOME", str(pathlib.Path.home())))
        return cls(
            samples=_env_int(env, "RESOURCE_GUARD_SAMPLES", 12, 1),
            interval=_env_float(env, "RESOURCE_GUARD_INTERVAL", 5.0),
            ec2_floor_bytes=_env_int(env, "RESOURCE_GUARD_EC2_FLOOR_MIB", 512) * MIB,
            ec2_percent=_env_float(env, "RESOURCE_GUARD_EC2_PERCENT", 10.0),
            generic_percent=_env_float(env, "RESOURCE_GUARD_GENERIC_PERCENT", 7.5),
            psi_some=_env_float(env, "RESOURCE_GUARD_PSI_SOME", 10.0),
            psi_full=_env_float(env, "RESOURCE_GUARD_PSI_FULL", 2.0),
            term_grace=_env_float(env, "RESOURCE_GUARD_TERM_GRACE", 5.0),
            dry_run=_env_bool(env, "RESOURCE_GUARD_DRY_RUN"),
            state_home=pathlib.Path(env.get("XDG_STATE_HOME", str(home / ".local/state"))),
            runtime_dir=pathlib.Path(env.get("XDG_RUNTIME_DIR", "/tmp")),
        )

    @property
    def state_dir(self) -> pathlib.Path:
        return self.state_home / "clankerhouse"


@dataclasses.dataclass(frozen=True)
class MemorySample:
    total_bytes: int
    available_bytes: int
    swap_total_bytes: int
    psi_some: float
    psi_full: float
    threshold_bytes: int
    ec2_swapless: bool


@dataclasses.dataclass(frozen=True)
class Candidate:
    pane: str
    harness: str
    clanker_id: str
    pid: int
    pane_pid: int
    start_ticks: int
    state: str = "unknown"
    focused: bool = False
    session_name: str = ""
    cwd: str = ""
    worktree_path: str = ""
    rss_bytes: int = 0
    report_updated_at: int = 0

    def incident_clanker(self) -> dict[str, str]:
        return {
            "clankerId": self.clanker_id,
            "harness": self.harness,
            "pane": self.pane,
            "sessionName": self.session_name,
            "worktreePath": self.worktree_path,
            "cwd": self.cwd,
        }


class LinuxSystem:
    """Small OS boundary, intentionally replaceable by unit tests."""

    def __init__(self, proc: pathlib.Path = pathlib.Path("/proc"), sysfs: pathlib.Path = pathlib.Path("/sys")) -> None:
        self.proc = proc
        self.sysfs = sysfs

    def read_text(self, path: pathlib.Path) -> str:
        return path.read_text(encoding="utf-8")

    def boot_id(self) -> str:
        return self.read_text(self.proc / "sys/kernel/random/boot_id").strip()

    def uid(self, pid: int) -> int | None:
        try:
            for line in self.read_text(self.proc / str(pid) / "status").splitlines():
                if line.startswith("Uid:"):
                    return int(line.split()[1])
        except (OSError, ValueError, IndexError):
            pass
        return None

    def stat(self, pid: int) -> tuple[int, int] | None:
        """Return (parent pid, start ticks), handling spaces in comm."""
        try:
            text = self.read_text(self.proc / str(pid) / "stat")
            fields = text[text.rfind(")") + 2 :].split()
            return int(fields[1]), int(fields[19])
        except (OSError, ValueError, IndexError):
            return None

    def cmdline(self, pid: int) -> list[str]:
        try:
            data = (self.proc / str(pid) / "cmdline").read_bytes()
            return [part.decode(errors="replace") for part in data.split(b"\0") if part]
        except OSError:
            return []

    def comm(self, pid: int) -> str:
        try:
            return self.read_text(self.proc / str(pid) / "comm").strip()
        except OSError:
            return ""

    def rss_bytes(self, pid: int) -> int:
        try:
            for line in self.read_text(self.proc / str(pid) / "status").splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            pass
        return 0

    def children(self, parent: int) -> list[int]:
        result: list[int] = []
        try:
            entries = list(self.proc.iterdir())
        except OSError:
            return result
        for entry in entries:
            if entry.name.isdigit():
                value = self.stat(int(entry.name))
                if value and value[0] == parent:
                    result.append(int(entry.name))
        return result

    def kill(self, pid: int, sig: int) -> None:
        os.kill(pid, sig)

    def alive(self, pid: int) -> bool:
        return self.stat(pid) is not None


class TmuxClient:
    FORMAT = "\t".join((
        "#{pane_id}", "#{@dotfiles_harness}", "#{@clankerhouse_clanker_id}",
        "#{@clankerhouse_clanker_pid}", "#{pane_pid}", "#{pane_active}",
        "#{window_active}", "#{session_attached}", "#{session_name}", "#{pane_current_path}",
        "#{@dotfiles_worktree_path}",
    ))

    def list_panes(self) -> str:
        result = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", self.FORMAT],
            check=False, capture_output=True, text=True,
        )
        return result.stdout if result.returncode == 0 else ""

    def pane_identity(self, pane: str) -> tuple[str, str, int, int, bool] | None:
        fmt = "\t".join(("#{@dotfiles_harness}", "#{@clankerhouse_clanker_id}", "#{@clankerhouse_clanker_pid}", "#{pane_pid}", "#{pane_active}", "#{window_active}", "#{session_attached}"))
        result = subprocess.run(
            ["tmux", "display-message", "-p", "-t", pane, fmt],
            check=False, capture_output=True, text=True,
        )
        if result.returncode != 0:
            return None
        parts = result.stdout.strip().split("\t")
        if len(parts) != 7:
            return None
        try:
            focused = parts[4] == "1" and parts[5] == "1" and parts[6] not in ("", "0")
            return parts[0], parts[1], int(parts[2] or 0), int(parts[3]), focused
        except ValueError:
            return None


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^(MemTotal|MemAvailable|SwapTotal):\s+(\d+)\s+kB$", line)
        if match:
            values[match.group(1)] = int(match.group(2)) * 1024
    missing = {"MemTotal", "MemAvailable", "SwapTotal"} - values.keys()
    if missing:
        raise ValueError(f"missing meminfo fields: {', '.join(sorted(missing))}")
    return values


def parse_psi(text: str) -> tuple[float, float]:
    values: dict[str, float] = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] in ("some", "full"):
            for field in fields[1:]:
                if field.startswith("avg10="):
                    values[fields[0]] = float(field.partition("=")[2])
    if "some" not in values or "full" not in values:
        raise ValueError("memory PSI does not contain some/full avg10")
    return values["some"], values["full"]


def _harness_identity(system: LinuxSystem, pid: int, harness: str) -> bool:
    names = {pathlib.Path(value).name for value in system.cmdline(pid)}
    return harness in names or system.comm(pid) == harness


def _is_descendant(system: LinuxSystem, pid: int, ancestor: int) -> bool:
    seen: set[int] = set()
    while pid > 1 and pid not in seen:
        if pid == ancestor:
            return True
        seen.add(pid)
        stat = system.stat(pid)
        if not stat:
            return False
        pid = stat[0]
    return False


def _find_harness_descendant(system: LinuxSystem, pane_pid: int, harness: str) -> int | None:
    queue = [pane_pid]
    seen: set[int] = set()
    while queue:
        pid = queue.pop(0)
        if pid in seen:
            continue
        seen.add(pid)
        if pid != pane_pid and _harness_identity(system, pid, harness):
            return pid
        queue.extend(system.children(pid))
    return None


class ResourceGuard:
    def __init__(
        self,
        config: Config | None = None,
        *,
        system: LinuxSystem | None = None,
        tmux: TmuxClient | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.config = config or Config.from_env()
        self.system = system or LinuxSystem()
        self.tmux = tmux or TmuxClient()
        self.sleep = sleep
        self.now = now
        self.boot_id = self.system.boot_id()
        self.snapshot_path = self.config.state_dir / "resource-guard-snapshot.json"
        self.incident_dir = self.config.state_dir / "incidents"
        self.snapshot: dict[str, Any] = {}
        self.consecutive = 0
        self.stop_requested = False
        self._initialize_state()

    def _mkdirs(self) -> None:
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.config.state_dir, 0o700)
        self.incident_dir.mkdir(exist_ok=True, mode=0o700)
        os.chmod(self.incident_dir, 0o700)

    def _read_snapshot(self) -> dict[str, Any]:
        try:
            value = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _initialize_state(self) -> None:
        self._mkdirs()
        previous = self._read_snapshot()
        if previous and previous.get("boot_id") != self.boot_id and not previous.get("clean_shutdown", False):
            for clanker in previous.get("clankers", []):
                harness = clanker.get("harness") if isinstance(clanker, dict) else None
                clanker_id = clanker.get("clanker_id") if isinstance(clanker, dict) else None
                if (
                    not isinstance(clanker, dict)
                    or clanker.get("state") not in ("working", "blocked", "unknown")
                    or harness not in HARNESSES
                    or not clanker_id
                ):
                    continue
                incident_id = uuid.uuid5(uuid.NAMESPACE_URL, f"{previous.get('boot_id')}:{self.boot_id}:{clanker_id}:unclean_boot_clanker_loss").hex
                self._incident(
                    "unclean_boot_clanker_loss",
                    {
                        "clankerId": str(clanker_id),
                        "harness": str(harness),
                        "sessionName": str(clanker.get("session_name", "")),
                        "worktreePath": str(clanker.get("worktree_path", "")),
                        "cwd": str(clanker.get("cwd", "")),
                    },
                    {
                        "reason": "previous_boot_ended_unclean",
                        "previousBootId": previous.get("boot_id"),
                    },
                    incident_id=incident_id,
                )
        acted = bool(previous.get("acted")) if previous.get("boot_id") == self.boot_id else False
        self.snapshot = {
            "version": 1,
            "boot_id": self.boot_id,
            "clean_shutdown": False,
            "acted": acted,
            "started_at": self.now(),
            "consecutive_pressure": 0,
        }
        self._write_snapshot()

    @staticmethod
    def _fsync_dir(path: pathlib.Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _write_snapshot(self) -> None:
        self._mkdirs()
        fd, temporary = tempfile.mkstemp(prefix=".resource-guard-", dir=self.config.state_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(self.snapshot, stream, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.snapshot_path)
            self._fsync_dir(self.config.state_dir)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _incident(
        self,
        kind: str,
        clanker: Mapping[str, Any],
        evidence: Mapping[str, Any],
        *,
        incident_id: str | None = None,
    ) -> pathlib.Path:
        self._mkdirs()
        incident_id = incident_id or uuid.uuid4().hex
        stamp = dt.datetime.fromtimestamp(self.now(), dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        path = self.incident_dir / f"{stamp}-{kind}-{incident_id}.json"
        existing = next(self.incident_dir.glob(f"*-{kind}-{incident_id}.json"), None)
        if existing:
            return existing
        payload = {
            "version": 1,
            "status": "open",
            "kind": kind,
            "id": incident_id,
            "occurredAt": int(self.now() * 1000),
            "clanker": dict(clanker),
            "evidence": dict(evidence),
        }
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        self._fsync_dir(self.incident_dir)
        return path

    def is_ec2(self) -> bool:
        fields = []
        for relative in ("class/dmi/id/sys_vendor", "class/dmi/id/product_name"):
            try:
                fields.append(self.system.read_text(self.system.sysfs / relative).lower())
            except OSError:
                pass
        return any("amazon" in value or "ec2" in value for value in fields)

    def sample(self) -> MemorySample:
        memory = parse_meminfo(self.system.read_text(self.system.proc / "meminfo"))
        some, full = parse_psi(self.system.read_text(self.system.proc / "pressure/memory"))
        ec2_swapless = memory["SwapTotal"] == 0 and self.is_ec2()
        if ec2_swapless:
            threshold = max(self.config.ec2_floor_bytes, int(memory["MemTotal"] * self.config.ec2_percent / 100.0))
        else:
            threshold = int(memory["MemTotal"] * self.config.generic_percent / 100.0)
        return MemorySample(memory["MemTotal"], memory["MemAvailable"], memory["SwapTotal"], some, full, threshold, ec2_swapless)

    def _report_state(self, pane: str, harness: str, clanker_id: str) -> tuple[str, int]:
        safe = re.sub(r"[^A-Za-z0-9_.%-]", "_", pane)
        root = self.config.runtime_dir / f"clankerhouse-{os.getuid()}"
        path = root / "clanker-state" / f"{safe}.json"
        try:
            report = json.loads(path.read_text(encoding="utf-8"))
            if report.get("pane") != pane or report.get("harness") != harness:
                return "unknown", 0
            if clanker_id and report.get("clankerId") not in (None, clanker_id):
                return "unknown", 0
            state = str(report.get("state", "unknown"))
            return state if state in STATE_RANK else "unknown", int(report.get("updatedAt", 0) or 0)
        except (OSError, ValueError, TypeError, AttributeError):
            return "unknown", 0

    def discover(self) -> list[Candidate]:
        candidates: list[Candidate] = []
        uid = os.getuid()
        for line in self.tmux.list_panes().splitlines():
            parts = line.split("\t")
            if len(parts) != 11:
                continue
            pane, harness, clanker_id, tagged_pid_text, pane_pid_text, active, window_active, attached, session_name, cwd, worktree_path = parts
            if harness not in HARNESSES or not clanker_id or not pane.startswith("%"):
                continue
            try:
                pane_pid = int(pane_pid_text)
                tagged_pid = int(tagged_pid_text or 0)
            except ValueError:
                continue
            focused = active == "1" and window_active == "1" and attached not in ("", "0")
            pid = tagged_pid if tagged_pid > 0 else _find_harness_descendant(self.system, pane_pid, harness)
            if pid is None or self.system.uid(pid) != uid or not _is_descendant(self.system, pid, pane_pid) or not _harness_identity(self.system, pid, harness):
                continue
            stat = self.system.stat(pid)
            if not stat:
                continue
            state, report_updated_at = self._report_state(pane, harness, clanker_id)
            process_tree = [pid]
            for process in process_tree:
                process_tree.extend(child for child in self.system.children(process) if child not in process_tree)
            rss_bytes = sum(self.system.rss_bytes(process) for process in process_tree)
            candidates.append(Candidate(
                pane, harness, clanker_id, pid, pane_pid, stat[1],
                state, focused, session_name, cwd, worktree_path, rss_bytes, report_updated_at,
            ))
        duplicate_ids = {candidate.clanker_id for candidate in candidates if sum(other.clanker_id == candidate.clanker_id for other in candidates) > 1}
        return [candidate for candidate in candidates if candidate.clanker_id not in duplicate_ids]

    def validate(self, candidate: Candidate) -> bool:
        identity = self.tmux.pane_identity(candidate.pane)
        if identity is None:
            return False
        harness, clanker_id, tagged_pid, pane_pid, focused = identity
        stat = self.system.stat(candidate.pid)
        return (
            harness == candidate.harness
            and clanker_id == candidate.clanker_id
            and harness in HARNESSES
            and pane_pid == candidate.pane_pid
            and not focused
            and tagged_pid in (0, candidate.pid)
            and stat is not None
            and stat[1] == candidate.start_ticks
            and self.system.uid(candidate.pid) == os.getuid()
            and _is_descendant(self.system, candidate.pid, pane_pid)
            and _harness_identity(self.system, candidate.pid, harness)
        )

    def select(self, candidates: list[Candidate]) -> Candidate | None:
        eligible = [candidate for candidate in candidates if not candidate.focused]
        return min(eligible, key=lambda value: (STATE_RANK[value.state], -value.rss_bytes, value.report_updated_at, value.pane)) if eligible else None

    def _suspend_recovery(self, candidate: Candidate) -> bool:
        database = self.config.state_dir / "recovery.sqlite3"
        if not database.exists():
            return True
        try:
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                row = connection.execute(
                    "SELECT desired_state FROM desired_clankers WHERE clanker_id = ?",
                    (candidate.clanker_id,),
                ).fetchone()
        except (OSError, sqlite3.Error):
            return False
        if row is None or row[0] == "suspended_resource_pressure":
            return True
        if row[0] != "running":
            return True
        cli = os.environ.get("CLANKERHOUSE_CLANKERS", "clankers")
        result = subprocess.run(
            [cli, "recovery", "suspend", candidate.clanker_id, "--reason", "resource-pressure", "--no-kill"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0

    def mitigate(self, sample: MemorySample, candidates: list[Candidate] | None = None) -> Candidate | None:
        if self.snapshot.get("acted"):
            return None
        candidates = self.discover() if candidates is None else candidates
        selected = self.select(candidates)
        if selected is None:
            self.snapshot["mitigation_skipped"] = "no_non_focused_candidate"
            self._write_snapshot()
            return None
        if self.config.dry_run:
            self.snapshot["dry_run_selected"] = dataclasses.asdict(selected)
            self._write_snapshot()
            print(json.dumps({"event": "dry_run_selection", "clankerId": selected.clanker_id, "pane": selected.pane}), flush=True)
            return selected
        if not self.validate(selected):
            self.snapshot["mitigation_skipped"] = "candidate_validation_failed"
            self._write_snapshot()
            return None
        if not self._suspend_recovery(selected):
            self.snapshot["mitigation_skipped"] = "recovery_suspension_failed"
            self._write_snapshot()
            return None
        self.snapshot["acted"] = True
        self.snapshot["selected"] = dataclasses.asdict(selected)
        self._write_snapshot()
        try:
            self.system.kill(selected.pid, signal.SIGTERM)
        except OSError:
            self.snapshot["acted"] = False
            self.snapshot["mitigation_skipped"] = "candidate_disappeared_before_signal"
            self._write_snapshot()
            return None
        action = "term"
        if self.config.term_grace:
            self.sleep(self.config.term_grace)
        if self.system.alive(selected.pid) and self.validate(selected):
            self.system.kill(selected.pid, signal.SIGKILL)
            action = "term_kill"
        incident = self._incident(
            "resource_pressure_termination",
            selected.incident_clanker(),
            {
                "reason": "sustained_memory_pressure",
                "forced": action == "term_kill",
            },
        )
        print(json.dumps({"event": "resource_pressure_termination", "clankerId": selected.clanker_id, "pane": selected.pane, "forced": action == "term_kill", "incident": str(incident)}), flush=True)
        return selected

    def run_once(self) -> MemorySample:
        sample = self.sample()
        pressured = sample.available_bytes <= sample.threshold_bytes and (
            sample.psi_some >= self.config.psi_some or sample.psi_full >= self.config.psi_full
        )
        self.consecutive = self.consecutive + 1 if pressured else 0
        candidates = self.discover()
        self.snapshot.update({
            "clean_shutdown": False,
            "sampled_at": self.now(),
            "sample": dataclasses.asdict(sample),
            "consecutive_pressure": self.consecutive,
            "clankers": [{
                "pane": candidate.pane,
                "harness": candidate.harness,
                "clanker_id": candidate.clanker_id,
                "pid": candidate.pid,
                "pane_pid": candidate.pane_pid,
                "start_ticks": candidate.start_ticks,
                "state": candidate.state,
                "focused": candidate.focused,
                "session_name": candidate.session_name,
                "cwd": candidate.cwd,
                "worktree_path": candidate.worktree_path,
                "rss_bytes": candidate.rss_bytes,
                "report_updated_at": candidate.report_updated_at,
            } for candidate in candidates],
        })
        self._write_snapshot()
        if self.consecutive >= self.config.samples and not self.snapshot.get("acted"):
            self.mitigate(sample, candidates)
        return sample

    def clean_shutdown(self) -> None:
        self.stop_requested = True
        self.snapshot["clean_shutdown"] = True
        self.snapshot["stopped_at"] = self.now()
        self._write_snapshot()

    def run(self, *, once: bool = False) -> None:
        old_handlers: dict[int, Any] = {}

        def request_stop(_signum: int, _frame: Any) -> None:
            self.stop_requested = True

        if not once:
            for sig in (signal.SIGINT, signal.SIGTERM):
                old_handlers[sig] = signal.signal(sig, request_stop)
        try:
            while not self.stop_requested:
                self.run_once()
                if once:
                    break
                self.sleep(self.config.interval)
        finally:
            self.clean_shutdown()
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="take one sample, then exit cleanly")
    parser.add_argument("--dry-run", action="store_true", help="record selection but never signal a process")
    args = parser.parse_args(argv)
    config = Config.from_env()
    if args.dry_run:
        config = dataclasses.replace(config, dry_run=True)
    ResourceGuard(config).run(once=args.once)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
