#!/usr/bin/env python3
"""Watch EC2 Instance Metadata Service v2 for Spot interruption notices.

This module intentionally uses only the Python standard library and IMDSv2. It
needs neither AWS credentials nor an instance role.
"""

from __future__ import annotations

import argparse
import dataclasses
import fcntl
import hashlib
import json
import logging
import os
import pathlib
import shlex
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

LOG = logging.getLogger("clankerhouse.spot_watch")
TOKEN_PATH = "/latest/api/token"
ACTION_PATH = "/latest/meta-data/spot/instance-action"
REBALANCE_PATH = "/latest/meta-data/events/recommendations/rebalance"


def _env_float(env: Mapping[str, str], name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        return min(maximum, max(minimum, float(env.get(name, str(default)))))
    except ValueError:
        return default


def _env_int(env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        return min(maximum, max(minimum, int(env.get(name, str(default)))))
    except ValueError:
        return default


def _env_bool(env: Mapping[str, str], name: str, default: bool = False) -> bool:
    value = env.get(name)
    return default if value is None else value.lower() in ("1", "true", "yes", "on")


@dataclasses.dataclass(frozen=True)
class Config:
    endpoint: str = "http://169.254.169.254"
    poll_interval: float = 5.0
    retry_interval: float = 5.0
    token_ttl: int = 21600
    network_timeout: float = 2.0
    watch_rebalance: bool = False
    checkpoint_prefix: tuple[str, ...] = ("clankers", "recovery", "checkpoint")
    state_home: pathlib.Path = pathlib.Path.home() / ".local/state"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        # SPOT_WATCH_* follows resource_guard.py's established prefix style;
        # CLANKERHOUSE_SPOT_* aliases make the variables unambiguous in a
        # shared service environment.
        aliases = {
            "CLANKERHOUSE_SPOT_ENDPOINT": ("SPOT_WATCH_ENDPOINT", "SPOT_WATCH_IMDS_ENDPOINT"),
            "CLANKERHOUSE_SPOT_POLL_INTERVAL": ("SPOT_WATCH_POLL_INTERVAL",),
            "CLANKERHOUSE_SPOT_RETRY_INTERVAL": ("SPOT_WATCH_RETRY_INTERVAL",),
            "CLANKERHOUSE_SPOT_TOKEN_TTL": ("SPOT_WATCH_TOKEN_TTL",),
            "CLANKERHOUSE_SPOT_NETWORK_TIMEOUT": ("SPOT_WATCH_NETWORK_TIMEOUT", "SPOT_WATCH_TIMEOUT"),
            "CLANKERHOUSE_SPOT_WATCH_REBALANCE": ("SPOT_WATCH_REBALANCE",),
            "CLANKERHOUSE_SPOT_CHECKPOINT_COMMAND": ("SPOT_WATCH_CHECKPOINT_COMMAND",),
        }
        resolved = dict(env)
        for canonical, alternatives in aliases.items():
            if canonical not in resolved:
                for alternative in alternatives:
                    if alternative in env:
                        resolved[canonical] = env[alternative]
                        break
        env = resolved
        home = pathlib.Path(env.get("HOME", str(pathlib.Path.home())))
        endpoint = env.get("CLANKERHOUSE_SPOT_ENDPOINT", "http://169.254.169.254").rstrip("/")
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("CLANKERHOUSE_SPOT_ENDPOINT must be an HTTP(S) origin or path prefix")
        command = shlex.split(env.get("CLANKERHOUSE_SPOT_CHECKPOINT_COMMAND", "clankers recovery checkpoint"))
        if not command:
            raise ValueError("CLANKERHOUSE_SPOT_CHECKPOINT_COMMAND must not be empty")
        return cls(
            endpoint=endpoint,
            poll_interval=_env_float(env, "CLANKERHOUSE_SPOT_POLL_INTERVAL", 5.0, 0.01, 3600.0),
            retry_interval=_env_float(env, "CLANKERHOUSE_SPOT_RETRY_INTERVAL", 5.0, 0.01, 3600.0),
            token_ttl=_env_int(env, "CLANKERHOUSE_SPOT_TOKEN_TTL", 21600, 1, 21600),
            network_timeout=_env_float(env, "CLANKERHOUSE_SPOT_NETWORK_TIMEOUT", 2.0, 0.05, 30.0),
            watch_rebalance=_env_bool(env, "CLANKERHOUSE_SPOT_WATCH_REBALANCE"),
            checkpoint_prefix=tuple(command),
            state_home=pathlib.Path(env.get("XDG_STATE_HOME", str(home / ".local/state"))),
        )

    @property
    def state_dir(self) -> pathlib.Path:
        return self.state_home / "clankerhouse"


@dataclasses.dataclass(frozen=True)
class Notice:
    kind: str
    deadline: str
    payload: dict[str, Any]

    @property
    def identity(self) -> str:
        encoded = json.dumps(self.payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(self.kind.encode() + b"\0" + encoded).hexdigest()


class ImdsClient:
    """Minimal IMDSv2 client. Tokens are retained only in memory."""

    def __init__(
        self,
        config: Config,
        *,
        opener: Callable[..., Any] = urllib.request.urlopen,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self.opener = opener
        self.monotonic = monotonic
        self._token: str | None = None
        self._token_expires = 0.0

    def _url(self, path: str) -> str:
        return f"{self.config.endpoint}{path}"

    def _refresh_token(self) -> None:
        request = urllib.request.Request(
            self._url(TOKEN_PATH),
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": str(self.config.token_ttl)},
        )
        with self.opener(request, timeout=self.config.network_timeout) as response:
            token = response.read().decode("utf-8")
        if not token:
            raise RuntimeError("IMDSv2 returned an empty token")
        self._token = token
        # Refresh slightly early, while preserving useful short TTLs in tests.
        margin = min(30.0, self.config.token_ttl * 0.1)
        self._token_expires = self.monotonic() + self.config.token_ttl - margin

    def _valid_token(self) -> str:
        if self._token is None or self.monotonic() >= self._token_expires:
            self._refresh_token()
        assert self._token is not None
        return self._token

    def get(self, path: str) -> bytes | None:
        for attempt in range(2):
            token = self._valid_token()
            request = urllib.request.Request(
                self._url(path), headers={"X-aws-ec2-metadata-token": token}
            )
            try:
                with self.opener(request, timeout=self.config.network_timeout) as response:
                    return response.read()
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    return None
                if error.code == 401 and attempt == 0:
                    self._token = None
                    self._token_expires = 0.0
                    continue
                raise
        return None

    def notice(self, path: str, kind: str) -> Notice | None:
        body = self.get(path)
        if body is None:
            return None
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"IMDSv2 returned invalid JSON for {kind}") from error
        if not isinstance(payload, dict):
            raise ValueError(f"IMDSv2 returned a non-object notice for {kind}")
        deadline = payload.get("time") if kind == "spot-interruption" else payload.get("noticeTime")
        if not isinstance(deadline, str) or not deadline:
            # Rebalance recommendations have no shutdown deadline; noticeTime is
            # still a stable timestamp to pass to checkpoint tooling.
            raise ValueError(f"IMDSv2 {kind} notice has no timestamp")
        return Notice(kind, deadline, payload)


class SpotWatcher:
    def __init__(
        self,
        config: Config | None = None,
        *,
        client: ImdsClient | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
        run_command: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    ) -> None:
        self.config = config or Config.from_env()
        self.client = client or ImdsClient(self.config)
        self.sleep = sleep
        self.now = now
        self.run_command = run_command
        self.stop_requested = False
        self._prepare_state_dir()

    def _prepare_state_dir(self) -> None:
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.config.state_dir, 0o700)

    @staticmethod
    def _fsync_dir(path: pathlib.Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _atomic_write(self, path: pathlib.Path, payload: Mapping[str, Any]) -> None:
        self._prepare_state_dir()
        descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=self.config.state_dir)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            os.chmod(path, 0o600)
            self._fsync_dir(self.config.state_dir)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass

    def _checkpoint_once(self, notice: Notice) -> bool:
        """Persist and checkpoint one unique notice while holding a local lock."""
        self._prepare_state_dir()
        lock_path = self.config.state_dir / "spot-watch.lock"
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(lock_fd, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            marker_path = self.config.state_dir / f"{notice.kind}.json"
            try:
                previous = json.loads(marker_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                previous = {}
            if previous.get("noticeId") == notice.identity:
                return False

            marker = {
                "version": 1,
                "kind": notice.kind,
                "noticeId": notice.identity,
                "deadline": notice.deadline,
                "receivedAt": int(self.now() * 1000),
                "notice": notice.payload,
                "checkpoint": "started",
            }
            # Claim durably before spawning. This gives at-most-once execution
            # across overlapping services and process restarts.
            self._atomic_write(marker_path, marker)
            command = [*self.config.checkpoint_prefix, "--reason", notice.kind, "--deadline", notice.deadline]
            result = self.run_command(command, check=False)
            marker["checkpoint"] = "succeeded" if result.returncode == 0 else "failed"
            marker["checkpointExitCode"] = result.returncode
            self._atomic_write(marker_path, marker)
            if result.returncode != 0:
                LOG.error("checkpoint command failed for %s (exit %d)", notice.kind, result.returncode)
            else:
                LOG.warning("checkpoint completed for %s with deadline %s", notice.kind, notice.deadline)
            return True
        finally:
            os.close(lock_fd)

    def poll_once(self) -> bool:
        acted = False
        action = self.client.notice(ACTION_PATH, "spot-interruption")
        if action is not None:
            acted = self._checkpoint_once(action) or acted
        if self.config.watch_rebalance:
            rebalance = self.client.notice(REBALANCE_PATH, "spot-rebalance")
            if rebalance is not None:
                acted = self._checkpoint_once(rebalance) or acted
        return acted

    def run(self, *, once: bool = False) -> None:
        old_handlers: dict[int, Any] = {}

        def request_stop(_signum: int, _frame: Any) -> None:
            self.stop_requested = True

        if not once:
            for sig in (signal.SIGINT, signal.SIGTERM):
                old_handlers[sig] = signal.signal(sig, request_stop)
        try:
            while not self.stop_requested:
                try:
                    self.poll_once()
                    delay = self.config.poll_interval
                except Exception as error:  # A watcher must survive transient IMDS/command failures.
                    LOG.warning("Spot metadata poll failed: %s", error)
                    delay = self.config.retry_interval
                if once:
                    break
                self.sleep(delay)
        finally:
            for sig, handler in old_handlers.items():
                signal.signal(sig, handler)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    SpotWatcher().run(once=args.once)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
