import importlib.util
from importlib.machinery import SourceFileLoader
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "libexec" / "opencode-status"
SPEC = importlib.util.spec_from_loader(
    "opencode_status", SourceFileLoader("opencode_status", str(SCRIPT))
)
opencode_status = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(opencode_status)


class OpencodeV2StatusTest(unittest.TestCase):
    def test_v2_session_directory_uses_location_shape(self):
        self.assertEqual(
            opencode_status.session_directory(
                {"location": {"directory": "/tmp/work"}}
            ),
            "/tmp/work",
        )

    def test_harness_native_subagent_is_not_an_interactive_clanker(self):
        self.assertTrue(opencode_status.is_root_session({"id": "root"}))
        self.assertFalse(
            opencode_status.is_root_session({"id": "child", "parentID": "root"})
        )

    def test_active_root_replaces_stale_explicit_pane_binding(self):
        instances = [{"session_id": "stale", "start_ticks": 10}]
        candidates = [
            {"id": "inactive", "time": {"updated": 200}},
            {"id": "active", "time": {"updated": 100}},
            {"id": "child", "parentID": "active", "time": {"updated": 300}},
        ]
        roots = opencode_status.bind_root_sessions(
            instances,
            candidates,
            {"active": {"type": "running"}, "child": {"type": "running"}},
        )

        self.assertEqual(instances[0]["session_id"], "active")
        self.assertEqual([session["id"] for session in roots], ["active", "inactive"])

    def test_foreground_session_is_generating(self):
        message = {"type": "assistant", "time": {"created": 100}, "content": []}
        self.assertEqual(
            opencode_status.infer_v2_status(message, active=True),
            ("generating", "session running"),
        )

    def test_known_inactive_session_without_available_message_is_done(self):
        self.assertEqual(
            opencode_status.infer_v2_status(None, active=False, session_exists=True),
            ("done", "awaiting next task"),
        )

    def test_unresolved_new_session_is_starting(self):
        self.assertEqual(
            opencode_status.infer_v2_status(None, active=False, session_exists=False, initializing=True),
            ("starting", "initializing session"),
        )

    def test_old_bound_session_does_not_regress_to_starting_on_api_timeout(self):
        self.assertEqual(
            opencode_status.infer_v2_status(None, active=False, session_exists=True, initializing=False),
            ("done", "awaiting next task"),
        )

    def test_background_tool_remains_running_after_ctrl_b(self):
        message = {
            "type": "assistant",
            "time": {"created": 100},
            "content": [
                {"type": "tool", "name": "shell", "state": {"status": "running"}},
            ],
        }
        self.assertEqual(
            opencode_status.infer_v2_status(message, active=False),
            ("tool running", "shell"),
        )

    def test_idle_assistant_session_is_done(self):
        message = {"type": "assistant", "time": {"created": 100}, "content": []}
        self.assertEqual(
            opencode_status.infer_v2_status(message, active=False),
            ("done", "awaiting next task"),
        )

    def test_running_question_tool_is_blocked(self):
        message = {
            "type": "assistant",
            "content": [
                {"type": "tool", "name": "question", "state": {"status": "pending"}},
            ],
        }
        self.assertEqual(
            opencode_status.infer_v2_status(message),
            ("waiting question", "question"),
        )

    def test_running_permission_tool_is_blocked(self):
        message = {
            "type": "assistant",
            "content": [
                {"type": "tool", "name": "permission", "state": {"status": "pending"}},
            ],
        }
        self.assertEqual(
            opencode_status.infer_v2_status(message),
            ("waiting permission", "permission"),
        )


if __name__ == "__main__":
    unittest.main()
