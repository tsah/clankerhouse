#!/usr/bin/env python3
"""Conservative Linux resource-pressure guard for tagged Clankers.

The guard deliberately has no third-party dependencies. It stops only attributable
child workload trees, or durably stops an owned Recovery Clanker as a fallback.
It only considers panes
whose harness claim is pi|claude|opencode|codex, and revalidates a
process immediately before each signal.
"""

from __future__ import annotations

import argparse
import ctypes
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
    samples: int = 61
    interval: float = 5.0
    ec2_floor_bytes: int = 512 * MIB
    ec2_percent: float = 10.0
    generic_percent: float = 7.5
    psi_some: float = 10.0
    psi_full: float = 2.0
    io_psi_some: float = 10.0
    io_psi_full: float = 1.0
    cpu_psi_some: float = 25.0
    read_limit_bytes_per_second: int = 125 * MIB
    term_grace: float = 5.0
    cooldown: float = 120.0
    workload_min_rss_bytes: int = 128 * MIB
    workload_min_io_bytes_per_second: int = 10 * MIB
    dry_run: bool = False
    state_home: pathlib.Path = pathlib.Path.home() / ".local/state"
    runtime_dir: pathlib.Path = pathlib.Path("/tmp")
    instance_suffix: str = "-herdr"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        home = pathlib.Path(env.get("HOME", str(pathlib.Path.home())))
        instance = env.get("CLANKERHOUSE_INSTANCE", "").strip()
        if instance and (instance in (".", "..") or re.fullmatch(r"[A-Za-z0-9._-]+", instance) is None):
            raise ValueError(f"invalid CLANKERHOUSE_INSTANCE: {instance}")
        instance_suffix = ("" if instance == "default" else f"-{instance}") if instance else "-herdr"
        return cls(
            samples=_env_int(env, "RESOURCE_GUARD_SAMPLES", 61, 1),
            interval=_env_float(env, "RESOURCE_GUARD_INTERVAL", 5.0),
            ec2_floor_bytes=_env_int(env, "RESOURCE_GUARD_EC2_FLOOR_MIB", 512) * MIB,
            ec2_percent=_env_float(env, "RESOURCE_GUARD_EC2_PERCENT", 10.0),
            generic_percent=_env_float(env, "RESOURCE_GUARD_GENERIC_PERCENT", 7.5),
            psi_some=_env_float(env, "RESOURCE_GUARD_PSI_SOME", 10.0),
            psi_full=_env_float(env, "RESOURCE_GUARD_PSI_FULL", 2.0),
            io_psi_some=_env_float(env, "RESOURCE_GUARD_IO_PSI_SOME", 10.0),
            io_psi_full=_env_float(env, "RESOURCE_GUARD_IO_PSI_FULL", 1.0),
            cpu_psi_some=_env_float(env, "RESOURCE_GUARD_CPU_PSI_SOME", 25.0),
            read_limit_bytes_per_second=_env_int(env, "RESOURCE_GUARD_READ_LIMIT_MIB_PER_SEC", 125) * MIB,
            term_grace=_env_float(env, "RESOURCE_GUARD_TERM_GRACE", 5.0),
            cooldown=_env_float(env, "RESOURCE_GUARD_COOLDOWN", 120.0),
            workload_min_rss_bytes=_env_int(env, "RESOURCE_GUARD_WORKLOAD_MIN_RSS_MIB", 128) * MIB,
            workload_min_io_bytes_per_second=_env_int(env, "RESOURCE_GUARD_WORKLOAD_MIN_IO_MIB_PER_SEC", 10) * MIB,
            dry_run=_env_bool(env, "RESOURCE_GUARD_DRY_RUN"),
            state_home=pathlib.Path(env.get("XDG_STATE_HOME", str(home / ".local/state"))),
            runtime_dir=pathlib.Path(env.get("XDG_RUNTIME_DIR", "/tmp")),
            instance_suffix=instance_suffix,
        )

    @property
    def state_dir(self) -> pathlib.Path:
        return self.state_home / f"clankerhouse{self.instance_suffix}"

    @property
    def runtime_root(self) -> pathlib.Path:
        return self.runtime_dir / f"clankerhouse-{os.getuid()}{self.instance_suffix}"


@dataclasses.dataclass(frozen=True)
class MemorySample:
    total_bytes: int
    available_bytes: int
    swap_total_bytes: int
    psi_some: float
    psi_full: float
    threshold_bytes: int
    ec2_swapless: bool
    io_psi_some: float = 0.0
    io_psi_full: float = 0.0
    cpu_psi_some: float = 0.0
    root_read_bytes_per_second: float = 0.0


@dataclasses.dataclass(frozen=True)
class Workload:
    pid: int
    start_ticks: int
    command: str
    rss_bytes: int
    io_bytes_per_second: float = 0.0


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
    workloads: tuple[Workload, ...] = ()

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

    @staticmethod
    def _linux_syscall(number: int, *arguments: int) -> int:
        libc = ctypes.CDLL(None, use_errno=True)
        result = int(libc.syscall(number, *arguments))
        if result < 0:
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))
        return result

    def open_process(self, pid: int, start_ticks: int) -> int | None:
        try:
            descriptor = os.pidfd_open(pid) if hasattr(os, "pidfd_open") else self._linux_syscall(434, pid, 0)
        except OSError:
            return None
        stat = self.stat(pid)
        if stat is None or stat[1] != start_ticks or self.uid(pid) != os.getuid():
            os.close(descriptor)
            return None
        return descriptor

    def signal_process(self, descriptor: int, sig: int) -> None:
        if hasattr(signal, "pidfd_send_signal"):
            signal.pidfd_send_signal(descriptor, sig)
        else:
            self._linux_syscall(424, descriptor, sig, 0, 0)

    def close_process(self, descriptor: int) -> None:
        os.close(descriptor)

    def kill(self, pid: int, sig: int) -> None:
        os.kill(pid, sig)

    def alive(self, pid: int) -> bool:
        return self.stat(pid) is not None

    def process_io_bytes(self, pid: int) -> int:
        try:
            values = {}
            for line in self.read_text(self.proc / str(pid) / "io").splitlines():
                key, separator, value = line.partition(":")
                if separator and key in ("read_bytes", "write_bytes"):
                    values[key] = int(value.strip())
            return values.get("read_bytes", 0) + values.get("write_bytes", 0)
        except (OSError, ValueError):
            return 0

    def root_read_bytes(self) -> int:
        device = os.stat("/").st_dev
        wanted = (os.major(device), os.minor(device))
        for line in self.read_text(self.proc / "diskstats").splitlines():
            fields = line.split()
            if len(fields) >= 10 and (int(fields[0]), int(fields[1])) == wanted:
                return int(fields[5]) * 512
        return 0


class MultiplexerClient:
    """Pane discovery through `clankers mux observe`, emitted as tab-separated rows."""

    def __init__(self, cli: str | None = None) -> None:
        self.cli = cli or os.environ.get("CLANKERHOUSE_CLANKERS", "clankers")

    def _observe(self) -> dict:
        result = subprocess.run([self.cli, "mux", "observe"], check=False, capture_output=True, text=True)
        if result.returncode != 0 or not result.stdout.strip():
            return {"sessions": []}
        try:
            return json.loads(result.stdout)
        except ValueError:
            return {"sessions": []}

    @staticmethod
    def _rows(snapshot: dict):
        for session in snapshot.get("sessions", []):
            attached = "1" if session.get("attached") else "0"
            for window in session.get("windows", []):
                for pane in window.get("panes", []):
                    claims = pane.get("claims") or {}
                    yield (
                        str(pane.get("id", "")), str(claims.get("harness") or pane.get("harness") or ""), str(claims.get("clankerId") or pane.get("clankerId") or ""),
                        str(claims.get("clankerPid") or ""), str(pane.get("pid") or ""), "1" if pane.get("active") else "0",
                        "1" if window.get("active") else "0", attached, str(session.get("nativeName", "")), str(pane.get("currentPath", "")),
                        str(claims.get("worktreePath") or session.get("worktreePath") or ""),
                    )

    def list_panes(self) -> str:
        return "\n".join("\t".join(row) for row in self._rows(self._observe()))

    def pane_identity(self, pane: str) -> tuple[str, str, int, int, bool] | None:
        for row in self._rows(self._observe()):
            if row[0] != pane:
                continue
            try:
                focused = row[5] == "1" and row[6] == "1" and row[7] not in ("", "0")
                return row[1], row[2], int(row[3] or 0), int(row[4]), focused
            except ValueError:
                return None
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
        multiplexer: MultiplexerClient | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
        run_command: Callable[[list[str]], int] | None = None,
    ) -> None:
        self.config = config or Config.from_env()
        self.system = system or LinuxSystem(
            pathlib.Path(os.environ.get("CLANKERHOUSE_PROC_ROOT", "/proc")),
            pathlib.Path(os.environ.get("CLANKERHOUSE_SYSFS_ROOT", "/sys")),
        )
        self.multiplexer = multiplexer or MultiplexerClient()
        self.sleep = sleep
        self.now = now
        self.run_command = run_command or (lambda argv: subprocess.run(argv, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode)
        self.boot_id = self.system.boot_id()
        self.snapshot_path = self.config.state_dir / "resource-guard-snapshot.json"
        self.admission_path = self.config.state_dir / "recovery-admission.json"
        self.metrics_path = self.config.state_dir / "resource-guard-metrics.prom"
        self.incident_dir = self.config.state_dir / "incidents"
        self.snapshot: dict[str, Any] = {}
        self.consecutive = 0
        self.healthy_since: float | None = None
        self.previous_root_read: tuple[float, int] | None = None
        self.previous_process_io: dict[int, tuple[float, int, int]] = {}
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
        acted_clankers = list(previous.get("acted_clankers", [])) if previous.get("boot_id") == self.boot_id else []
        sample_history = list(previous.get("sample_history", []))[-120:] if previous.get("boot_id") == self.boot_id else []
        self.snapshot = {
            "version": 1,
            "boot_id": self.boot_id,
            "clean_shutdown": False,
            "acted": acted,
            "acted_clankers": acted_clankers,
            "sample_history": sample_history,
            "last_mitigation_at": previous.get("last_mitigation_at") if previous.get("boot_id") == self.boot_id else None,
            "last_steering_notification": previous.get("last_steering_notification") if previous.get("boot_id") == self.boot_id else None,
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

    def _write_admission(self, sample: MemorySample, candidates: list[Candidate], healthy: bool) -> None:
        now_ms = int(self.now() * 1000)
        if healthy:
            if self.healthy_since is None:
                self.healthy_since = self.now()
        else:
            self.healthy_since = None
        payload = {
            "version": 1,
            "now": now_ms,
            "bootObservedAt": int(float(self.snapshot.get("started_at", self.now())) * 1000),
            "healthySince": int(self.healthy_since * 1000) if self.healthy_since is not None else None,
            "lastAdmissionAt": self.snapshot.get("last_admission_at"),
            "activeRecoveries": sum(candidate.state in ("working", "blocked", "unknown") for candidate in candidates),
            "memoryAvailablePercent": sample.available_bytes * 100.0 / max(1, sample.total_bytes),
            "memoryPsiSome": sample.psi_some,
            "ioPsiSome": sample.io_psi_some,
            "ioPsiFull": sample.io_psi_full,
            "cpuPsiSome": sample.cpu_psi_some,
            "rootReadBytesPerSecond": sample.root_read_bytes_per_second,
            "configuredReadLimitBytesPerSecond": self.config.read_limit_bytes_per_second,
        }
        fd, temporary = tempfile.mkstemp(prefix=".recovery-admission-", dir=self.config.state_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, self.admission_path)
            self._fsync_dir(self.config.state_dir)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _write_metrics(self, sample: MemorySample, candidates: list[Candidate]) -> None:
        lines = [
            "# TYPE clankerhouse_memory_available_bytes gauge",
            f"clankerhouse_memory_available_bytes {sample.available_bytes}",
            "# TYPE clankerhouse_pressure_ratio gauge",
            f'clankerhouse_pressure_ratio{{resource="memory",scope="some"}} {sample.psi_some / 100.0}',
            f'clankerhouse_pressure_ratio{{resource="memory",scope="full"}} {sample.psi_full / 100.0}',
            f'clankerhouse_pressure_ratio{{resource="io",scope="some"}} {sample.io_psi_some / 100.0}',
            f'clankerhouse_pressure_ratio{{resource="io",scope="full"}} {sample.io_psi_full / 100.0}',
            f'clankerhouse_pressure_ratio{{resource="cpu",scope="some"}} {sample.cpu_psi_some / 100.0}',
            "# TYPE clankerhouse_root_read_bytes_per_second gauge",
            f"clankerhouse_root_read_bytes_per_second {sample.root_read_bytes_per_second}",
            "# TYPE clankerhouse_tracked_clankers gauge",
            f"clankerhouse_tracked_clankers {len(candidates)}",
        ]
        temporary = self.metrics_path.with_name(f".{self.metrics_path.name}.{os.getpid()}.tmp")
        temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.metrics_path)

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

    def _pressure(self, resource: str) -> tuple[float, float]:
        try:
            return parse_psi(self.system.read_text(self.system.proc / "pressure" / resource))
        except (OSError, ValueError):
            return 0.0, 0.0

    def sample(self) -> MemorySample:
        memory = parse_meminfo(self.system.read_text(self.system.proc / "meminfo"))
        some, full = parse_psi(self.system.read_text(self.system.proc / "pressure/memory"))
        io_some, io_full = self._pressure("io")
        cpu_some, _cpu_full = self._pressure("cpu")
        read_rate = 0.0
        reader = getattr(self.system, "root_read_bytes", None)
        if callable(reader):
            try:
                observed_at, read_bytes = self.now(), int(reader())
                if self.previous_root_read and observed_at > self.previous_root_read[0] and read_bytes >= self.previous_root_read[1]:
                    read_rate = (read_bytes - self.previous_root_read[1]) / (observed_at - self.previous_root_read[0])
                self.previous_root_read = (observed_at, read_bytes)
            except (OSError, ValueError):
                pass
        ec2_swapless = memory["SwapTotal"] == 0 and self.is_ec2()
        if ec2_swapless:
            threshold = max(self.config.ec2_floor_bytes, int(memory["MemTotal"] * self.config.ec2_percent / 100.0))
        else:
            threshold = int(memory["MemTotal"] * self.config.generic_percent / 100.0)
        return MemorySample(memory["MemTotal"], memory["MemAvailable"], memory["SwapTotal"], some, full, threshold, ec2_swapless, io_some, io_full, cpu_some, read_rate)

    def _report_state(self, pane: str, harness: str, clanker_id: str) -> tuple[str, int]:
        safe = re.sub(r"[^A-Za-z0-9_.%-]", "_", pane)
        path = self.config.runtime_root / "clanker-state" / f"{safe}.json"
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
        for line in self.multiplexer.list_panes().splitlines():
            parts = line.split("\t")
            if len(parts) != 11:
                continue
            pane, harness, clanker_id, tagged_pid_text, pane_pid_text, active, window_active, attached, session_name, cwd, worktree_path = parts
            if harness not in HARNESSES or not clanker_id or not pane:
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
            workloads: list[Workload] = []
            for root_pid in self.system.children(pid):
                root_stat = self.system.stat(root_pid)
                if not root_stat or self.system.uid(root_pid) != uid:
                    continue
                subtree = [root_pid]
                for process in subtree:
                    subtree.extend(child for child in self.system.children(process) if child not in subtree)
                command = self.system.comm(root_pid) or pathlib.Path(next(iter(self.system.cmdline(root_pid)), "process")).name
                observed_at = self.now()
                io_bytes = sum(self.system.process_io_bytes(process) for process in subtree)
                previous_io = self.previous_process_io.get(root_pid)
                io_rate = 0.0
                if previous_io and previous_io[2] == root_stat[1] and observed_at > previous_io[0] and io_bytes >= previous_io[1]:
                    io_rate = (io_bytes - previous_io[1]) / (observed_at - previous_io[0])
                self.previous_process_io[root_pid] = (observed_at, io_bytes, root_stat[1])
                workloads.append(Workload(root_pid, root_stat[1], command, sum(self.system.rss_bytes(process) for process in subtree), io_rate))
            candidates.append(Candidate(
                pane, harness, clanker_id, pid, pane_pid, stat[1],
                state, focused, session_name, cwd, worktree_path, rss_bytes, report_updated_at, tuple(workloads),
            ))
        duplicate_ids = {candidate.clanker_id for candidate in candidates if sum(other.clanker_id == candidate.clanker_id for other in candidates) > 1}
        return [candidate for candidate in candidates if candidate.clanker_id not in duplicate_ids]

    def validate(self, candidate: Candidate) -> bool:
        identity = self.multiplexer.pane_identity(candidate.pane)
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

    def _select_workload(self, sample: MemorySample, candidate: Candidate) -> Workload | None:
        memory_pressured = sample.available_bytes <= sample.threshold_bytes and (
            sample.psi_some >= self.config.psi_some or sample.psi_full >= self.config.psi_full
        )
        if memory_pressured:
            eligible = [workload for workload in candidate.workloads if workload.rss_bytes >= self.config.workload_min_rss_bytes]
            return max(eligible, key=lambda workload: (workload.rss_bytes, -workload.pid), default=None)
        eligible = [workload for workload in candidate.workloads if workload.io_bytes_per_second >= self.config.workload_min_io_bytes_per_second]
        return max(eligible, key=lambda workload: (workload.io_bytes_per_second, -workload.pid), default=None)

    def _validate_workload(self, candidate: Candidate, workload: Workload) -> bool:
        stat = self.system.stat(workload.pid)
        return (
            self.validate(candidate)
            and stat is not None
            and stat[1] == workload.start_ticks
            and self.system.uid(workload.pid) == os.getuid()
            and workload.pid != candidate.pid
            and _is_descendant(self.system, workload.pid, candidate.pid)
        )

    def _stop_workload(self, sample: MemorySample, candidate: Candidate, workload: Workload) -> pathlib.Path | None:
        if not self._validate_workload(candidate, workload):
            return None
        subtree = [workload.pid]
        for process in subtree:
            subtree.extend(child for child in self.system.children(process) if child not in subtree)
        identities: list[tuple[int, int]] = []
        for process in subtree:
            stat = self.system.stat(process)
            if not stat or self.system.uid(process) != os.getuid() or not _is_descendant(self.system, process, workload.pid):
                return None
            identities.append((process, stat[1]))
        io_pressured = (
            sample.io_psi_some >= self.config.io_psi_some
            or sample.io_psi_full >= self.config.io_psi_full
            or bool(self.config.read_limit_bytes_per_second and sample.root_read_bytes_per_second >= self.config.read_limit_bytes_per_second * 0.75)
        )
        reason = "sustained_io_pressure" if io_pressured else "sustained_memory_pressure"
        handles: list[tuple[int, int, int]] = []
        for process, start_ticks in identities:
            if not _is_descendant(self.system, process, workload.pid):
                for _pid, _start, handle in handles:
                    self.system.close_process(handle)
                return None
            handle = self.system.open_process(process, start_ticks)
            if handle is None:
                for _pid, _start, opened in handles:
                    self.system.close_process(opened)
                return None
            handles.append((process, start_ticks, handle))
        for process, start_ticks, _handle in handles:
            stat = self.system.stat(process)
            if not stat or stat[1] != start_ticks or self.system.uid(process) != os.getuid() or not _is_descendant(self.system, process, workload.pid):
                for _pid, _start, opened in handles:
                    self.system.close_process(opened)
                return None
        signalled = False
        forced = False
        try:
            for _process, _start_ticks, handle in reversed(handles):
                try:
                    self.system.signal_process(handle, signal.SIGTERM)
                    signalled = True
                except OSError:
                    pass
            if not signalled:
                return None
            if self.config.term_grace:
                self.sleep(self.config.term_grace)
            for process, start_ticks, handle in reversed(handles):
                stat = self.system.stat(process)
                if not stat or stat[1] != start_ticks or self.system.uid(process) != os.getuid():
                    continue
                try:
                    self.system.signal_process(handle, signal.SIGKILL)
                    forced = True
                except OSError:
                    pass
        finally:
            for _process, _start_ticks, handle in handles:
                self.system.close_process(handle)
        incident_id = uuid.uuid4().hex
        reason_text = "sustained I/O pressure" if reason == "sustained_io_pressure" else "sustained memory pressure"
        message = f"Resource Guard stopped child process {workload.command} (PID {workload.pid}) because {reason_text} exceeded the configured threshold. Incident: {incident_id}. Review the workload before restarting it."
        cli = os.environ.get("CLANKERHOUSE_CLANKERS", "clankers")
        try:
            notified = self.run_command([cli, "send", candidate.clanker_id, "--delivery", "steer", "--text", message]) == 0
        except OSError:
            notified = False
        incident = self._incident(
            "resource_pressure_workload_stop",
            candidate.incident_clanker(),
            {
                "reason": reason,
                "process": {"pid": workload.pid, "command": workload.command, "rssBytes": workload.rss_bytes, "ioBytesPerSecond": workload.io_bytes_per_second},
                "steering": {"attempted": True, "delivered": notified},
                "preIncidentSamples": self.snapshot.get("sample_history", []),
            },
            incident_id=incident_id,
        )
        self.snapshot["last_steering_notification"] = {"clanker_id": candidate.clanker_id, "incident": incident_id, "delivered": notified}
        print(json.dumps({"event": "resource_pressure_workload_stop", "clankerId": candidate.clanker_id, "pane": candidate.pane, "processPid": workload.pid, "forced": forced, "steeringDelivered": notified, "incident": str(incident)}), flush=True)
        return incident

    def _stop_tracked_clanker(self, candidate: Candidate) -> pathlib.Path | None:
        database = self.config.state_dir / "recovery.sqlite3"
        if not database.exists():
            return None
        try:
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
                row = connection.execute(
                    "SELECT desired_state, owner_unit FROM desired_clankers WHERE clanker_id = ?",
                    (candidate.clanker_id,),
                ).fetchone()
        except (OSError, sqlite3.Error):
            return None
        if row is None or row[0] not in ("running", "stopped") or not isinstance(row[1], str) or not re.fullmatch(r"clankerhouse-[A-Za-z0-9_.-]+\.scope", row[1]):
            return None
        cli = os.environ.get("CLANKERHOUSE_CLANKERS", "clankers")
        try:
            stopped = self.run_command([
                cli, "recovery", "stop", candidate.clanker_id,
                "--reason", "resource-pressure", "--no-pane-kill", "--if-present",
            ]) == 0
        except OSError:
            stopped = False
        if not stopped:
            return None
        incident = self._incident(
            "resource_pressure_clanker_stop",
            candidate.incident_clanker(),
            {"reason": "no_attributable_workload", "ownerUnit": row[1], "preIncidentSamples": self.snapshot.get("sample_history", [])},
        )
        print(json.dumps({"event": "resource_pressure_clanker_stop", "clankerId": candidate.clanker_id, "pane": candidate.pane, "incident": str(incident)}), flush=True)
        return incident

    def mitigate(self, sample: MemorySample, candidates: list[Candidate] | None = None) -> Candidate | None:
        candidates = self.discover() if candidates is None else candidates
        workload_by_clanker = {
            candidate.clanker_id: workload
            for candidate in candidates
            if (workload := self._select_workload(sample, candidate)) is not None
        }
        workload_candidates = [candidate for candidate in candidates if candidate.clanker_id in workload_by_clanker]
        selected = self.select(workload_candidates) or self.select(candidates)
        if selected is None:
            self.snapshot["mitigation_skipped"] = "no_non_focused_candidate"
            self._write_snapshot()
            return None
        if self.config.dry_run:
            self.snapshot["dry_run_selected"] = dataclasses.asdict(selected)
            self._write_snapshot()
            print(json.dumps({"event": "dry_run_selection", "clankerId": selected.clanker_id, "pane": selected.pane}), flush=True)
            return selected

        acted: Candidate | None = None
        incident: pathlib.Path | None = None
        if workload_candidates:
            remaining = list(workload_candidates)
            while remaining and acted is None:
                selected = self.select(remaining)
                if selected is None:
                    break
                remaining.remove(selected)
                if not self.validate(selected):
                    continue
                incident = self._stop_workload(sample, selected, workload_by_clanker[selected.clanker_id])
                acted = selected if incident is not None else None
        else:
            remaining = list(candidates)
            while remaining and acted is None:
                selected = self.select(remaining)
                if selected is None:
                    break
                remaining.remove(selected)
                if not self.validate(selected):
                    continue
                incident = self._stop_tracked_clanker(selected)
                acted = selected if incident is not None else None
        if acted is None:
            self.snapshot["mitigation_skipped"] = "workload_validation_failed" if workload_candidates else "no_attributable_workload_or_stoppable_clanker"
            self._write_snapshot()
            return None
        self.snapshot["acted"] = True
        self.snapshot.setdefault("acted_clankers", []).append(acted.clanker_id)
        self.snapshot["selected"] = dataclasses.asdict(acted)
        self.snapshot["last_mitigation_at"] = self.now()
        self._write_snapshot()
        return acted

    def run_once(self) -> MemorySample:
        sample = self.sample()
        memory_pressured = sample.available_bytes <= sample.threshold_bytes and (
            sample.psi_some >= self.config.psi_some or sample.psi_full >= self.config.psi_full
        )
        io_pressured = sample.io_psi_some >= self.config.io_psi_some or sample.io_psi_full >= self.config.io_psi_full
        throughput_pressured = bool(self.config.read_limit_bytes_per_second and sample.root_read_bytes_per_second >= self.config.read_limit_bytes_per_second * 0.75)
        pressured = memory_pressured or io_pressured or throughput_pressured
        last_mitigation_at = float(self.snapshot.get("last_mitigation_at", 0) or 0)
        cooling_down = bool(last_mitigation_at and self.now() - last_mitigation_at < self.config.cooldown)
        self.consecutive = self.consecutive + 1 if pressured and not cooling_down else 0
        candidates = self.discover()
        healthy = not pressured and sample.cpu_psi_some < self.config.cpu_psi_some
        self._write_admission(sample, candidates, healthy)
        self._write_metrics(sample, candidates)
        history = list(self.snapshot.get("sample_history", []))
        history.append({
            "sampled_at": self.now(),
            "memory_available_bytes": sample.available_bytes,
            "memory_psi_some": sample.psi_some,
            "memory_psi_full": sample.psi_full,
            "io_psi_some": sample.io_psi_some,
            "io_psi_full": sample.io_psi_full,
            "cpu_psi_some": sample.cpu_psi_some,
            "root_read_bytes_per_second": sample.root_read_bytes_per_second,
            "pressure_kind": "io" if io_pressured or throughput_pressured else "memory" if memory_pressured else None,
        })
        self.snapshot.update({
            "clean_shutdown": False,
            "sample_history": history[-120:],
            "sampled_at": self.now(),
            "sample": dataclasses.asdict(sample),
            "consecutive_pressure": self.consecutive,
            "cooling_down": cooling_down,
            "cooldown_remaining_seconds": max(0.0, self.config.cooldown - (self.now() - last_mitigation_at)) if cooling_down else 0.0,
            "pressure_kind": "io" if io_pressured or throughput_pressured else "memory" if memory_pressured else None,
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
        if self.consecutive >= self.config.samples:
            mitigated = self.mitigate(sample, candidates)
            if mitigated is not None and not self.config.dry_run:
                self.consecutive = 0
                self.snapshot["consecutive_pressure"] = 0
                self._write_snapshot()
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
