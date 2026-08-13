import http.server
import json
import os
import pathlib
import stat
import tempfile
import threading
import unittest
from dataclasses import replace

from clankerhouse.spot_watch import (
    ACTION_PATH,
    REBALANCE_PATH,
    Config,
    ImdsClient,
    SpotWatcher,
)


class MetadataState:
    def __init__(self):
        self.lock = threading.Lock()
        self.token_count = 0
        self.current_token = ""
        self.requests = []
        self.responses = {}
        self.reject_once = False


class MetadataHandler(http.server.BaseHTTPRequestHandler):
    server: "MetadataServer"

    def log_message(self, _format, *_args):
        pass

    def do_PUT(self):
        state = self.server.state
        self.assert_path("/latest/api/token")
        with state.lock:
            state.token_count += 1
            state.current_token = f"secret-token-{state.token_count}"
            token = state.current_token
            state.requests.append(("PUT", self.path, self.headers.get("X-aws-ec2-metadata-token-ttl-seconds")))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(token.encode())

    def do_GET(self):
        state = self.server.state
        supplied = self.headers.get("X-aws-ec2-metadata-token")
        with state.lock:
            state.requests.append(("GET", self.path, supplied))
            reject = state.reject_once
            state.reject_once = False
            valid = supplied == state.current_token
            response = state.responses.get(self.path)
        if reject or not valid:
            self.send_error(401)
            return
        if response is None:
            self.send_error(404)
            return
        status, body = response
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def assert_path(self, expected):
        if self.path != expected:
            self.send_error(404)
            raise AssertionError(self.path)


class MetadataServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, state):
        super().__init__(("127.0.0.1", 0), MetadataHandler)
        self.state = state


class SpotWatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.state = MetadataState()
        self.server = MetadataServer(self.state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"
        self.command_log = self.root / "commands.jsonl"
        self.command = self.root / "checkpoint"
        self.command.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, sys\n"
            "path = pathlib.Path(os.environ['SPOT_TEST_COMMAND_LOG'])\n"
            "with path.open('a') as stream:\n"
            "    stream.write(json.dumps(sys.argv[1:]) + '\\n')\n",
            encoding="utf-8",
        )
        self.command.chmod(0o700)
        self.old_log = os.environ.get("SPOT_TEST_COMMAND_LOG")
        os.environ["SPOT_TEST_COMMAND_LOG"] = str(self.command_log)
        self.config = Config(
            endpoint=self.endpoint,
            poll_interval=0.01,
            retry_interval=0.01,
            token_ttl=60,
            network_timeout=1,
            checkpoint_prefix=(str(self.command),),
            state_home=self.root / "state",
        )

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.old_log is None:
            os.environ.pop("SPOT_TEST_COMMAND_LOG", None)
        else:
            os.environ["SPOT_TEST_COMMAND_LOG"] = self.old_log
        self.temporary.cleanup()

    def command_calls(self):
        if not self.command_log.exists():
            return []
        return [json.loads(line) for line in self.command_log.read_text(encoding="utf-8").splitlines()]

    def response(self, path, value, status=200):
        self.state.responses[path] = (status, json.dumps(value).encode())

    def test_config_is_isolatable_and_bounds_network_values(self):
        config = Config.from_env({
            "HOME": str(self.root),
            "XDG_STATE_HOME": str(self.root / "custom-state"),
            "CLANKERHOUSE_SPOT_ENDPOINT": self.endpoint + "/prefix/",
            "CLANKERHOUSE_SPOT_POLL_INTERVAL": "0",
            "CLANKERHOUSE_SPOT_RETRY_INTERVAL": "0.02",
            "CLANKERHOUSE_SPOT_TOKEN_TTL": "99999",
            "SPOT_WATCH_TIMEOUT": "999",
            "SPOT_WATCH_REBALANCE": "true",
            "CLANKERHOUSE_SPOT_CHECKPOINT_COMMAND": f"{self.command} fixed-arg",
        })
        self.assertEqual(config.endpoint, self.endpoint + "/prefix")
        self.assertEqual(config.poll_interval, 0.01)
        self.assertEqual(config.retry_interval, 0.02)
        self.assertEqual(config.token_ttl, 21600)
        self.assertEqual(config.network_timeout, 30)
        self.assertTrue(config.watch_rebalance)
        self.assertEqual(config.checkpoint_prefix, (str(self.command), "fixed-arg"))
        self.assertEqual(config.state_dir, self.root / "custom-state" / "clankerhouse")

    def test_imdsv2_only_and_404_is_normal_no_notice(self):
        watcher = SpotWatcher(self.config)
        self.assertFalse(watcher.poll_once())
        self.assertEqual(self.command_calls(), [])
        self.assertEqual(self.state.requests[0], ("PUT", "/latest/api/token", "60"))
        self.assertEqual(self.state.requests[1][0:2], ("GET", ACTION_PATH))
        self.assertTrue(self.state.requests[1][2].startswith("secret-token-"))
        self.assertNotIn("Authorization", [item[2] for item in self.state.requests])

    def test_token_refreshes_on_401_and_expiry(self):
        clock = [10.0]
        client = ImdsClient(self.config, monotonic=lambda: clock[0])
        self.state.reject_once = True
        self.assertIsNone(client.get(ACTION_PATH))
        self.assertEqual(self.state.token_count, 2)

        clock[0] += 61
        self.assertIsNone(client.get(ACTION_PATH))
        self.assertEqual(self.state.token_count, 3)

    def test_interruption_durably_marks_and_checkpoints_exactly_once(self):
        deadline = "2030-01-02T03:04:05Z"
        self.response(ACTION_PATH, {"action": "terminate", "time": deadline})
        watcher = SpotWatcher(self.config, now=lambda: 1_700_000_000.25)
        self.assertTrue(watcher.poll_once())
        self.assertFalse(watcher.poll_once())

        self.assertEqual(self.command_calls(), [[
            "--reason", "spot-interruption", "--deadline", deadline,
        ]])
        marker = self.config.state_dir / "spot-interruption.json"
        payload = json.loads(marker.read_text(encoding="utf-8"))
        self.assertEqual(payload["deadline"], deadline)
        self.assertEqual(payload["checkpoint"], "succeeded")
        self.assertEqual(payload["checkpointExitCode"], 0)
        self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.config.state_dir.stat().st_mode), 0o700)

        # A new process-equivalent watcher shares the durable claim and lock.
        self.assertFalse(SpotWatcher(self.config).poll_once())
        self.assertEqual(len(self.command_calls()), 1)

    def test_parallel_watchers_share_safe_lock(self):
        deadline = "2030-01-02T03:04:05Z"
        self.response(ACTION_PATH, {"action": "stop", "time": deadline})
        watchers = [SpotWatcher(self.config), SpotWatcher(self.config)]
        barrier = threading.Barrier(3)
        results = []

        def poll(watcher):
            barrier.wait()
            results.append(watcher.poll_once())

        threads = [threading.Thread(target=poll, args=(watcher,)) for watcher in watchers]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=3)
        self.assertCountEqual(results, [True, False])
        self.assertEqual(len(self.command_calls()), 1)
        self.assertEqual(stat.S_IMODE((self.config.state_dir / "spot-watch.lock").stat().st_mode), 0o600)

    def test_rebalance_checkpoints_once_then_keeps_polling_for_action(self):
        config = replace(self.config, watch_rebalance=True)
        recommendation = "2030-01-01T00:00:00Z"
        self.response(REBALANCE_PATH, {"noticeTime": recommendation})
        watcher = SpotWatcher(config)
        self.assertTrue(watcher.poll_once())
        self.assertEqual(self.command_calls(), [[
            "--reason", "spot-rebalance", "--deadline", recommendation,
        ]])

        deadline = "2030-01-01T00:01:30Z"
        self.response(ACTION_PATH, {"action": "terminate", "time": deadline})
        self.assertTrue(watcher.poll_once())
        self.assertEqual(self.command_calls()[1], [
            "--reason", "spot-interruption", "--deadline", deadline,
        ])
        self.assertEqual(len(self.command_calls()), 2)

    def test_failures_retry_without_exiting_or_exposing_token(self):
        self.state.responses[ACTION_PATH] = (500, b"failure")
        sleeps = []
        watcher = SpotWatcher(self.config, sleep=lambda seconds: sleeps.append(seconds))
        with self.assertLogs("clankerhouse.spot_watch", level="WARNING") as logs:
            watcher.run(once=True)
        self.assertEqual(sleeps, [])
        output = "\n".join(logs.output)
        self.assertIn("500", output)
        self.assertNotIn("secret-token", output)


if __name__ == "__main__":
    unittest.main()
