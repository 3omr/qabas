import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import agent_backend
from agent_backend import (
    AgentBackendError,
    AntigravityBackend,
    ClaudeCodeBackend,
    CodexBackend,
    GeminiCliBackend,
    PreflightResult,
    _iter_ndjson,
    _resolve_command,
    apply_allow_rules,
    get_backend,
)


class ResolveCommandTests(unittest.TestCase):
    def test_a_normal_executable_is_launched_directly(self) -> None:
        with patch.object(agent_backend.shutil, "which", return_value="/usr/bin/agy"):
            self.assertEqual(_resolve_command("agy"), ["/usr/bin/agy"])

    def test_a_cmd_shim_is_launched_through_cmd_exe(self) -> None:
        with (
            patch.object(agent_backend.os, "name", "nt"),
            patch.object(
                agent_backend.shutil, "which", return_value=r"C:\nodejs\agy.cmd"
            ),
        ):
            self.assertEqual(
                _resolve_command("agy"), ["cmd", "/c", r"C:\nodejs\agy.cmd"]
            )

    def test_a_bat_shim_is_launched_through_cmd_exe(self) -> None:
        with (
            patch.object(agent_backend.os, "name", "nt"),
            patch.object(
                agent_backend.shutil, "which", return_value=r"C:\nodejs\agy.bat"
            ),
        ):
            self.assertEqual(
                _resolve_command("agy"), ["cmd", "/c", r"C:\nodejs\agy.bat"]
            )

    def test_a_shim_on_posix_is_launched_directly(self) -> None:
        # os.name stays "posix" here, so the cmd/bat routing must not apply.
        with patch.object(agent_backend.shutil, "which", return_value="/usr/bin/agy.cmd"):
            self.assertEqual(_resolve_command("agy"), ["/usr/bin/agy.cmd"])

    def test_an_executable_not_on_path_resolves_to_none(self) -> None:
        with patch.object(agent_backend.shutil, "which", return_value=None):
            self.assertIsNone(_resolve_command("agy"))


class IterNdjsonTests(unittest.TestCase):
    def test_one_object_is_yielded_per_line(self) -> None:
        stream = ['{"a": 1}\n', '{"a": 2}\n']
        self.assertEqual(list(_iter_ndjson(stream)), [{"a": 1}, {"a": 2}])

    def test_blank_lines_are_skipped(self) -> None:
        stream = ['{"a": 1}\n', "\n", "   \n", '{"a": 2}\n']
        self.assertEqual(list(_iter_ndjson(stream)), [{"a": 1}, {"a": 2}])

    def test_plain_prose_lines_are_skipped(self) -> None:
        # All three CLIs occasionally print a login notice or warning straight
        # into the stream; that must not abort an otherwise fine run.
        stream = ["Please sign in to continue\n", '{"a": 1}\n']
        self.assertEqual(list(_iter_ndjson(stream)), [{"a": 1}])

    def test_a_trailing_carriage_return_on_every_line_is_tolerated(self) -> None:
        stream = ['{"a": 1}\r\n', '{"a": 2}\r\n']
        self.assertEqual(list(_iter_ndjson(stream)), [{"a": 1}, {"a": 2}])


class AntigravityNormalizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = AntigravityBackend()

    def test_init_event_carries_the_conversation_id(self) -> None:
        payload = {
            "event": "init",
            "conversation_id": "f24d585f",
            "init": {
                "cwd": "/x",
                "tools": ["run_command"],
                "permission_mode": "request-review",
            },
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "init")
        self.assertEqual(event.conversation_id, "f24d585f")

    def test_step_update_with_a_tool_step_type_becomes_a_tool_event(self) -> None:
        payload = {
            "event": "step_update",
            "step_update": {
                "conversation_id": "f24d585f",
                "step_index": 2,
                "state": "ACTIVE",
                "step_type": "tool",
                "tool_name": "run_command",
                "tool_info": {"name": "run_command", "parameters": {"CommandLine": "ls"}},
            },
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "tool")
        self.assertEqual(event.tool_name, "run_command")
        self.assertEqual(event.status, "")
        self.assertEqual(event.conversation_id, "f24d585f")

    def test_result_event_carries_response_status_and_usage(self) -> None:
        payload = {
            "event": "result",
            "result": {
                "conversation_id": "f24d585f",
                "status": "SUCCESS",
                "response": "OK\n",
                "num_turns": 1,
                "usage": {"input_tokens": 18000, "output_tokens": 604, "total_tokens": 18604},
            },
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "result")
        self.assertEqual(event.status, "SUCCESS")
        self.assertEqual(event.text, "OK\n")
        self.assertEqual(event.conversation_id, "f24d585f")

    def test_an_unrecognised_payload_comes_back_as_raw_without_raising(self) -> None:
        event = self.backend._normalize({"event": "something_new", "foo": "bar"})
        self.assertEqual(event.kind, "raw")


class ClaudeCodeNormalizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = ClaudeCodeBackend()

    def test_init_event_carries_the_session_id_as_conversation_id(self) -> None:
        payload = {
            "type": "system",
            "subtype": "init",
            "session_id": "26e671dd",
            "tools": ["Bash"],
            "model": "claude-opus-5",
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "init")
        self.assertEqual(event.conversation_id, "26e671dd")

    def test_an_assistant_text_block_becomes_a_message_event(self) -> None:
        payload = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "hello"}], "usage": {"input_tokens": 5}},
            "session_id": "26e671dd",
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "message")
        self.assertEqual(event.text, "hello")
        self.assertEqual(event.conversation_id, "26e671dd")

    def test_an_assistant_tool_use_block_becomes_a_tool_event(self) -> None:
        payload = {
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]},
            "session_id": "26e671dd",
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "tool")
        self.assertEqual(event.tool_name, "Bash")
        self.assertEqual(event.conversation_id, "26e671dd")

    def test_a_result_marked_is_error_becomes_status_error(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": "Not logged in",
            "is_error": True,
            "session_id": "26e671dd",
            "usage": {"input_tokens": 0},
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "result")
        self.assertEqual(event.status, "ERROR")
        self.assertEqual(event.text, "Not logged in")

    def test_a_result_not_marked_is_error_becomes_status_success(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": "Not logged in",
            "is_error": False,
            "session_id": "26e671dd",
            "usage": {"input_tokens": 0},
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.status, "SUCCESS")

    def test_an_unrecognised_payload_comes_back_as_raw_without_raising(self) -> None:
        event = self.backend._normalize({"type": "something_new", "session_id": "x"})
        self.assertEqual(event.kind, "raw")


class CodexNormalizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = CodexBackend()

    def test_an_unrecognised_payload_comes_back_as_raw_without_raising(self) -> None:
        event = self.backend._normalize({"msg": {"type": "something_new"}})
        self.assertEqual(event.kind, "raw")

    def test_a_task_started_message_becomes_an_init_event(self) -> None:
        payload = {"msg": {"type": "task_started"}, "session_id": "abc123"}
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "init")
        self.assertEqual(event.conversation_id, "abc123")

    def test_an_exec_command_message_becomes_a_tool_event(self) -> None:
        payload = {
            "msg": {"type": "exec_command_begin", "command": "ls"},
            "session_id": "abc123",
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "tool")
        self.assertEqual(event.tool_name, "ls")

    def test_a_task_complete_message_becomes_a_result_event(self) -> None:
        payload = {
            "msg": {"type": "task_complete", "last_agent_message": "done"},
            "session_id": "abc123",
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "result")
        self.assertEqual(event.status, "SUCCESS")
        self.assertEqual(event.text, "done")


class CommandBuilderSafetyTests(unittest.TestCase):
    def test_dangerously_skip_permissions_is_never_passed_by_any_backend(self) -> None:
        backends = (
            AntigravityBackend(),
            ClaudeCodeBackend(),
            CodexBackend(),
            GeminiCliBackend(),
        )
        for backend in backends:
            for conversation_id in (None, "conv-1"):
                command = backend._command("hello", conversation_id)
                self.assertNotIn("--dangerously-skip-permissions", command)
                self.assertNotIn("yolo", command)

    def test_antigravity_passes_conversation_flag_only_when_given(self) -> None:
        backend = AntigravityBackend()
        with_conversation = backend._command("hello", "conv-1")
        without_conversation = backend._command("hello", None)
        self.assertIn("--conversation", with_conversation)
        self.assertIn("conv-1", with_conversation)
        self.assertNotIn("--conversation", without_conversation)

    def test_claude_code_resumes_with_the_resume_flag(self) -> None:
        backend = ClaudeCodeBackend()
        command = backend._command("hello", "conv-1")
        self.assertIn("--resume", command)
        self.assertIn("conv-1", command)


class AntigravityMissingAllowRulesTests(unittest.TestCase):
    def _required(self, workspace: Path) -> tuple[str, ...]:
        return AntigravityBackend().required_allow_rules(workspace)

    def test_all_rules_are_missing_when_the_settings_file_does_not_exist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory) / "workspace"
            settings_path = Path(temporary_directory) / "nonexistent" / "settings.json"
            backend = AntigravityBackend()
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                missing = backend.missing_allow_rules(workspace)
            self.assertEqual(missing, self._required(workspace))

    def test_only_the_ungranted_rules_are_returned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory) / "workspace"
            settings_path = Path(temporary_directory) / "settings.json"
            backend = AntigravityBackend()
            required = self._required(workspace)
            settings_path.write_text(
                json.dumps({"permissions": {"allow": [required[0]]}}), encoding="utf-8"
            )
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                missing = backend.missing_allow_rules(workspace)
            self.assertEqual(missing, required[1:])

    def test_no_rules_are_missing_when_all_are_granted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory) / "workspace"
            settings_path = Path(temporary_directory) / "settings.json"
            backend = AntigravityBackend()
            required = self._required(workspace)
            settings_path.write_text(
                json.dumps({"permissions": {"allow": list(required)}}), encoding="utf-8"
            )
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                missing = backend.missing_allow_rules(workspace)
            self.assertEqual(missing, ())

    def test_malformed_settings_json_is_treated_as_no_rules_granted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            workspace = Path(temporary_directory) / "workspace"
            settings_path = Path(temporary_directory) / "settings.json"
            settings_path.write_text("{not valid json", encoding="utf-8")
            backend = AntigravityBackend()
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                missing = backend.missing_allow_rules(workspace)
            self.assertEqual(missing, self._required(workspace))


class ApplyAllowRulesTests(unittest.TestCase):
    def test_rules_are_merged_without_dropping_unrelated_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings_path = Path(temporary_directory) / "settings.json"
            settings_path.write_text(
                json.dumps(
                    {
                        "colorScheme": "tokyo night",
                        "trustedWorkspaces": ["/home/user/notes"],
                        "permissions": {"allow": ["existing_rule"]},
                    }
                ),
                encoding="utf-8",
            )
            backend = AntigravityBackend()
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                apply_allow_rules(backend, ("new_rule",))

            payload = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["colorScheme"], "tokyo night")
            self.assertEqual(payload["trustedWorkspaces"], ["/home/user/notes"])
            self.assertEqual(
                payload["permissions"]["allow"], ["existing_rule", "new_rule"]
            )

    def test_applying_the_same_rule_twice_does_not_duplicate_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings_path = Path(temporary_directory) / "settings.json"
            backend = AntigravityBackend()
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                apply_allow_rules(backend, ("new_rule",))
                apply_allow_rules(backend, ("new_rule",))

            payload = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["permissions"]["allow"], ["new_rule"])

    def test_the_settings_file_is_created_when_absent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            settings_path = Path(temporary_directory) / "nested" / "settings.json"
            backend = AntigravityBackend()
            with patch.object(
                AntigravityBackend, "settings_path", lambda self: settings_path
            ):
                returned_path = apply_allow_rules(backend, ("new_rule",))

            self.assertEqual(returned_path, settings_path)
            payload = json.loads(settings_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["permissions"]["allow"], ["new_rule"])


class GeminiCliNormalizeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = GeminiCliBackend()

    def test_a_system_init_event_carries_the_session_id(self) -> None:
        payload = {"type": "system", "subtype": "init", "session_id": "sess-1"}
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "init")
        self.assertEqual(event.conversation_id, "sess-1")

    def test_an_assistant_text_block_becomes_a_message_event(self) -> None:
        payload = {
            "type": "assistant",
            "session_id": "sess-1",
            "message": {"content": [{"type": "text", "text": "Reviewed."}]},
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "message")
        self.assertEqual(event.text, "Reviewed.")

    def test_an_assistant_tool_use_block_becomes_a_tool_event(self) -> None:
        payload = {
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "read_file"}]},
        }
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "tool")
        self.assertEqual(event.tool_name, "read_file")

    def test_a_result_marked_is_error_becomes_status_error(self) -> None:
        payload = {"type": "result", "is_error": True, "result": "boom"}
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "result")
        self.assertEqual(event.status, "ERROR")
        self.assertEqual(event.text, "boom")

    def test_a_bare_response_object_still_becomes_a_result(self) -> None:
        # A build that emits its own single-object JSON instead of the
        # Claude-shaped stream must not degrade to an unusable raw event.
        payload = {"response": "Reviewed.", "stats": {"totalTokens": 12}}
        event = self.backend._normalize(payload)
        self.assertEqual(event.kind, "result")
        self.assertEqual(event.text, "Reviewed.")
        self.assertEqual(event.status, "SUCCESS")
        self.assertEqual(event.usage, {"totalTokens": 12})

    def test_an_unrecognised_payload_comes_back_as_raw_without_raising(self) -> None:
        self.assertEqual(self.backend._normalize({"type": "ping"}).kind, "raw")

    def test_the_prompt_is_passed_and_a_conversation_id_is_dropped(self) -> None:
        # Gemini has no headless resume flag, so a supplied id must not turn
        # into an argument the CLI would reject.
        backend = GeminiCliBackend()
        self.assertEqual(
            backend._command("hello", None),
            ["--output-format", "stream-json", "-p", "hello"],
        )
        self.assertEqual(
            backend._command("hello", "conv-1"), backend._command("hello", None)
        )

    def test_no_permission_settings_file_is_claimed(self) -> None:
        # Gemini keeps permissions under a different schema, so this module
        # must not offer to write the shared permissions.allow shape.
        self.assertIsNone(self.backend.settings_path())
        with self.assertRaises(AgentBackendError):
            apply_allow_rules(self.backend, ("command(x)",))


class GetBackendTests(unittest.TestCase):
    def test_each_known_name_resolves_to_its_backend_class(self) -> None:
        self.assertIsInstance(get_backend("antigravity"), AntigravityBackend)
        self.assertIsInstance(get_backend("claude-code"), ClaudeCodeBackend)
        self.assertIsInstance(get_backend("codex"), CodexBackend)
        self.assertIsInstance(get_backend("gemini-cli"), GeminiCliBackend)

    def test_an_unknown_name_raises_and_lists_the_known_names(self) -> None:
        with self.assertRaises(AgentBackendError) as context:
            get_backend("nonexistent")
        message = str(context.exception)
        self.assertIn("antigravity", message)
        self.assertIn("claude-code", message)
        self.assertIn("codex", message)
        self.assertIn("gemini-cli", message)


class PreflightResultReadyTests(unittest.TestCase):
    def test_not_ready_when_not_installed(self) -> None:
        result = PreflightResult(name="x", installed=False)
        self.assertFalse(result.ready)

    def test_not_ready_when_authenticated_is_false(self) -> None:
        result = PreflightResult(name="x", installed=True, authenticated=False)
        self.assertFalse(result.ready)

    def test_not_ready_when_allow_rules_are_missing(self) -> None:
        result = PreflightResult(
            name="x", installed=True, missing_allow_rules=("rule",)
        )
        self.assertFalse(result.ready)

    def test_ready_when_installed_with_no_missing_rules_and_unprobed_auth(self) -> None:
        result = PreflightResult(name="x", installed=True, authenticated=None)
        self.assertTrue(result.ready)

    def test_ready_when_installed_and_authenticated_true(self) -> None:
        result = PreflightResult(name="x", installed=True, authenticated=True)
        self.assertTrue(result.ready)


if __name__ == "__main__":
    unittest.main()
