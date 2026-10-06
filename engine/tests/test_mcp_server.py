import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).parents[1]
SCRIPTS_DIR = REPO_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import mcp_server  # noqa: E402
from figure_fixtures import figure_manifest
from mcp_server import Server, Tool, ToolError  # noqa: E402
from phase_validation import SECTION_HEADINGS  # noqa: E402
from source_naming import normalize_source_key, normalize_source_stem
from transcriber_models import RemoteSource

DESTRUCTIVE_TOOLS = ("run_lecture_pipeline", "create_module", "apply_sync", "upload_recordings", "apply_review", "finalize")
NON_CONFIRMING_TOOLS = (
    "get_engine_settings", "set_engine_settings",
    "doctor",
    "agent_status",
    "workspace_info",
    "list_modules",
    "list_lectures",
    "audit_sources",
    "extract_figures",
    "validate_draft",
    "verify_provenance",
    "start_draft",
    "read_draft",
    "stage_draft_part",
    "write_parts_with_agy",
    "begin_lecture",
)
ALL_TOOL_NAMES = (
    "run_lecture_pipeline",
    "get_engine_settings", "set_engine_settings",
    "remove_transcript", "remove_module", "restore_module", "list_removed_modules", "list_trash", "restore_trash",
    "set_general_materials",
    "define_lecture", "delete_lecture", "hide_lecture", "restore_recordings", "import_file", "rename_file", "remove_file", "list_module_files",
    "doctor",
    "agent_status",
    "workspace_info",
    "list_modules",
    "list_library", "propose_organization", "apply_organization",
    "list_lectures",
    "audit_sources",
    "create_module",
    "apply_sync",
    "upload_recordings",
    "start_draft",
    "read_draft",
    "stage_draft_part",
    "write_parts_with_agy",
    "apply_review",
    "finalize",
    "drafting_reference",
    "build_exam_index", "prepare_exam_file",
    "find_questions",
    "extract_figures",
    "validate_draft",
    "verify_provenance",
    "prepare_manifest",
    "begin_lecture",
)

MODULE_TOOLS_NEEDING_MANIFEST = (
    "apply_sync",
    "start_draft",
    "read_draft",
    "stage_draft_part",
    "write_parts_with_agy",
    "apply_review",
    "finalize",
)

MODULE_TOOLS = (
    "begin_lecture",
    "list_lectures",
    "audit_sources",
    "extract_figures",
    "validate_draft",
    "verify_provenance",
    "create_module",
    "apply_sync",
    "upload_recordings",
    "start_draft",
    "read_draft",
    "stage_draft_part",
    "write_parts_with_agy",
    "apply_review",
    "finalize",
)


_RemoteSource = RemoteSource


def _remote(title: str, source_type: str) -> RemoteSource:
    return RemoteSource("source", title, normalize_source_key(title), normalize_source_stem(title), source_type, status="ready")


@contextmanager
def _notebook_sources(result: list[_RemoteSource] | Exception) -> Iterator[None]:
    """Stand in for the notebook listing, which is a network call behind nlm.

    Passing an exception is how the unreachable-notebook path is exercised:
    the engine has to report that as data, not raise it at the panel.
    """
    def listing(_notebook_id: str, _config: object) -> list[_RemoteSource]:
        if isinstance(result, Exception):
            raise result
        return result

    import nlm_client

    with patch.object(nlm_client, "list_remote_sources", listing), patch.object(
        nlm_client, "load_config", return_value={}
    ):
        yield


def _request(method: str, request_id: object = 1, params: dict | None = None) -> dict:
    message = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return message


def _call_params(name: str, **arguments: object) -> dict:
    return {"name": name, "arguments": arguments}


class RecordingHandler:
    """Records whether it was invoked, in place of a real handler."""

    def __init__(self, result: str = "ok") -> None:
        self.calls: list[tuple[dict, Path]] = []
        self._result = result

    def __call__(self, arguments: dict, workspace: Path) -> str:
        self.calls.append((arguments, workspace))
        return self._result


def make_server() -> tuple[Server, io.StringIO]:
    stream = io.StringIO()
    return Server(workspace=Path("/tmp/workspace"), stdout=stream), stream


def _lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


class ProtocolBasicsTests(unittest.TestCase):
    def test_initialize_reports_protocol_and_server_name(self) -> None:
        server, stream = make_server()
        server.handle(_request("initialize"))
        result = _lines(stream)[0]["result"]
        self.assertIn("protocolVersion", result)
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(result["serverInfo"]["name"], "universal-transcriber")

    def test_ping_returns_empty_result(self) -> None:
        server, stream = make_server()
        server.handle(_request("ping"))
        self.assertEqual(_lines(stream)[0]["result"], {})

    def test_tools_list_names_match_the_contract(self) -> None:
        server, stream = make_server()
        server.handle(_request("tools/list"))
        names = [tool["name"] for tool in _lines(stream)[0]["result"]["tools"]]
        self.assertEqual(set(names), set(ALL_TOOL_NAMES))
        self.assertEqual(len(names), len(ALL_TOOL_NAMES))

    def test_figures_are_reachable_without_a_shell(self) -> None:
        """A model that wants figures must not have to run the launcher itself.

        Every step of a transcription is a tool except this one used to be, so
        a model reached for bash and the workspace path of a script the
        packaged app does not ship.
        """
        schema = mcp_server.TOOLS_BY_NAME["extract_figures"].schema()
        self.assertEqual(set(schema["required"]), {"module"})
        self.assertIn("lecture", schema["properties"])
        self.assertIn("slides", schema["properties"])

    def test_a_draft_can_be_checked_without_being_finalized(self) -> None:
        """Finalizing writes the student's transcript; being sure must not.

        Without this, a model that had just written a draft read the engine's
        source looking for the validator and called it out of a shell.
        """
        for name, field in (("validate_draft", "draft"), ("verify_provenance", "transcript")):
            with self.subTest(tool=name):
                tool = mcp_server.TOOLS_BY_NAME[name]
                schema = tool.schema()
                self.assertEqual(set(schema["required"]), {"module", field})
                self.assertFalse(tool.requires_confirmation)
                with self.assertRaises(mcp_server.ToolError):
                    tool.handler({"module": "toxo"}, Path("/workspace"))

    def test_extracting_figures_needs_a_lecture_or_a_deck(self) -> None:
        with self.assertRaises(mcp_server.ToolError):
            mcp_server.TOOLS_BY_NAME["extract_figures"].handler(
                {"module": "toxo"}, Path("/workspace")
            )

    def test_start_draft_advertises_the_verbatim_default_policy(self) -> None:
        tool = mcp_server.TOOLS_BY_NAME["start_draft"]
        schema = tool.schema()

        self.assertEqual(schema["properties"]["engine"]["default"], "notebooklm-raw")
        self.assertEqual(
            set(schema["properties"]["engine"]["enum"]),
            {"notebooklm", "notebooklm-raw", "whisper"},
        )
        self.assertIn(
            "Do not select notebooklm or whisper unless the user", tool.description
        )
        self.assertIn("default is notebooklm-raw", tool.description)

    def test_module_tools_advertise_optional_workspace_assertion(self) -> None:
        for name in MODULE_TOOLS:
            with self.subTest(tool=name):
                schema = mcp_server.TOOLS_BY_NAME[name].schema()
                self.assertIn("workspace", schema["properties"])
                self.assertNotIn("workspace", schema["required"])

    def test_unknown_method_returns_method_not_found(self) -> None:
        server, stream = make_server()
        server.handle(_request("not/a/method"))
        error = _lines(stream)[0]["error"]
        self.assertEqual(error["code"], -32601)

    def test_unknown_tool_name_returns_invalid_params(self) -> None:
        server, stream = make_server()
        server.handle(_request("tools/call", params=_call_params("no_such_tool")))
        error = _lines(stream)[0]["error"]
        self.assertEqual(error["code"], -32602)

    def test_every_response_line_is_one_complete_json_object(self) -> None:
        server, stream = make_server()
        server.handle(_request("initialize", request_id=1))
        server.handle(_request("ping", request_id=2))
        server.handle(_request("tools/list", request_id=3))
        lines = stream.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        for line in lines:
            json.loads(line)  # must not raise

    def test_every_response_carries_the_matching_id(self) -> None:
        server, stream = make_server()
        server.handle(_request("initialize", request_id="abc"))
        server.handle(_request("ping", request_id=42))
        ids = [line["id"] for line in _lines(stream)]
        self.assertEqual(ids, ["abc", 42])


class NotificationTests(unittest.TestCase):
    def test_a_message_with_no_id_produces_zero_output(self) -> None:
        server, stream = make_server()
        server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(stream.getvalue(), "")

    def test_a_tools_call_notification_never_invokes_the_handler(self) -> None:
        recorder = RecordingHandler()
        with patch.dict(
            mcp_server.TOOLS_BY_NAME,
            {"doctor": _tool_with_handler("doctor", recorder)},
        ):
            server, stream = make_server()
            server.handle(
                {
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": _call_params("doctor"),
                }
            )
        self.assertEqual(stream.getvalue(), "")
        self.assertEqual(recorder.calls, [])


def _tool_with_handler(name: str, handler: RecordingHandler) -> Tool:
    original = mcp_server.TOOLS_BY_NAME[name]
    return Tool(
        name=original.name,
        description=original.description,
        properties=original.properties,
        handler=handler,
        required=original.required,
        requires_confirmation=original.requires_confirmation,
    )


class ConfirmationGatingTests(unittest.TestCase):
    """The security-relevant part: destructive tools must never fire unconfirmed."""

    def _server_with_recorder(self, name: str) -> tuple[Server, io.StringIO, RecordingHandler]:
        recorder = RecordingHandler()
        patched = dict(mcp_server.TOOLS_BY_NAME)
        patched[name] = _tool_with_handler(name, recorder)
        patcher = patch.dict(mcp_server.TOOLS_BY_NAME, patched)
        patcher.start()
        self.addCleanup(patcher.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        workspace = Path(temporary.name)
        module = workspace / "modules" / "toxo"
        for folder in ("Lecture", "Questions", "Transcripts"):
            (module / folder).mkdir(parents=True)
        (module / "module.json").write_text(json.dumps({"schema_version": 1, "module_id": "toxo", "display_name": "Toxo", "notebook": {"id": "fixture"}}))
        stream = io.StringIO()
        server = Server(workspace=workspace, stdout=stream)
        return server, stream, recorder

    def _arguments_for(self, name: str) -> dict:
        # Minimal valid non-confirmation arguments per tool so refusal is
        # attributable to the confirmation gate, not to missing arguments.
        base = {"module": "toxo"}
        if name in MODULE_TOOLS_NEEDING_MANIFEST:
            base["manifest_path"] = "/tmp/manifest.json"
        if name == "upload_recordings":
            base["files"] = ["Corrosives.mp3"]
        if name == "stage_draft_part":
            base.update(part=1, parts=1, content="staged part")
        if name == "apply_review":
            base["content"] = "complete revision"
        return base

    def test_missing_confirmed_is_refused_without_invoking_handler(self) -> None:
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                server.handle(
                    _request(
                        "tools/call", params=_call_params(name, **self._arguments_for(name))
                    )
                )
                result = _lines(stream)[0]["result"]
                self.assertTrue(result["isError"])
                self.assertEqual(recorder.calls, [])

    def test_confirmed_false_is_refused_without_invoking_handler(self) -> None:
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                arguments = self._arguments_for(name)
                arguments["confirmed"] = False
                server.handle(
                    _request("tools/call", params=_call_params(name, **arguments))
                )
                result = _lines(stream)[0]["result"]
                self.assertTrue(result["isError"])
                self.assertEqual(recorder.calls, [])

    def test_confirmed_as_string_true_is_refused_without_invoking_handler(self) -> None:
        # "true" is truthy in many languages but must not satisfy `is True`.
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                arguments = self._arguments_for(name)
                arguments["confirmed"] = "true"
                server.handle(
                    _request("tools/call", params=_call_params(name, **arguments))
                )
                result = _lines(stream)[0]["result"]
                self.assertTrue(result["isError"])
                self.assertEqual(recorder.calls, [])

    def test_confirmed_as_integer_one_is_refused_without_invoking_handler(self) -> None:
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                arguments = self._arguments_for(name)
                arguments["confirmed"] = 1
                server.handle(
                    _request("tools/call", params=_call_params(name, **arguments))
                )
                result = _lines(stream)[0]["result"]
                self.assertTrue(result["isError"])
                self.assertEqual(recorder.calls, [])

    def test_confirmed_true_boolean_invokes_the_handler(self) -> None:
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                arguments = self._arguments_for(name)
                arguments["confirmed"] = True
                server.handle(
                    _request("tools/call", params=_call_params(name, **arguments))
                )
                result = _lines(stream)[0]["result"]
                self.assertFalse(result["isError"])
                self.assertEqual(len(recorder.calls), 1)

    def test_non_destructive_tools_do_not_require_confirmation(self) -> None:
        for name in NON_CONFIRMING_TOOLS:
            with self.subTest(tool=name):
                server, stream, recorder = self._server_with_recorder(name)
                arguments = self._arguments_for(name)
                server.handle(
                    _request("tools/call", params=_call_params(name, **arguments))
                )
                result = _lines(stream)[0]["result"]
                self.assertFalse(result["isError"])
                self.assertEqual(len(recorder.calls), 1)

    def test_confirming_tool_schema_requires_confirmed(self) -> None:
        for name in DESTRUCTIVE_TOOLS:
            with self.subTest(tool=name):
                schema = mcp_server.TOOLS_BY_NAME[name].schema()
                self.assertIn("confirmed", schema["properties"])
                self.assertIn("confirmed", schema["required"])

    def test_non_confirming_tool_schema_has_no_confirmed_field(self) -> None:
        for name in NON_CONFIRMING_TOOLS:
            with self.subTest(tool=name):
                schema = mcp_server.TOOLS_BY_NAME[name].schema()
                self.assertNotIn("confirmed", schema["properties"])
                self.assertNotIn("confirmed", schema["required"])


class ErrorHandlingTests(unittest.TestCase):
    def test_tool_error_produces_is_error_with_message_not_a_crash(self) -> None:
        def handler(arguments: dict, workspace: Path) -> str:
            raise ToolError("manifest_path is required")

        with patch.dict(
            mcp_server.TOOLS_BY_NAME,
            {"list_modules": _tool_with_handler("list_modules", handler)},
        ):
            server, stream = make_server()
            server.handle(
                _request("tools/call", params=_call_params("list_modules"))
            )
        result = _lines(stream)[0]["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["content"][0]["text"], "manifest_path is required")

    def test_unexpected_exception_is_reported_and_server_stays_alive(self) -> None:
        def exploding_handler(arguments: dict, workspace: Path) -> str:
            raise ValueError("boom")

        with patch.dict(
            mcp_server.TOOLS_BY_NAME,
            {"list_modules": _tool_with_handler("list_modules", exploding_handler)},
        ):
            server, stream = make_server()
            server.handle(
                _request(
                    "tools/call", request_id=1, params=_call_params("list_modules")
                )
            )
            first_result = _lines(stream)[0]["result"]
            self.assertTrue(first_result["isError"])
            self.assertIn("boom", first_result["content"][0]["text"])

            # The server must still serve the next request after a crash.
            server.handle(_request("ping", request_id=2))
        second = _lines(stream)[1]
        self.assertEqual(second["id"], 2)
        self.assertEqual(second["result"], {})


class ServeLoopTests(unittest.TestCase):
    def test_malformed_line_yields_parse_error_and_neighbors_still_served(
        self,
    ) -> None:
        lines = [
            json.dumps(_request("ping", request_id=1)),
            "",
            "not json at all {{{",
            json.dumps(_request("ping", request_id=2)),
        ]
        server, stream = make_server()
        server.serve(iter(f"{line}\n" for line in lines))
        responses = _lines(stream)
        self.assertEqual(len(responses), 3)
        self.assertEqual(responses[0]["id"], 1)
        self.assertEqual(responses[1]["error"]["code"], -32700)
        self.assertIsNone(responses[1]["id"])
        self.assertEqual(responses[2]["id"], 2)


class ArgumentValidationTests(unittest.TestCase):
    def test_module_helper_raises_on_missing_module(self) -> None:
        with self.assertRaises(ToolError):
            mcp_server._module({})

    def test_module_helper_raises_on_blank_module(self) -> None:
        with self.assertRaises(ToolError):
            mcp_server._module({"module": "   "})

    def _assert_requires_manifest(self, handler, arguments: dict) -> None:
        with patch.object(mcp_server, "_run") as run:
            with self.assertRaises(ToolError):
                handler(arguments, Path("/tmp/workspace"))
            run.assert_not_called()

    def test_apply_sync_requires_manifest_path(self) -> None:
        self._assert_requires_manifest(mcp_server._apply_sync, {"module": "toxo"})

    def test_apply_sync_rejects_blank_manifest_path(self) -> None:
        self._assert_requires_manifest(
            mcp_server._apply_sync, {"module": "toxo", "manifest_path": "   "}
        )

    def test_start_draft_requires_manifest_path(self) -> None:
        self._assert_requires_manifest(mcp_server._start_draft, {"module": "toxo"})

    def test_finalize_requires_manifest_path(self) -> None:
        self._assert_requires_manifest(mcp_server._finalize, {"module": "toxo"})


class FixedWorkspaceTests(unittest.TestCase):
    def test_saved_workspace_file_does_not_redirect_a_running_server(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "unrelated"
            selected.mkdir()
            stream = io.StringIO()
            server = Server(workspace=root, stdout=stream)
            (root / "workspace.json").write_text(json.dumps({"path": str(selected)}))
            server.handle(_request("tools/call", params={"name": "workspace_info", "arguments": {}}))
            reply = _lines(stream)[-1]["result"]
            self.assertEqual(json.loads(reply["content"][0]["text"])["workspace"], str(root))


if __name__ == "__main__":
    unittest.main()


class BatchRequestTests(unittest.TestCase):
    """A JSON-RPC batch is valid JSON but not a request object."""

    def test_a_batch_array_is_answered_rather_than_dropped(self) -> None:
        stdout = io.StringIO()
        server = mcp_server.Server(workspace=Path("/tmp"), stdout=stdout)
        server.serve(iter(['[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n']))
        replies = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]["error"]["code"], -32600)


class StructuredListingToolsTests(unittest.TestCase):
    """list_modules and list_lectures now return structured JSON, not prose.

    These exercise the real filesystem reads behind them -- no monkeypatching
    of module_registry.discover_modules -- against a temp workspace shaped
    like a real one: modules/<id>/module.json plus Lecture/, Transcripts/,
    Questions/ siblings.
    """

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmpdir.cleanup)
        self.workspace = Path(self._tmpdir.name)
        writer = patch("agy_writer.availability", return_value=mcp_server.agy_writer.Availability(None))
        writer.start()
        self.addCleanup(writer.stop)
        listing = patch("nlm_client.list_remote_sources", return_value=[])
        listing.start()
        self.addCleanup(listing.stop)

    def _make_module(
        self,
        module_id: str,
        display_name: str | None = None,
        emoji: str = "\U0001f9ea",
        language: str = "Egyptian Arabic",
    ) -> Path:
        root = self.workspace / "modules" / module_id
        for folder in ("Lecture", "Transcripts", "Questions"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": 1,
            "module_id": module_id,
            "display_name": display_name or module_id.title(),
            "notebook": {"id": f"uuid-{module_id}", "title": module_id.title(), "profile": None},
            "output": {"emoji": emoji, "language": language},
        }
        (root / "module.json").write_text(json.dumps(payload), encoding="utf-8")
        return root

    def _draft_fixture(
        self, title: str = "Corrosives"
    ) -> tuple[Path, Path, Path, str]:
        root = self._make_module("toxo")
        manifest_path = self.workspace / "corrosives-manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "title": title,
                    "read_part_bytes": 30_000,
                    "recording_sources": ["Corrosives.mp3"],
                    "exam_style_profile": {"mcq": {"options": {"count": 4}}},
                }
            ),
            encoding="utf-8",
        )
        original = "\n\n".join(SECTION_HEADINGS) + "\n\n" + (
            "Complete clinical explanation. " * 80
        )
        draft_path = root / "Transcripts" / f"{title} 🧪.md.draft.md"
        draft_path.write_text(original, encoding="utf-8")
        return root, manifest_path, draft_path, original

    def _draft_tool_result(self, name: str, **arguments: object) -> dict:
        stream = io.StringIO()
        server = mcp_server.Server(workspace=self.workspace, stdout=stream)
        server.handle(_request("tools/call", params=_call_params(name, **arguments)))
        return _lines(stream)[0]["result"]

    def _draft_arguments(self, manifest_path: Path, **extra: object) -> dict:
        arguments: dict[str, object] = {
            "module": "toxo",
            "manifest_path": str(manifest_path),
        }
        arguments.update(extra)
        return arguments

    def _stage_part(
        self, manifest_path: Path, part: int, parts: int, content: str
    ) -> dict:
        return json.loads(
            mcp_server._stage_draft_part(
                self._draft_arguments(
                    manifest_path, part=part, parts=parts, content=content
                ),
                self.workspace,
            )
        )

    def _large_verbatim(self, root: Path) -> tuple[Path, str]:
        body = "الدكتور شرح تفاصيل الحالة الطبية، وذكر العلامات والعلاج خطوة بخطوة.\n" * 600
        path = root / "Verbatim" / "Corrosives.verbatim.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        header = (
            "# Verbatim transcript — Corrosives\n\n"
            "> Raw auto-detected speech from `Corrosives.mp3`, read back from "
            "NotebookLM's own transcript of the audio (`notebooklm-raw:test`), "
            "with no AI processing applied. Nothing here has been summarised or "
            "reordered.\n\n"
        )
        path.write_text(header + body, encoding="utf-8")
        return path, body

    def _137kb_verbatim(self, root: Path, title: str = "Corrosives") -> Path:
        header = f"# Verbatim transcript — {title}\n\n> Complete recording.\n\n"
        paragraphs = []
        byte_count = len(header.encode("utf-8"))
        while byte_count < 137_000:
            paragraph = f"نقطة{len(paragraphs):04d} الدكتور شرح تفاصيل الحالة الطبية والعلامات والعلاج خطوة بخطوة.\n\n"
            paragraphs.append(paragraph)
            byte_count += len(paragraph.encode("utf-8"))
        text = (header + "".join(paragraphs)).encode("utf-8")[:137_000].decode("utf-8", errors="ignore")
        text += "x" * (137_000 - len(text.encode("utf-8")))
        path = root / "Verbatim" / f"{title}.verbatim.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def _complete_revision(self, guide: str) -> str:
        return "\n\n".join(
            (
                SECTION_HEADINGS[0],
                guide,
                SECTION_HEADINGS[1],
                "Important clinical points.",
                SECTION_HEADINGS[2],
                "No MCQs.",
                SECTION_HEADINGS[3],
                "No written questions.",
                SECTION_HEADINGS[4],
                "No clinical cases.",
            )
        ) + "\n"

    def _stage_revision(
        self, manifest_path: Path, revision: str, parts: int
    ) -> None:
        step = (len(revision) + parts - 1) // parts
        for part in range(parts, 0, -1):
            start = (part - 1) * step
            end = min(part * step, len(revision))
            self._stage_part(manifest_path, part, parts, revision[start:end])

    def _begin_fixture(self, sources: tuple[str, ...] = ("Corrosives.mp3",)) -> Path:
        root = self._make_module("toxo", display_name="Toxicology")
        metadata = json.loads((root / "module.json").read_text(encoding="utf-8"))
        metadata["aliases"] = ["Poisons"]
        (root / "module.json").write_text(json.dumps(metadata), encoding="utf-8")
        for source in sources:
            (root / "Lecture" / source).write_bytes(b"audio")
        (root / "Lecture" / "Corrosives.pdf").write_bytes(b"slides")
        figures = root / "Transcripts" / "Figures" / "Corrosives"
        figures.mkdir(parents=True, exist_ok=True)
        figure_manifest(root / "Lecture/Corrosives.pdf", figures)
        from slide_figures import SELECTION_VERSION, SELECTION_VERSION_NAME
        (figures / SELECTION_VERSION_NAME).write_text(SELECTION_VERSION, encoding="utf-8")
        (root / "Questions" / "Final 2023.txt").write_text(
            "1. Corrosives cause:\na. Burns\nb. Fever\nc. Cough\nd. Rash\n",
            encoding="utf-8",
        )
        return root

    @contextmanager
    def _begin_transcription(self) -> Iterator[None]:
        run = subprocess.run

        def transcribe(command: list[str], **kwargs: object) -> subprocess.CompletedProcess:
            if "--build-exam-index" in command:
                return run(command, **kwargs)
            self.assertEqual(command[command.index("--engine") + 1], "notebooklm-raw")
            output = Path(command[command.index("--output") + 1])
            self.assertFalse(output.exists(), "completed recordings must not be fetched again")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("كلام الدكتور بالتفصيل", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, stdout="Done", stderr="")

        uploaded = [_remote(path.name, "audio") for path in
                    (self.workspace / "modules" / "toxo" / "Lecture").glob("*.mp3")]
        with _notebook_sources(uploaded), patch("subprocess.run", side_effect=transcribe):
            yield

    def test_finished_lecture_requires_explicit_redo_and_keeps_artifacts(self) -> None:
        root = self._begin_fixture()
        final = root / "Transcripts" / "Corrosives & Burns 🧪.md"
        final.write_text("# Existing student transcript", encoding="utf-8")
        for tool in ("begin_lecture", "prepare_manifest"):
            with self.subTest(tool=tool), _notebook_sources([]):
                result = self._draft_tool_result(tool, module="toxo", lecture="Corrosives")
            self.assertTrue(result["isError"])
            self.assertIn("pass redo=true", result["content"][0]["text"])
        self.assertEqual(final.read_text(encoding="utf-8"), "# Existing student transcript")
        self.assertFalse((root / ".transcriber-cache" / "manifests").exists())
        self.assertFalse((root / ".transcriber-cache" / "runs").exists())

    def test_redo_reuses_verbatim_archives_stale_work_and_continue_resumes_its_draft(self) -> None:
        root = self._begin_fixture()
        final = root / "Transcripts" / "Corrosives & Burns 🧪.md"
        final.write_text("# Existing student transcript", encoding="utf-8")
        (root / "Lecture" / "Corrosives.pdf").unlink()
        verbatim, body = self._large_verbatim(root)
        draft = root / "Transcripts" / "Corrosives 🧪.md.draft.md"
        draft.write_text("stale draft", encoding="utf-8")
        staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
        staged.mkdir(parents=True)
        (staged / "parts.txt").write_text("2", encoding="utf-8")
        (staged / "part-1.md").write_text("stale part", encoding="utf-8")
        arguments = {"module": "toxo", "lecture": "Corrosives", "redo": True}
        # Any nlm or launcher subprocess here would repeat completed work.
        with patch("subprocess.run", side_effect=AssertionError("NotebookLM must not be called")):
            from exam_index import build_index
            (root / "Questions" / "exam-index.json").write_text(json.dumps(build_index(root / "Questions", "toxo")), encoding="utf-8")
            first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
            manifest = Path(first["manifest_path"])
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertTrue(payload["redo"])
            self.assertEqual(payload["replaces_transcript"], str(final))
            self.assertEqual(first["text"], verbatim.read_text(encoding="utf-8")[:len(first["text"])])
            self.assertFalse(draft.exists())
            self.assertFalse(staged.exists())
            archived = root / ".transcriber-cache" / "previous-drafts"
            self.assertEqual([path.read_text(encoding="utf-8") for path in archived.rglob("part-1.md")], ["stale part"])
            self.assertEqual([path.read_text(encoding="utf-8") for path in archived.rglob("draft-*")], ["stale draft"])
            self._stage_part(manifest, 1, first["write_parts"] + 1, "current redo part")
            mcp_server._begin_lecture({**arguments, "_pipeline_run": True}, self.workspace)
            self.assertEqual((staged / "part-1.md").read_text(encoding="utf-8"), "current redo part")
            revised = self._complete_revision(body)
            self._stage_revision(manifest, revised, first["write_parts"] + 1)
            mcp_server._apply_review(self._draft_arguments(manifest, from_parts=True), self.workspace)
            (root / "Lecture" / "Corrosives.mp3").unlink()
            second = json.loads(mcp_server._begin_lecture({**arguments, "_pipeline_run": True}, self.workspace))
            prepared = json.loads(mcp_server._prepare_manifest(arguments, self.workspace))
        self.assertEqual(second["route"], "draft")
        self.assertEqual(draft.read_text(encoding="utf-8"), revised)
        self.assertEqual(prepared["manifest_path"], str(manifest))
        self.assertEqual(len(list(archived.iterdir())), 1)
        self.assertEqual(final.read_text(encoding="utf-8"), "# Existing student transcript")

    def test_begin_without_papers_continues_with_explicit_absence(self) -> None:
        root = self._begin_fixture()
        (root / "Questions" / "Final 2023.txt").unlink()
        (root / "Questions" / "Final 2023.pdf").unlink(missing_ok=True)
        self._large_verbatim(root)
        with patch("subprocess.run", side_effect=AssertionError("No engine call is needed")):
            payload = json.loads(mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, self.workspace))
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(payload["exam_index"]["entries"], 0)
        self.assertEqual(payload["exam_index"]["status"], "no-questions")
        self.assertTrue(payload["exam_index"]["hint"])
        self.assertIn("[IMP]", payload["contract"])
        self.assertIn("never invent", payload["next"])
        modules = json.loads(mcp_server._list_modules({}, self.workspace))["modules"]
        lectures = json.loads(mcp_server._list_lectures({"module": "toxo"}, self.workspace))
        self.assertEqual(modules[0]["questions"], "missing")
        self.assertEqual(lectures["questions"], "missing")
        with self.assertRaisesRegex(ToolError, "No extractable question files"):
            mcp_server._build_exam_index({"module": "toxo"}, self.workspace)

    def test_begin_attempts_preparation_and_refuses_an_unreadable_required_paper(self) -> None:
        root = self._begin_fixture()
        (root / "Questions" / "Final 2023.txt").unlink()
        (root / "Questions" / "Final 2023.pdf").write_bytes(b"unreadable scan")
        self._large_verbatim(root)
        with patch.object(mcp_server, "_build_exam_index", side_effect=ToolError("Final 2023.pdf: OCR failed")) as build:
            with self.assertRaisesRegex(ToolError, "Final 2023.pdf: OCR failed"):
                mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, self.workspace)
        build.assert_called_once()
        self.assertFalse((root / "Questions" / "exam-index.json").exists())
        modules = json.loads(mcp_server._list_modules({}, self.workspace))["modules"]
        self.assertEqual(modules[0]["questions"], "needs-conversion")

    def test_library_reports_indexed_question_bank(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        modules = json.loads(mcp_server._list_modules({}, self.workspace))["modules"]
        lectures = json.loads(mcp_server._list_lectures({"module": "toxo"}, self.workspace))
        self.assertEqual(modules[0]["questions"], "indexed")
        self.assertEqual(lectures["questions"], "indexed")

    def test_default_begin_returns_137kb_verbatim_in_one_part(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        text = "ع" * 68_000 + "x" * 1_000
        self.assertEqual(len(text.encode("utf-8")), 137_000)
        path = root / "Verbatim" / "Corrosives.verbatim.md"
        path.parent.mkdir()
        path.write_text(text, encoding="utf-8")
        with patch("subprocess.run", side_effect=AssertionError("Completed evidence must be reused")):
            result = self._draft_tool_result("begin_lecture", module="toxo", lecture="Corrosives")
        self.assertFalse(result["isError"], result)
        reply = result["content"][0]["text"]
        payload = json.loads(reply)
        self.assertEqual(payload["parts"], 1)
        self.assertEqual(payload["text"], text)
        self.assertLessEqual(len(reply.encode("utf-8")), 240_000)
        self.assertIn("find_questions", payload["next"])

    def test_server_byte_limit_preserves_json_escaping_and_guide_alignment(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        text = "ع" * 16_000 + "\\" * 20_000 + '\n\t"' * 10_000
        path = root / "Verbatim" / "Corrosives.verbatim.md"
        path.parent.mkdir()
        path.write_text(text, encoding="utf-8")
        stream = io.StringIO()
        server = Server(workspace=self.workspace, stdout=stream, max_part_bytes=45_000)
        server.handle(_request("tools/call", params=_call_params("begin_lecture", module="toxo", lecture="Corrosives")))
        result = _lines(stream)[-1]["result"]
        self.assertFalse(result["isError"], result)
        first = json.loads(result["content"][0]["text"])
        self.assertGreater(first["parts"], 1)
        chunks = [first["text"]]
        self.assertLessEqual(len(result["content"][0]["text"].encode("utf-8")), 45_000)
        arguments = {"module": "toxo", "manifest_path": first["manifest_path"]}
        for part in range(2, first["parts"] + 1):
            server.handle(_request("tools/call", params=_call_params("read_draft", **arguments, part=part)))
            reply = _lines(stream)[-1]["result"]["content"][0]["text"]
            self.assertLessEqual(len(reply.encode("utf-8")), 45_000)
            chunks.append(json.loads(reply)["content"])
        self.assertEqual("".join(chunks), text)
        server.handle(_request("tools/call", params=_call_params("stage_draft_part", **arguments, part=1, parts=first["parts"] + 1, content="شرح قصير")))
        staged = json.loads(_lines(stream)[-1]["result"]["content"][0]["text"])
        self.assertEqual(staged["short_guide_parts"][0]["verbatim_chars"], len("".join(chunks[0].split())))
        self.assertEqual(staged["short_guide_parts"][0]["required_chars"], (len("".join(chunks[0].split())) + 1) // 2)

    def test_137kb_single_read_has_eight_stable_write_segments_and_segment_floors(self) -> None:
        # Gemini truncated a whole-guide stage call after a successful one-part read.
        root = self._begin_fixture()
        (root / "Lecture" / "Corrosives.pdf").unlink()
        path = self._137kb_verbatim(root)
        text = path.read_text(encoding="utf-8")
        first = json.loads(mcp_server._begin_lecture(
            {"module": "toxo", "lecture": "Corrosives"}, self.workspace
        ))
        self.assertEqual(first["parts"], 1)
        self.assertEqual(first["text"], text)
        self.assertEqual(first["write_parts"], 8)
        self.assertLess(len(json.dumps(first["write_segments"], ensure_ascii=False).encode("utf-8")), 3_000)
        arguments = self._draft_arguments(Path(first["manifest_path"]))
        reread = json.loads(mcp_server._read_draft({**arguments, "_write_part_bytes": 9_000}, self.workspace))
        self.assertEqual(reread["write_segments"], first["write_segments"])
        repeated = json.loads(mcp_server._begin_lecture(
            {"module": "toxo", "lecture": "Corrosives"}, self.workspace
        ))
        self.assertEqual(repeated["write_segments"], first["write_segments"])
        words = text.split()
        manifest = Path(first["manifest_path"])
        total = first["write_parts"] + 1
        previous_end = 0
        for boundary in first["write_segments"]:
            self.assertEqual(boundary["start_word"], previous_end + 1)
            segment_words = words[previous_end:boundary["end_word"]]
            self.assertEqual(boundary["first"], " ".join(segment_words[:6])[:80])
            self.assertEqual(boundary["last"], " ".join(segment_words[-6:])[-80:])
            expected_chars = len("".join(segment_words))
            short = self._stage_part(manifest, boundary["part"], total, "ش")
            self.assertEqual(short["short_guide_parts"], [{
                "part": boundary["part"], "guide_chars": 1,
                "verbatim_chars": expected_chars, "required_chars": (expected_chars + 1) // 2,
            }])
            self.assertEqual(short["write_segment"], boundary)
            self.assertIn(f"write segment {boundary['part']}", short["next"])
            full = self._stage_part(manifest, boundary["part"], total, " ".join(segment_words) + "\n")
            self.assertNotIn("short_guide_parts", full)
            previous_end = boundary["end_word"]
        self.assertEqual(previous_end, len(words))
        questions = self._stage_part(manifest, total, total, "Sections 2–5")
        self.assertNotIn("short_guide_parts", questions)
        self.assertNotIn("guide_chars_so_far", questions)

    def test_server_write_budget_is_independent_of_read_budget_and_persisted(self) -> None:
        root, manifest, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        self._large_verbatim(root)
        arguments = self._draft_arguments(manifest)
        stream = io.StringIO()
        server = Server(workspace=self.workspace, stdout=stream, max_part_bytes=45_000, write_part_bytes=9_000)
        server.handle(_request("tools/call", params=_call_params("read_draft", **arguments)))
        result = _lines(stream)[-1]["result"]
        self.assertFalse(result["isError"], result)
        payload = json.loads(result["content"][0]["text"])
        self.assertGreater(payload["write_parts"], payload["parts"])
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["write_part_bytes"], 9_000)
        resumed = json.loads(mcp_server._read_draft(arguments, self.workspace))
        self.assertEqual(resumed["write_segments"], payload["write_segments"])
        self.assertEqual(resumed["parts"], payload["parts"])

    def test_legacy_staged_read_alignment_is_archived_even_with_equal_write_part_count(self) -> None:
        root, manifest, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        path, _ = self._large_verbatim(root)
        text = path.read_text(encoding="utf-8")
        manifest_payload = json.loads(manifest.read_text(encoding="utf-8"))
        manifest_payload.update(read_part_bytes=18_000, write_part_bytes=18_000)
        manifest.write_text(json.dumps(manifest_payload), encoding="utf-8")
        from draft_segments import write_segments
        read_parts = mcp_server._text_parts(text, 18_000)
        self.assertEqual(len(read_parts), len(write_segments(text)))
        self.assertNotEqual(read_parts[0], write_segments(text)[0])
        staged = root / ".transcriber-cache" / "staged-drafts" / draft_path.name
        staged.mkdir(parents=True)
        (staged / "parts.txt").write_text(str(len(read_parts) + 1), encoding="ascii")
        (staged / "part-1.md").write_text("old guide", encoding="utf-8")
        reread = json.loads(mcp_server._read_draft(self._draft_arguments(manifest), self.workspace))
        self.assertEqual(reread["write_alignment"], "write")
        self.assertIn("stale_staged_draft", reread)
        self.assertFalse(staged.exists())
        self.assertEqual(
            [path.read_text(encoding="utf-8") for path in (root / ".transcriber-cache" / "stale-staged").rglob("part-1.md")],
            ["old guide"],
        )
        payload = self._stage_part(manifest, 1, len(read_parts) + 1, "ش")
        self.assertEqual(payload["short_guide_parts"][0]["verbatim_chars"], len("".join(write_segments(text)[0].split())))
        self.assertIn("write segment 1", payload["next"])

    def test_legacy_read_budget_uses_reserved_headroom_for_new_boundary_metadata(self) -> None:
        root, manifest, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        self._large_verbatim(root)
        arguments = self._draft_arguments(manifest)
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        # Historical handoffs reserved 16 KB but did not carry a write plan.
        old_budget = mcp_server._read_part_budget(context, arguments, mcp_server._paging_metadata(context, self.workspace))
        staged = root / ".transcriber-cache" / "staged-drafts" / draft_path.name
        staged.mkdir(parents=True)
        (staged / "parts.txt").write_text("2", encoding="ascii")
        (staged / "part-1.md").write_text("old guide", encoding="utf-8")
        reread = json.loads(mcp_server._read_draft(arguments, self.workspace))
        self.assertEqual(reread["write_alignment"], "write")
        self.assertIn("stale_staged_draft", reread)
        self.assertEqual(json.loads(manifest.read_text(encoding="utf-8"))["read_part_bytes"], old_budget)

    def test_conjunctiva_six_legacy_parts_and_137kb_verbatim_start_fresh_write_segments(self) -> None:
        # Oct 1 ophtha failure: old 50 KB read layout retained six staged parts,
        # while begin_lecture advertised a single new read part and parts=2.
        root = self._make_module("ophtha", display_name="Ophthalmology")
        (root / "Lecture" / "Conjunctiva.mp3").write_bytes(b"audio")
        verbatim = self._137kb_verbatim(root, "Conjunctiva")
        draft = root / "Transcripts" / "Conjunctiva 🧪.md.draft.md"
        staged = root / ".transcriber-cache" / "staged-drafts" / draft.name
        staged.mkdir(parents=True)
        (staged / "parts.txt").write_text("6", encoding="ascii")
        old_parts = {f"part-{part}.md": f"Good old guide part {part}" for part in range(1, 7)}
        for name, content in old_parts.items():
            (staged / name).write_text(content, encoding="utf-8")
        with patch("subprocess.run", side_effect=AssertionError("Completed evidence must be reused")):
            result = self._draft_tool_result("begin_lecture", module="ophtha", lecture="Conjunctiva")
        self.assertFalse(result["isError"], result)
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(verbatim.stat().st_size, 137_000)
        self.assertEqual(payload["parts"], 1)
        self.assertEqual(payload["write_parts"], 8)
        self.assertEqual(payload["write_alignment"], "write")
        self.assertEqual(payload["text"], verbatim.read_text(encoding="utf-8"))
        self.assertEqual(payload["stale_staged_draft"], "moved aside: 6 parts from an older layout")
        self.assertFalse(staged.exists())
        archived = root / ".transcriber-cache" / "stale-staged"
        self.assertEqual({path.name: path.read_text(encoding="utf-8") for path in archived.rglob("part-*.md")}, old_parts)
        self.assertEqual([path.read_text(encoding="ascii") for path in archived.rglob("parts.txt")], ["6"])
        total = payload["write_parts"] + 1
        self.assertIn(f"parts={total},", payload["next"])
        accepted = json.loads(mcp_server._stage_draft_part({
            "module": "ophtha", "manifest_path": payload["manifest_path"],
            "part": 1, "parts": total, "content": "Current guide\n",
        }, self.workspace))
        self.assertEqual(accepted["total_parts"], total)
        self.assertEqual((staged / "parts.txt").read_text(encoding="ascii"), str(total))
        repeated = json.loads(mcp_server._begin_lecture({"module": "ophtha", "lecture": "Conjunctiva"}, self.workspace))
        self.assertNotIn("stale_staged_draft", repeated)
        self.assertEqual(len(list(archived.iterdir())), 1)

    def test_matching_layout_keeps_good_parts_and_resumes_after_short_part(self) -> None:
        root = self._begin_fixture()
        self._137kb_verbatim(root)
        arguments = {"module": "toxo", "lecture": "Corrosives"}
        first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        manifest = Path(first["manifest_path"])
        words = first["text"].split()
        boundary = first["write_segments"][0]
        good_guide = " ".join(words[:boundary["end_word"]]) + "\n"
        total = first["write_parts"] + 1
        good = self._stage_part(manifest, 1, total, good_guide)
        self.assertNotIn("short_guide_parts", good)
        short = self._stage_part(manifest, 2, total, "ش")
        self.assertIn("short_guide_parts", short)
        context = mcp_server._resolve_draft_context(self._draft_arguments(manifest), self.workspace)
        staged = root / ".transcriber-cache" / "staged-drafts" / context.path.name
        before = {path.name: path.read_bytes() for path in staged.iterdir()}
        resumed = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        self.assertNotIn("stale_staged_draft", resumed)
        self.assertEqual(resumed["write_segments"], first["write_segments"])
        self.assertEqual({path.name: path.read_bytes() for path in staged.iterdir()}, before)
        self.assertFalse((root / ".transcriber-cache" / "stale-staged").exists())
        self.assertIn(f"parts={total},", resumed["next"])
        next_boundary = resumed["write_segments"][1]
        repaired = self._stage_part(manifest, 2, total, " ".join(words[next_boundary["start_word"] - 1:next_boundary["end_word"]]) + "\n")
        self.assertNotIn("short_guide_parts", repaired)
        self.assertEqual((staged / "part-1.md").read_text(encoding="utf-8"), good_guide)

    def test_mismatching_recorded_layout_is_archived_and_advertised_total_is_accepted(self) -> None:
        for mismatch in ("alignment", "parts", "segment_bytes", "boundaries", "content", "parts.txt", "invalid_json"):
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as workspace:
                self.workspace = Path(workspace)
                root = self._begin_fixture()
                verbatim = self._137kb_verbatim(root)
                arguments = {"module": "toxo", "lecture": "Corrosives"}
                first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
                manifest = Path(first["manifest_path"])
                total = first["write_parts"] + 1
                self._stage_part(manifest, 1, total, "Good staged guide\n")
                context = mcp_server._resolve_draft_context(self._draft_arguments(manifest), self.workspace)
                staged = root / ".transcriber-cache" / "staged-drafts" / context.path.name
                layout_path = staged / "layout.json"
                layout = json.loads(layout_path.read_text(encoding="utf-8"))
                if mismatch == "alignment":
                    layout["alignment"] = "read"
                elif mismatch == "parts":
                    layout["parts"] += 1
                elif mismatch == "segment_bytes":
                    layout["segment_bytes"] = 0
                elif mismatch == "boundaries":
                    layout["segments"][0]["end_word"] += 1
                elif mismatch == "content":
                    text = verbatim.read_text(encoding="utf-8")
                    # Same byte count, word ordinals and anchors; fingerprints must detect it.
                    verbatim.write_text(text.replace("نقطة0001", "نقطة9999", 1), encoding="utf-8")
                elif mismatch == "parts.txt":
                    (staged / "parts.txt").write_text("6", encoding="ascii")
                layout_path.write_text("{" if mismatch == "invalid_json" else json.dumps(layout), encoding="utf-8")
                resumed = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
                self.assertIn("stale_staged_draft", resumed)
                self.assertEqual(resumed["write_alignment"], "write")
                if mismatch == "content":
                    self.assertEqual(resumed["write_segments"], first["write_segments"])
                self.assertFalse(staged.exists())
                archived = root / ".transcriber-cache" / "stale-staged"
                self.assertEqual(len(list(archived.iterdir())), 1)
                self.assertEqual([path.read_text(encoding="utf-8") for path in archived.rglob("part-1.md")], ["Good staged guide\n"])
                fresh_total = resumed["write_parts"] + 1
                self.assertIn(f"parts={fresh_total},", resumed["next"])
                accepted = self._stage_part(manifest, 1, fresh_total, "Fresh guide\n")
                self.assertEqual(accepted["total_parts"], fresh_total)
                self.assertNotIn("stale_staged_draft", json.loads(mcp_server._begin_lecture(arguments, self.workspace)))
                self.assertEqual(len(list(archived.iterdir())), 1)

    def test_begin_extracts_figures_once_and_returns_real_links(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        self._large_verbatim(root)
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        directory = root / "Transcripts" / "Figures" / "Corrosives"
        from slide_figures import SELECTION_VERSION, SELECTION_VERSION_NAME
        (directory / SELECTION_VERSION_NAME).write_text("1", encoding="utf-8")

        def render(command, **kwargs):
            self.assertIn("--extract-figures", command)
            (directory / "page-001.png").write_bytes(b"rendered slide")
            (directory / "slides.txt").write_text("Thyroxine hormone physiology", encoding="utf-8")
            figure_manifest(root / "Lecture/Corrosives.pdf", directory, (1,))
            (directory / SELECTION_VERSION_NAME).write_text(SELECTION_VERSION, encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, stdout="One figure", stderr="")

        arguments = {"module": "toxo", "lecture": "Corrosives"}
        with patch("subprocess.run", side_effect=render):
            first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        with patch("subprocess.run", side_effect=AssertionError("Figure was re-rendered")):
            second = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        self.assertEqual(first["figures"], second["figures"])
        figure = first["figures"]["figures"][0]
        self.assertTrue(Path(figure["path"]).is_file())
        self.assertIn("page-001.png", figure["markdown"])
        self.assertEqual(first["figures"]["status"], "ready")

    def test_figure_failure_does_not_block_begin(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        self._large_verbatim(root)
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        (root / "Transcripts" / "Figures" / "Corrosives" / "figures.json").unlink()
        with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 1, stdout="", stderr="poppler failed")):
            payload = json.loads(mcp_server._begin_lecture({"module": "toxo", "lecture": "Corrosives"}, self.workspace))
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(payload["figures"]["status"], "error")
        self.assertIn("poppler failed", payload["figures"]["error"])

    def test_find_questions_ranks_complete_entries_from_evidence_and_preserves_years(self) -> None:
        from exam_index import build_index, write_index

        root = self._make_module("toxo")
        (root / "Lecture" / "Introduction.mp3").write_bytes(b"audio")
        (root / "Verbatim").mkdir()
        (root / "Verbatim" / "Introduction.verbatim.md").write_text("Thyroxine affects thyroid metabolism. Thyroid thyroxine physiology.", encoding="utf-8")
        dated = "1. Thyroid thyroxine excess causes:\na. Tachycardia\nb. Fever\nc. Cough\nd. Rash\n"
        for year in (2022, 2023):
            (root / "Questions" / f"Final {year}.txt").write_text(dated, encoding="utf-8")
        (root / "Questions" / "Bank.txt").write_text("1. TSH concentration decreases in:\na. Thyroid disease\nb. Fever\nc. Cough\nd. Rash\n2. Firearm entrance wounds show:\na. Abrasion collar\nb. Fever\nc. Cough\nd. Rash\n", encoding="utf-8")
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        index = root / "Questions" / "exam-index.json"
        snapshot = index.read_bytes(), index.stat().st_mtime_ns
        with patch("subprocess.run", side_effect=AssertionError("Question search is local and read-only")):
            payload = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Introduction", "terms": ["TSH", "2027"]}, self.workspace))
        self.assertEqual(payload["total"], 3)
        self.assertEqual(payload["matched"], 2)
        self.assertEqual(payload["returned"], 2)
        by_years = {tuple(entry["years"]): entry for entry in payload["entries"]}
        self.assertEqual(by_years[(2022, 2023)]["stem"], "Thyroid thyroxine excess causes")
        self.assertEqual(by_years[(2022, 2023)]["badges"], ["**[Past Exams - 2022]**", "**[Past Exams - 2023]**"])
        self.assertEqual(by_years[()]["badge"], "**[Question Bank]**")
        for entry in payload["entries"]:
            self.assertEqual(len(entry["options"]), 4)
            self.assertIn("answer", entry)
            self.assertTrue(entry["source"])
            self.assertNotIn(2027, entry["years"])
        self.assertEqual(snapshot, (index.read_bytes(), index.stat().st_mtime_ns))
        (root / "Verbatim" / "Introduction.verbatim.md").unlink()
        figures = root / "Transcripts" / "Figures" / "Introduction"
        figures.mkdir(parents=True)
        (figures / "slides.txt").write_text("Thyroid thyroxine physiology.", encoding="utf-8")
        from_slides = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Introduction", "terms": ["TSH", "2027"]}, self.workspace))
        self.assertEqual({entry["id"]: {key: value for key, value in entry.items() if key != "score"} for entry in from_slides["entries"]},
                         {entry["id"]: {key: value for key, value in entry.items() if key != "score"} for entry in payload["entries"]})

    def test_find_questions_caps_complete_entries_and_reports_omissions(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        paper = root / "Questions" / "Final 2023.txt"
        paper.write_text("\n".join(
            f"{number + 1}. Corrosives mechanism {number}{'x' * 300_000 if number == 0 else ''}\n"
            "a. Irritation\nb. Necrosis\nc. Fever\nd. Rash\n"
            for number in range(60)
        ), encoding="utf-8")
        for path in (root / "Questions").glob("*.txt"):
            if path != paper:
                path.unlink()
        index = build_index(root / "Questions", "toxo")
        question = next(iter(index["questions"].values()))
        write_index(index, root / "Questions")
        reply = mcp_server._find_questions({"module": "toxo", "lecture": "Corrosives"}, self.workspace)
        payload = json.loads(reply)
        self.assertEqual((payload["total"], payload["matched"], payload["returned"], payload["omitted"]), (60, 60, 50, 10))
        self.assertLessEqual(len(reply.encode("utf-8")), mcp_server.DEFAULT_MAX_PART_BYTES)
        self.assertFalse(any("x" * 100 in entry["stem"] for entry in payload["entries"]))
        for entry in payload["entries"]:
            self.assertEqual(entry["options"], question["options"])
            self.assertEqual(entry["answer"], question["answer"])

    def test_find_questions_without_index_returns_empty_entries_and_imp_contract(self) -> None:
        self._make_module("toxo")
        payload = json.loads(mcp_server._find_questions({"module": "toxo", "lecture": "Corrosives"}, self.workspace))
        self.assertEqual(payload["entries"], [])
        self.assertEqual(payload["returned"], 0)
        self.assertIn("[IMP]", payload["contract"])
        self.assertTrue(payload["hint"])

    def test_redo_uses_header_recordings_when_audio_and_manifest_are_gone(self) -> None:
        from exam_index import build_index, write_index

        root = self._begin_fixture()
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        self._large_verbatim(root)
        (root / "Lecture" / "Corrosives.mp3").unlink()
        old = root / "Transcripts" / "Corrosives & Burns 🧪.md"
        old_text = "# Student transcript\n\n> **الملفات المعتمدة:** `Corrosives.mp3`\n\n---\nComplete explanation"
        old.write_text(old_text, encoding="utf-8")
        arguments = {"module": "toxo", "lecture": old.stem, "redo": True}
        with patch("subprocess.run", side_effect=AssertionError("Existing verbatim must avoid NotebookLM")):
            payload = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
            prepared = json.loads(mcp_server._prepare_manifest(arguments, self.workspace))
            for engine in ("notebooklm-raw", "notebooklm"):
                started = json.loads(mcp_server._start_draft({"module": "toxo", "manifest_path": payload["manifest_path"], "engine": engine}, self.workspace))
                self.assertEqual(started["route"], "verbatim")
                self.assertTrue(all(Path(path).is_file() for path in started["paths"]))
        manifest = json.loads(Path(payload["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual(manifest["replaces_transcript"], str(old))
        self.assertEqual(prepared["manifest_path"], payload["manifest_path"])
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(old.read_text(encoding="utf-8"), old_text)

    def test_begin_fresh_lecture_returns_default_verbatim_and_contract(self) -> None:
        root = self._begin_fixture()
        with self._begin_transcription():
            result = self._draft_tool_result("begin_lecture", module="Toxicology", lecture="Corrosives 🧪")
        self.assertFalse(result["isError"])
        payload = json.loads(result["content"][0]["text"])
        manifest = json.loads(Path(payload["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual((payload["module"], payload["lecture"]), ("toxo", "Corrosives"))
        self.assertEqual(manifest["recording_sources"], ["Corrosives.mp3"])
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual((payload["part"], payload["parts"]), (1, 1))
        self.assertEqual(payload["text"], "كلام الدكتور بالتفصيل")
        self.assertTrue(payload["contract"])
        self.assertEqual(payload["exam_index"], {
            "sources": 1, "questions": 1, "dated": 1, "bank_only": 0, "damaged": 0,
        })
        self.assertEqual(payload["path"], str(root / "Verbatim" / "Corrosives.verbatim.md"))
        self.assertIn("stage_draft_part", payload["next"])
        self.assertIn(payload["manifest_path"], payload["next"])

    def test_begin_existing_draft_returns_first_part_without_transcription(self) -> None:
        root = self._begin_fixture()
        original = "Complete explanation.\n" * 2_000
        draft = root / "Transcripts" / "Corrosives 🧪.md.draft.md"
        draft.write_text(original, encoding="utf-8")
        with _notebook_sources([]):
            payload = json.loads(mcp_server._begin_lecture(
                {"module": "toxo", "lecture": "Corrosives"}, self.workspace
            ))
        expected = json.loads(mcp_server._read_draft(self._draft_arguments(Path(payload["manifest_path"])), self.workspace))
        self.assertEqual(payload["route"], "draft")
        self.assertEqual(payload["text"], expected["content"])
        self.assertEqual(payload["parts"], expected.get("parts", 1))
        self.assertEqual(payload["part"], 1)
        self.assertTrue(payload["contract"])
        self.assertEqual(payload["parts"], 1)
        self.assertIn("stage_draft_part", payload["next"])
        self.assertEqual(draft.read_text(encoding="utf-8"), original)
        self.assertFalse((root / "Verbatim").exists())

    def test_begin_existing_boys_girls_verbatims_preserves_grouping_and_attribution(self) -> None:
        sources = ("Corrosives boys part 1.mp3", "Corrosives boys part 2.mp3", "Corrosives girls.mp3")
        root = self._begin_fixture(sources)
        (root / "Verbatim").mkdir()
        for source in sources:
            (root / "Verbatim" / f"{Path(source).stem}.verbatim.md").write_text(f"Words from {source}", encoding="utf-8")
        (root / "Lecture" / sources[-1]).unlink()
        with _notebook_sources([_remote(sources[-1], "audio")]):
            result = self._draft_tool_result("begin_lecture", module="Poisons", lecture="Corrosives")
        payload = json.loads(result["content"][0]["text"])
        manifest = json.loads(Path(payload["manifest_path"]).read_text(encoding="utf-8"))
        expected = json.loads(mcp_server._read_draft(self._draft_arguments(Path(payload["manifest_path"])), self.workspace))
        self.assertEqual(payload["module"], "toxo")
        self.assertEqual(manifest["recording_sources"], list(sources))
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(payload["text"], expected["content"])
        self.assertEqual(payload["paths"], expected["paths"])
        for source, cohort in zip(sources, ("boys", "boys", "girls")):
            self.assertIn(f"# Recording: {source} (cohort: {cohort})", payload["text"])
            self.assertIn(source, payload["contract"])
        self.assertIn("شرح البنين", payload["contract"])
        self.assertIn("شرح البنات", payload["contract"])

    def test_begin_second_call_reuses_manifest_index_and_completed_recording(self) -> None:
        root = self._begin_fixture()
        arguments = {"module": "toxo", "lecture": "Corrosives"}
        with self._begin_transcription():
            first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        paths = (Path(first["manifest_path"]), root / "Questions" / "exam-index.json", Path(first["path"]))
        snapshots = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        with _notebook_sources([]), patch("subprocess.run", side_effect=AssertionError("completed work was repeated")):
            second = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
        self.assertEqual(first, second)
        self.assertEqual(snapshots, [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths])

    def test_begin_changed_question_files_rebuild_stale_exam_index(self) -> None:
        root = self._begin_fixture()
        arguments = {"module": "toxo", "lecture": "Corrosives"}
        extra = root / "Questions" / "Final 2024.txt"
        question = "1. Corrosive injury involves:\na. Acid burns\nb. Fever\nc. Cough\nd. Rash\n"
        with self._begin_transcription():
            first = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
            original = Path(first["path"]).read_bytes()
            for change, count in (("added", 2), ("deleted", 1), ("edited", 2)):
                with self.subTest(change=change):
                    if change == "added":
                        extra.write_text(question, encoding="utf-8")
                    elif change == "deleted":
                        extra.unlink()
                    else:
                        paper = root / "Questions" / "Final 2023.txt"
                        with paper.open("a", encoding="utf-8") as stream:
                            stream.write(question.replace("1.", "2.", 1))
                        index = root / "Questions" / "exam-index.json"
                        old = paper.stat().st_mtime_ns - 1_000_000_000
                        os.utime(index, ns=(old, old))
                    payload = json.loads(mcp_server._begin_lecture(arguments, self.workspace))
                    self.assertEqual(payload["exam_index"]["questions"], count)
                    self.assertEqual(Path(payload["path"]).read_bytes(), original)
                    self.assertEqual(payload["manifest_path"], first["manifest_path"])

    def test_begin_partial_cohort_run_fetches_only_missing_verbatim(self) -> None:
        sources = ("Corrosives boys.mp3", "Corrosives girls.mp3")
        root = self._begin_fixture(sources)
        (root / "Verbatim").mkdir()
        completed = root / "Verbatim" / "Corrosives boys.verbatim.md"
        completed.write_text("Completed boys recording", encoding="utf-8")
        with self._begin_transcription():
            payload = json.loads(mcp_server._begin_lecture(
                {"module": "toxo", "lecture": "Corrosives"}, self.workspace
            ))
        self.assertEqual(completed.read_text(encoding="utf-8"), "Completed boys recording")
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(len(payload["paths"]), 2)
        self.assertIn("Completed boys recording", payload["text"])
        self.assertIn("كلام الدكتور بالتفصيل", payload["text"])

    def test_begin_unknown_lecture_returns_actionable_tool_error_without_artifacts(self) -> None:
        root = self._begin_fixture()
        with _notebook_sources([]):
            result = self._draft_tool_result("begin_lecture", module="toxo", lecture="Heavy Metals")
        self.assertTrue(result["isError"])
        self.assertIn("Heavy Metals", result["content"][0]["text"])
        self.assertIn("list_lectures", result["content"][0]["text"])
        self.assertFalse((root / ".transcriber-cache" / "manifests").exists())
        self.assertFalse((root / ".transcriber-cache" / "runs").exists())
        self.assertFalse((root / "Questions" / "exam-index.json").exists())

    def test_start_draft_defaults_to_verbatim_and_returns_its_output_path(self) -> None:
        root, manifest_path, _, _ = self._draft_fixture()

        with patch.object(mcp_server, "_run", return_value="raw engine output") as run:
            payload = json.loads(
                mcp_server._start_draft(
                    self._draft_arguments(manifest_path), self.workspace
                )
            )

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--engine") + 1], "notebooklm-raw")
        self.assertEqual(command[command.index("--lecture") + 1], "Corrosives")
        self.assertNotIn("--source-manifest", command)
        self.assertEqual(payload["engine"], "notebooklm-raw")
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(
            payload["path"],
            str(root / "Verbatim" / "Corrosives.verbatim.md"),
        )
        self.assertEqual(payload["output"], "raw engine output")

    def test_start_draft_hands_the_exact_section_contract_to_the_caller(self) -> None:
        _, manifest_path, _, _ = self._draft_fixture()

        with patch.object(mcp_server, "_run", return_value="raw engine output"):
            payload = json.loads(
                mcp_server._start_draft(
                    self._draft_arguments(manifest_path), self.workspace
                )
            )

        contract_bytes = payload["next"].encode("utf-8")
        for heading in SECTION_HEADINGS:
            self.assertIn(heading.encode("utf-8"), contract_bytes)
        self.assertIn(b"### MCQ N", contract_bytes)
        self.assertIn(b"### Clinical Case N", contract_bytes)
        self.assertIn(b"never summarize, compress, or omit", contract_bytes)
        self.assertIn(b"extract_figures", contract_bytes)
        self.assertIn("**الملفات المعتمدة:**".encode(), contract_bytes)

    def test_start_draft_explicit_engines_build_their_own_routes(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        cases = (
            ("notebooklm", "five-phase-pipeline", "--source-manifest", draft_path),
            ("notebooklm-raw", "verbatim", "--lecture", root / "Verbatim"),
            ("whisper", "verbatim", "--lecture", root / "Verbatim"),
        )

        for engine, route, route_flag, expected_path in cases:
            with self.subTest(engine=engine):
                with patch.object(
                    mcp_server, "_run", return_value=f"{engine} output"
                ) as run:
                    payload = json.loads(
                        mcp_server._start_draft(
                            self._draft_arguments(manifest_path, engine=engine),
                            self.workspace,
                        )
                    )

                command = run.call_args.args[0]
                self.assertEqual(command[command.index("--engine") + 1], engine)
                self.assertIn(route_flag, command)
                self.assertEqual(payload["engine"], engine)
                self.assertEqual(payload["route"], route)
                if engine == "notebooklm":
                    self.assertEqual(payload["path"], str(expected_path))
                else:
                    self.assertEqual(
                        payload["path"],
                        str(expected_path / "Corrosives.verbatim.md"),
                    )

    def _multi_verbatim_fixture(self) -> tuple[Path, Path, Path, list[str], str]:
        root, manifest, draft, _ = self._draft_fixture()
        draft.unlink()
        sources = [
            "Corrosives boys part 1.mp3",
            "Corrosives boys part 2.mp3",
            "Corrosives girls.mp3",
        ]
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["recording_sources"] = sources
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        single, body = self._large_verbatim(root)
        header = single.read_text(encoding="utf-8").removesuffix(body)
        single.unlink()
        for source, repetitions in zip(sources, (400, 800, 600)):
            path = root / "Verbatim" / f"{Path(source).stem}.verbatim.md"
            text = body.splitlines(keepends=True)[0] * repetitions
            path.write_text(header + text, encoding="utf-8")
        longest = body.splitlines(keepends=True)[0] * 800
        return root, manifest, draft, sources, longest

    def test_multi_recording_engines_fetch_only_missing_verbatims(self) -> None:
        for engine in ("notebooklm-raw", "whisper"):
            for cached in (0, 1, 3):
                with self.subTest(engine=engine, cached=cached):
                    root, manifest, _, sources, _ = self._multi_verbatim_fixture()
                    paths = [root / "Verbatim" / f"{Path(source).stem}.verbatim.md"
                             for source in sources]
                    original = [path.read_text(encoding="utf-8") for path in paths]
                    for path in paths[cached:]:
                        path.unlink()

                    def transcribe(command: list[str], expected_engine: str = engine, **_kwargs: object) -> subprocess.CompletedProcess:
                        lecture = command[command.index("--lecture") + 1]
                        output = Path(command[command.index("--output") + 1])
                        self.assertFalse(output.exists(), "cached recordings must not be fetched again")
                        self.assertEqual(command[command.index("--engine") + 1], expected_engine)
                        output.write_text(f"كلام الدكتور من {lecture}", encoding="utf-8")
                        return subprocess.CompletedProcess(command, 0, stdout=lecture, stderr="")

                    with patch("subprocess.run", side_effect=transcribe):
                        payload = json.loads(mcp_server._start_draft(
                            self._draft_arguments(manifest, engine=engine), self.workspace
                        ))
                    self.assertEqual(payload["route"], "verbatim")
                    self.assertEqual(payload["paths"], [str(path) for path in paths])
                    self.assertEqual(payload["path"], str(paths[0]))
                    for index, path in enumerate(paths):
                        expected = original[index] if index < cached else f"كلام الدكتور من {Path(sources[index]).stem}"
                        self.assertEqual(path.read_text(encoding="utf-8"), expected)
                    if cached < len(sources):
                        self.assertEqual(payload["output"], "\n\n".join(Path(source).stem for source in sources[cached:]))
                    # The handoff must retain source attribution and the merge policy.
                    for marker in ("doctor's order", "شرح البنين", "شرح البنات", "side by side", "exam follows the slides"):
                        self.assertIn(marker, payload["next"])
                    for source in sources:
                        self.assertIn(source, payload["next"])

    def test_multi_verbatim_read_parts_preserve_every_recording_and_cohort(self) -> None:
        root, manifest, _, sources, _ = self._multi_verbatim_fixture()
        # An unlabelled recording must be attributed without inventing a cohort.
        sources[1] = "Corrosives part 2.mp3"
        old = root / "Verbatim" / "Corrosives boys part 2.verbatim.md"
        old.rename(root / "Verbatim" / "Corrosives part 2.verbatim.md")
        payload = json.loads(manifest.read_text(encoding="utf-8"))
        payload["recording_sources"] = sources
        manifest.write_text(json.dumps(payload), encoding="utf-8")
        paths = [root / "Verbatim" / f"{Path(source).stem}.verbatim.md" for source in sources]
        expected = "\n\n".join(
            f"# Recording: {source} (cohort: {cohort})\n\n{path.read_text(encoding='utf-8')}"
            for source, cohort, path in zip(sources, ("boys", "unknown", "girls"), paths)
        )
        first = json.loads(mcp_server._read_draft(self._draft_arguments(manifest), self.workspace))
        self.assertGreater(first["parts"], 1)
        self.assertIn("contract", first)
        chunks = [first["content"]]
        for part in range(2, first["parts"] + 1):
            reply = json.loads(mcp_server._read_draft(
                self._draft_arguments(manifest, part=part), self.workspace
            ))
            self.assertEqual(reply["paths"], [str(path) for path in paths])
            self.assertEqual(reply["route"], "verbatim")
            self.assertNotIn("contract", reply)
            self.assertEqual("next" in reply, part < first["parts"])
            chunks.append(reply["content"])
        self.assertEqual("".join(chunks), expected)
        self.assertEqual(chunks, mcp_server._text_parts(expected, json.loads(manifest.read_text(encoding="utf-8"))["read_part_bytes"]))

    def test_incomplete_multi_verbatims_cannot_be_read_or_reviewed(self) -> None:
        root, manifest, draft, sources, _ = self._multi_verbatim_fixture()
        (root / "Verbatim" / f"{Path(sources[-1]).stem}.verbatim.md").unlink()
        for handler in (mcp_server._read_draft, mcp_server._apply_review):
            with self.subTest(handler=handler.__name__):
                with self.assertRaisesRegex(ToolError, "not every recording has a verbatim"):
                    handler(self._draft_arguments(manifest, content=self._complete_revision("شرح")), self.workspace)
        self.assertFalse(draft.exists())

    def test_multi_guide_floor_uses_longest_body_and_preserves_rejected_parts(self) -> None:
        root, manifest, draft, _, longest = self._multi_verbatim_fixture()
        source_chars = len("".join(longest.split()))
        short = self._complete_revision("ش " * (source_chars // 2 - 1))
        chunks = mcp_server._text_parts(short)
        for part, chunk in enumerate(chunks, 1):
            payload = self._stage_part(manifest, part, len(chunks), chunk)
        self.assertEqual(payload["verbatim_chars_total"], source_chars)
        self.assertEqual(payload["required_chars"], source_chars // 2)
        self.assertEqual(payload["guide_chars_so_far"], source_chars // 2 - 1)
        self.assertNotIn("short_guide_parts", payload)
        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(self._draft_arguments(manifest, from_parts=True), self.workspace)
        self.assertIn("longest single recording", str(caught.exception))
        self.assertIn(f"{source_chars:,}", str(caught.exception))
        self.assertNotIn("Short guide parts", str(caught.exception))
        self.assertFalse(draft.exists())
        self.assertTrue(tuple((root / ".transcriber-cache" / "staged-drafts").rglob("part-1.md")))
        # Exactly half of the longest body is below half of the combined audio;
        # neither provenance headers nor the other recordings inflate the floor.
        revision = self._complete_revision("ش " * (source_chars // 2))
        chunks = mcp_server._text_parts(revision)
        for part, chunk in enumerate(chunks, 1):
            self._stage_part(manifest, part, len(chunks), chunk)
        result = self._draft_tool_result("apply_review", **self._draft_arguments(manifest, from_parts=True, confirmed=True))
        self.assertFalse(result["isError"])
        self.assertEqual(draft.read_text(encoding="utf-8"), revision)
        self.assertEqual(len(tuple((root / ".transcriber-cache" / "staged-drafts").rglob("part-*.md"))), len(chunks))

    def test_multi_staging_reports_guide_totals_without_questions_or_alignment(self) -> None:
        _, manifest, _, _, longest = self._multi_verbatim_fixture()
        for part, content, expected in (
            (3, "\n" + SECTION_HEADINGS[1] + "\n" + "أسئلة " * 2_000, 0),
            (1, SECTION_HEADINGS[0] + "\n" + "ش " * 2_000, 2_000),
            (2, "د " * 3_000, 5_000),
            (1, SECTION_HEADINGS[0] + "\n" + "ش " * 4_000, 7_000),
        ):
            with self.subTest(part=part, expected=expected):
                payload = self._stage_part(manifest, part, 3, content)
                self.assertEqual(payload["guide_chars_so_far"], expected)
                self.assertEqual(payload["verbatim_chars_total"], len("".join(longest.split())))
                self.assertNotIn("short_guide_parts", payload)
                self.assertNotIn("next", payload)

    def test_prepare_manifest_keeps_all_cohorts_in_order_across_local_and_remote_sources(self) -> None:
        sources = ["Shock boys part 1.m4a", "Shock boys part 2.m4a", "Shock girls.m4a"]
        for local_count in (0, 2, 3):
            with self.subTest(local_count=local_count):
                root = self._make_module(f"manifest{local_count}")
                for name in sources[:local_count] + ["Shock treatment boys.m4a"]:
                    (root / "Lecture" / name).write_bytes(b"audio")
                (root / "Lecture" / "Shock.pdf").write_bytes(b"slides")
                (root / "Questions" / "bank.txt").write_text("Questions", encoding="utf-8")
                remote = [_remote(name, "audio") for name in reversed(sources[local_count:])]
                with _notebook_sources(remote):
                    reply = json.loads(mcp_server._prepare_manifest(
                        {"module": f"manifest{local_count}", "lecture": "Shock"}, self.workspace
                    ))
                manifest = json.loads(Path(reply["manifest_path"]).read_text(encoding="utf-8"))
                self.assertEqual(manifest["recording_sources"], sources)
                self.assertEqual(manifest["title"], "Shock")
                self.assertEqual(manifest["slides"]["path"], "Lecture/Shock.pdf")
                if local_count == 3:
                    from run_transcription import generate_auto_manifest

                    automatic = generate_auto_manifest(root, "Shock")
                    self.assertEqual(json.loads(automatic.read_text())["recording_sources"], sources)

    def test_start_draft_rejects_unknown_engine_with_valid_choices(self) -> None:
        _, manifest_path, _, _ = self._draft_fixture()

        with self.assertRaises(ToolError) as caught:
            mcp_server._start_draft(
                self._draft_arguments(manifest_path, engine="gpt"),
                self.workspace,
            )

        message = str(caught.exception)
        for engine in ("notebooklm", "notebooklm-raw", "whisper"):
            self.assertIn(engine, message)

    def test_read_draft_returns_text_and_the_engine_draft_path(self) -> None:
        _, manifest_path, draft_path, original = self._draft_fixture()

        payload = json.loads(
            mcp_server._read_draft(
                self._draft_arguments(manifest_path), self.workspace
            )
        )

        self.assertEqual(payload["path"], str(draft_path))
        self.assertEqual(payload["content"], original)
        self.assertIn("validate_draft", payload["next"])
        self.assertIn("verify_provenance", payload["next"])

    def test_read_draft_returns_verbatim_output_when_no_draft_was_written(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        verbatim_path = root / "Verbatim" / "Corrosives.verbatim.md"
        verbatim_path.parent.mkdir(parents=True)
        verbatim_path.write_text("Doctor's exact words", encoding="utf-8")

        payload = json.loads(
            mcp_server._read_draft(
                self._draft_arguments(manifest_path), self.workspace
            )
        )

        self.assertEqual(payload["path"], str(verbatim_path.resolve()))
        self.assertEqual(payload["content"], "Doctor's exact words")
        self.assertEqual(payload["route"], "verbatim")
        self.assertEqual(payload["contract"], mcp_server.build_drafting_contract())

    def test_read_draft_returns_a_long_verbatim_whole_across_parts(self) -> None:
        # Regression: a 137 KB verbatim came back in one result, the desktop
        # host spilled everything past 50,000 bytes, and the model drafted the
        # Chronological Guide from the head and tail of the lecture.
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        verbatim_path = root / "Verbatim" / "Corrosives.verbatim.md"
        verbatim_path.parent.mkdir(parents=True)
        text = "".join(f"سطر {n}: الدكتور قال نصاً إن الـ corrosive بيعمل burn\n" for n in range(4000))
        verbatim_path.write_text(text, encoding="utf-8")

        arguments = self._draft_arguments(manifest_path)
        first = json.loads(mcp_server._read_draft(arguments, self.workspace))
        parts = first["parts"]
        self.assertGreater(parts, 1)
        self.assertIn("part=2", first["next"])
        self.assertEqual(first["contract"], mcp_server.build_drafting_contract())
        pieces = [first["content"]]
        for part in range(2, parts + 1):
            result = mcp_server._read_draft({**arguments, "part": part}, self.workspace)
            self.assertLess(len(result.encode("utf-8")), 50_000)
            pieces.append(json.loads(result)["content"])
        self.assertNotIn("next", json.loads(result))
        self.assertNotIn("contract", json.loads(result))
        self.assertEqual("".join(pieces), text)

    def test_text_parts_cut_one_unbroken_line_without_losing_a_character(self) -> None:
        line = "ك" * 40_000
        parts = mcp_server._text_parts(line, budget=30_000)
        self.assertEqual("".join(parts), line)
        self.assertTrue(all(len(part.encode("utf-8")) <= 30_000 for part in parts))

    def test_read_draft_refuses_a_part_past_the_end(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        verbatim_path = root / "Verbatim" / "Corrosives.verbatim.md"
        verbatim_path.parent.mkdir(parents=True)
        verbatim_path.write_text("كلام\n" * 20_000, encoding="utf-8")
        with self.assertRaises(ToolError) as caught:
            mcp_server._read_draft(
                {**self._draft_arguments(manifest_path), "part": 99}, self.workspace
            )
        self.assertIn("part must be an integer from 1 to", str(caught.exception))

    def test_read_draft_missing_file_tells_caller_to_start_draft(self) -> None:
        _, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()

        with self.assertRaises(ToolError) as context:
            mcp_server._read_draft(
                self._draft_arguments(manifest_path), self.workspace
            )

        self.assertIn("start_draft first", str(context.exception))

    def test_staged_parts_arrive_out_of_order_and_retries_replace_text(self) -> None:
        _, manifest_path, draft_path, original = self._draft_fixture()
        revised = original + "\n\nReviewed in staged parts."
        step = (len(revised) + 2) // 3
        pieces = [revised[index : index + step] for index in range(0, len(revised), step)]
        pieces += [""] * (3 - len(pieces))

        first = self._stage_part(manifest_path, 2, 3, "wrong part")
        self.assertEqual(first["received_parts"], [2])
        self.assertEqual(first["missing_parts"], [1, 3])
        self._stage_part(manifest_path, 1, 3, pieces[0])
        self._stage_part(manifest_path, 2, 3, pieces[1])
        final = self._stage_part(manifest_path, 3, 3, pieces[2])

        self.assertEqual(final["received_parts"], [1, 2, 3])
        self.assertEqual(final["missing_parts"], [])
        self.assertEqual(final["total_parts"], 3)
        self.assertEqual(final["part_bytes"], len(pieces[2].encode("utf-8")))
        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
        )

        self.assertFalse(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revised)
        replacement = pieces[1] + "\nA corrected clinical point.\n"
        status = self._stage_part(manifest_path, 2, 3, replacement)
        self.assertEqual(status["missing_parts"], [])
        mcp_server._apply_review(
            self._draft_arguments(manifest_path, from_parts=True), self.workspace
        )
        self.assertEqual(draft_path.read_text(encoding="utf-8"), pieces[0] + replacement + pieces[2])

    def test_staging_rejects_a_different_total_after_the_first_part(self) -> None:
        _, manifest_path, _, _ = self._draft_fixture()
        self._stage_part(manifest_path, 1, 2, "part one")

        with self.assertRaises(ToolError) as caught:
            mcp_server._stage_draft_part(
                self._draft_arguments(
                    manifest_path, part=2, parts=3, content="part two"
                ),
                self.workspace,
            )

        self.assertIn("parts must stay 2", str(caught.exception))

    def test_staging_rejects_a_part_larger_than_the_host_budget(self) -> None:
        _, manifest_path, _, _ = self._draft_fixture()
        oversized = "x" * (mcp_server.MAX_STAGE_PART_BYTES + 1)

        with self.assertRaises(ToolError) as caught:
            mcp_server._stage_draft_part(
                self._draft_arguments(
                    manifest_path, part=1, parts=1, content=oversized
                ),
                self.workspace,
            )

        self.assertIn("split", str(caught.exception))

    def test_apply_from_parts_names_a_missing_part_and_keeps_staged_text(self) -> None:
        root, manifest_path, draft, _ = self._draft_fixture()
        self._large_verbatim(root)
        self._stage_part(manifest_path, 1, 2, "first part")
        # Without a saved draft, a missing staged part cannot be recovered.
        draft.unlink()

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
                self.workspace,
            )

        self.assertIn("Missing staged draft parts: 2", str(caught.exception))
        staged = root / ".transcriber-cache" / "staged-drafts"
        self.assertTrue(tuple(staged.rglob("part-1.md")))

    def test_first_verbatim_save_creates_draft_and_retains_staged_parts(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        _, body = self._large_verbatim(root)
        revision = self._complete_revision(body)
        self._stage_revision(manifest_path, revision, 3)

        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
        )

        self.assertFalse(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revision)
        staged_root = root / ".transcriber-cache" / "staged-drafts"
        self.assertEqual(len(tuple(staged_root.rglob("part-*.md"))), 3)
        self.assertTrue((staged_root / draft_path.name).exists())

    def test_aligned_short_guide_part_is_stored_with_exact_shortfall(self) -> None:
        # Conjunctiva regression: repeated save refusals gave no clue which
        # aligned guide part needed the doctor's missing explanation.
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        self._large_verbatim(root)
        first = json.loads(mcp_server._read_draft(
            self._draft_arguments(manifest_path), self.workspace
        ))
        self.assertEqual(first["parts"], 3)
        first_chars = len("".join(first["content"].split()))
        guide = "د " * 1_000 + "\n\t"

        payload = self._stage_part(manifest_path, 1, 4, guide)

        self.assertEqual(payload["short_guide_parts"], [{
            "part": 1, "guide_chars": 1_000,
            "verbatim_chars": first_chars, "required_chars": (first_chars + 1) // 2,
        }])
        self.assertEqual(payload["guide_chars_so_far"], 1_000)
        self.assertEqual(payload["verbatim_chars_total"], 35_011)
        self.assertIn("Re-send part 1", payload["next"])
        self.assertIn("complete explanation of verbatim part 1", payload["next"])
        self.assertIn("read_draft part=1", payload["next"])
        staged_path = (
            root / ".transcriber-cache" / "staged-drafts" / draft_path.name / "part-1.md"
        )
        self.assertEqual(staged_path.read_text(encoding="utf-8"), guide)

    def test_aligned_full_parts_report_totals_without_recounting_replacements(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        self._large_verbatim(root)
        second = json.loads(mcp_server._read_draft(
            self._draft_arguments(manifest_path, part=2), self.workspace
        ))
        payload = self._stage_part(manifest_path, 2, 4, second["content"])
        self.assertNotIn("short_guide_parts", payload)
        second_chars = len("".join(second["content"].split()))
        self.assertEqual(payload["guide_chars_so_far"], second_chars)
        self.assertEqual(payload["verbatim_chars_total"], 35_011)

        for guide_chars in (7_008, 14_015):
            with self.subTest(guide_chars=guide_chars):
                payload = self._stage_part(manifest_path, 1, 4, "ش " * guide_chars)
                self.assertNotIn("short_guide_parts", payload)
                self.assertNotIn("next", payload)
                self.assertEqual(payload["guide_chars_so_far"], second_chars + guide_chars)
                self.assertEqual(payload["verbatim_chars_total"], 35_011)

        questions = self._stage_part(manifest_path, 4, 4, "Question sections.")
        self.assertNotIn("short_guide_parts", questions)
        self.assertNotIn("guide_chars_so_far", questions)
        payload = self._stage_part(manifest_path, 3, 4, "ش " * 7_076)
        self.assertEqual(payload["guide_chars_so_far"], second_chars + 14_015 + 7_076)

    def test_unaligned_parts_skip_feedback_but_still_refuse_a_short_guide(self) -> None:
        for total in (2, 3):
            with self.subTest(total=total):
                root, manifest_path, draft_path, _ = self._draft_fixture(
                    title=f"Corrosives {total}"
                )
                draft_path.unlink()
                self._large_verbatim(root)
                for part in range(1, total + 1):
                    content = self._complete_revision("ملخص قصير.") if part == 1 else "\nش"
                    payload = self._stage_part(manifest_path, part, total, content)
                    self.assertNotIn("short_guide_parts", payload)
                    self.assertNotIn("guide_chars_so_far", payload)
                    self.assertNotIn("verbatim_chars_total", payload)
                    self.assertNotIn("next", payload)

                with self.assertRaises(ToolError) as caught:
                    mcp_server._apply_review(
                        self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
                        self.workspace,
                    )
                self.assertIn("Chronological Guide", str(caught.exception))
                self.assertNotIn("Short guide parts", str(caught.exception))

    def test_aligned_guide_ratio_refusal_names_only_short_parts_and_their_deficits(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        self._large_verbatim(root)
        served_parts = {
            part: json.loads(mcp_server._read_draft(self._draft_arguments(manifest_path, part=part), self.workspace))
            for part in (1, 3)
        }
        self._stage_part(manifest_path, 1, 4, SECTION_HEADINGS[0] + "\n" + "د" * 1_000)
        self._stage_part(manifest_path, 2, 4, "د" * 6_960)
        self._stage_part(manifest_path, 3, 4, "د" * 1_000)
        questions = self._complete_revision("").split(SECTION_HEADINGS[1], 1)[1]
        self._stage_part(manifest_path, 4, 4, "\n" + SECTION_HEADINGS[1] + questions)

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
                self.workspace,
            )

        message = str(caught.exception)
        self.assertTrue(message.startswith("Review refused; the draft was left unchanged."))
        self.assertIn("complete explanation, not a summary", message)
        breakdown = message.split("Short guide parts (aligned with verbatim read parts):\n", 1)[1]
        first_chars = len("".join(SECTION_HEADINGS[0].split())) + 1_000
        for part, guide_chars in ((1, first_chars), (3, 1_000)):
            served = served_parts[part]
            source_chars = len("".join(served["content"].split()))
            required = (source_chars + 1) // 2
            self.assertIn(f"part {part}: guide_chars={guide_chars}, verbatim_chars={source_chars}, required_chars={required}, missing_chars={required - guide_chars}", breakdown)
        self.assertNotIn("part 2:", breakdown)
        self.assertNotIn("part 4:", breakdown)
        self.assertFalse(draft_path.exists())
        staged = root / ".transcriber-cache" / "staged-drafts"
        self.assertEqual(len(tuple(staged.rglob("part-*.md"))), 4)

    def test_summarized_verbatim_guide_is_refused_with_counts_and_keeps_parts(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        _, body = self._large_verbatim(root)
        revision = self._complete_revision("ملخص قصير للمحاضرة فقط.")
        self._stage_part(manifest_path, 1, 1, revision)

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
                self.workspace,
            )

        message = str(caught.exception)
        guide_count = mcp_server._review_character_count(
            mcp_server._section_body(revision, SECTION_HEADINGS[0])
        )
        source_count = mcp_server._review_character_count(body)
        self.assertIn(f"{guide_count:,}", message)
        self.assertIn(f"{source_count:,}", message)
        self.assertIn("complete explanation, not a summary", message)
        staged = root / ".transcriber-cache" / "staged-drafts"
        self.assertTrue(tuple(staged.rglob("part-1.md")))

    def test_complete_verbatim_guide_passes_first_save(self) -> None:
        root, manifest_path, draft_path, _ = self._draft_fixture()
        draft_path.unlink()
        _, body = self._large_verbatim(root)
        revision = self._complete_revision(body)
        self._stage_revision(manifest_path, revision, 3)
        result = json.loads(
            mcp_server._apply_review(
                self._draft_arguments(manifest_path, from_parts=True, confirmed=True),
                self.workspace,
            )
        )

        self.assertEqual(result["path"], str(draft_path))
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revision)

    def test_existing_draft_cannot_be_replaced_by_a_verbatim_summary(self) -> None:
        root, manifest_path, draft_path, original = self._draft_fixture()
        _, body = self._large_verbatim(root)
        summary = self._complete_revision("A short summary.")

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(manifest_path, content=summary, confirmed=True),
                self.workspace,
            )

        message = str(caught.exception)
        self.assertIn("Chronological Guide", message)
        self.assertIn(
            f"{mcp_server._review_character_count(body):,}", message
        )
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)

    def test_from_parts_apply_still_requires_confirmation(self) -> None:
        root, manifest_path, draft_path, original = self._draft_fixture()
        self._stage_part(manifest_path, 1, 1, original)

        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(manifest_path, from_parts=True),
        )

        self.assertTrue(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)
        self.assertTrue(
            tuple(
                (root / ".transcriber-cache" / "staged-drafts").rglob("part-1.md")
            )
        )

    def test_apply_review_requires_boolean_confirmation_without_writing(self) -> None:
        _, manifest_path, draft_path, original = self._draft_fixture()

        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(manifest_path, content=original + " revised"),
        )

        self.assertTrue(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)

    def test_matching_workspace_assertion_allows_review_write(self) -> None:
        _, manifest_path, draft_path, original = self._draft_fixture()
        revised = original + "\n\nReviewed in chat."

        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(
                manifest_path,
                content=revised,
                confirmed=True,
                workspace=str(self.workspace),
            ),
        )

        self.assertFalse(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revised)

    def test_different_workspace_assertion_refuses_without_writing(self) -> None:
        _, manifest_path, draft_path, original = self._draft_fixture()
        revised = original + "\n\nThis must not be written."
        different_workspace = self.workspace.parent / "different-workspace"

        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(
                manifest_path,
                content=revised,
                confirmed=True,
                workspace=str(different_workspace),
            ),
        )

        self.assertTrue(result["isError"])
        message = result["content"][0]["text"]
        self.assertIn(str(self.workspace.resolve()), message)
        self.assertIn(str(different_workspace.resolve()), message)
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)

    def test_equivalent_workspace_spellings_are_accepted(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives.mp3").write_bytes(b"data")
        symlink = self.workspace.with_name(f"{self.workspace.name}-link")
        symlink.symlink_to(self.workspace, target_is_directory=True)
        self.addCleanup(symlink.unlink)
        spellings = (
            os.path.relpath(self.workspace, Path.cwd()),
            f"{self.workspace}/",
            str(symlink),
        )

        for supplied_workspace in spellings:
            with self.subTest(workspace=supplied_workspace):
                result = self._draft_tool_result(
                    "list_lectures",
                    module="toxo",
                    workspace=supplied_workspace,
                )
                self.assertFalse(result["isError"])
                payload = json.loads(result["content"][0]["text"])
                self.assertEqual(payload["module"], "toxo")

    def test_empty_or_suspiciously_short_review_is_refused_without_overwrite(
        self,
    ) -> None:
        for revised in ("   \n", "summary"):
            with self.subTest(revised=revised):
                _, manifest_path, draft_path, original = self._draft_fixture()
                result = self._draft_tool_result(
                    "apply_review",
                    **self._draft_arguments(
                        manifest_path, content=revised, confirmed=True
                    ),
                )

                self.assertTrue(result["isError"])
                self.assertEqual(draft_path.read_text(encoding="utf-8"), original)

    def test_rejected_review_preserves_agent_text_and_leaves_live_draft_untouched(
        self,
    ) -> None:
        root, manifest_path, draft_path, original = self._draft_fixture()
        revised = original.replace(SECTION_HEADINGS[1], "## ⭐ IMP Points")

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(
                    manifest_path, content=revised, confirmed=True
                ),
                self.workspace,
            )

        rejected = tuple(
            (root / ".transcriber-cache" / "rejected-reviews").glob("*.md")
        )
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0].read_text(encoding="utf-8"), revised)
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)
        self.assertIn(str(rejected[0]), str(caught.exception))

    def test_review_refusal_reports_all_findings_in_one_message(self) -> None:
        root, manifest_path, draft_path, original = self._draft_fixture()
        (root / "Lecture" / "Corrosives.pptx").write_bytes(b"deck")
        (root / "Verbatim").mkdir(parents=True)
        (root / "Verbatim" / "Corrosives.verbatim.md").write_bytes(b"v" * 20_000)
        revised = (
            "\n\n".join(
                (
                    SECTION_HEADINGS[0],
                    "## ⭐ IMP Points",
                    SECTION_HEADINGS[2],
                    "### Question 1",
                    SECTION_HEADINGS[3],
                    SECTION_HEADINGS[4],
                )
            )
            + "\n\n"
            + ("Clinical material. " * 120)
        )

        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(
                self._draft_arguments(
                    manifest_path, content=revised, confirmed=True
                ),
                self.workspace,
            )

        message = str(caught.exception)
        self.assertIn("expected '## 🌟 IMP Points', found '## ⭐ IMP Points'", message)
        self.assertIn("expected '### MCQ N', found '### Question 1'", message)
        self.assertIn("figures:", message)
        self.assertIn("substance ratio is", message)
        self.assertEqual(draft_path.read_text(encoding="utf-8"), original)

    def test_large_inline_review_is_refused_before_context_or_extraction(self) -> None:
        for content in ("x" * 20_001, "ش" * 10_001):
            with self.subTest(bytes=len(content.encode("utf-8"))):
                with patch.object(mcp_server, "_review_inputs", side_effect=AssertionError("too late")):
                    with self.assertRaisesRegex(ToolError, "Never send the whole draft"):
                        mcp_server._apply_review({"content": content}, self.workspace)

    def test_review_extracts_missing_manifest_and_accepts_text_only_deck(self) -> None:
        root, manifest, draft, original = self._draft_fixture()
        (root / "Lecture" / "Corrosives.pptx").write_bytes(b"deck")

        def extract(arguments: dict, workspace: Path) -> str:
            self.assertEqual(arguments["lecture"], "Corrosives")
            directory = root / "Transcripts" / "Figures" / "Corrosives"
            directory.mkdir(parents=True)
            figure_manifest(root / "Lecture/Corrosives.pptx", directory)
            return "No diagram pages"

        with patch.object(mcp_server, "_extract_figures", side_effect=extract) as extraction:
            mcp_server._apply_review(self._draft_arguments(manifest, content=original), self.workspace)
            mcp_server._apply_review(self._draft_arguments(manifest, content=original), self.workspace)
        self.assertEqual(extraction.call_count, 1)
        self.assertEqual(draft.read_text(encoding="utf-8"), original)

    def test_from_parts_extracts_figures_then_accepts_only_targeted_link_repair(self) -> None:
        root, manifest, draft, original = self._draft_fixture()
        (root / "Lecture" / "Corrosives.pptx").write_bytes(b"synthetic deck")
        cut = original.index(SECTION_HEADINGS[1])
        guide, questions = original[:cut], original[cut:]
        self._stage_part(manifest, 1, 2, guide)
        self._stage_part(manifest, 2, 2, questions)

        def extract(_arguments: dict, _workspace: Path) -> str:
            directory = root / "Transcripts" / "Figures" / "Corrosives"
            directory.mkdir(parents=True)
            (directory / "page-001.png").write_bytes(b"raster")
            figure_manifest(root / "Lecture/Corrosives.pptx", directory, (1,))
            return "extracted one slide"

        with patch.object(mcp_server, "_extract_figures", side_effect=extract):
            with self.assertRaises(ToolError) as caught:
                mcp_server._apply_review(self._draft_arguments(manifest, from_parts=True), self.workspace)
        self.assertIn("missing slide link", str(caught.exception))
        self.assertIn("placement in parts 1", str(caught.exception))
        self.assertEqual(draft.read_text(encoding="utf-8"), original)
        link = "![slide](<./Figures/Corrosives/page-001.png>)\n"
        self._stage_part(manifest, 1, 2, guide + link)
        mcp_server._apply_review(self._draft_arguments(manifest, from_parts=True), self.workspace)
        self.assertEqual(draft.read_text(encoding="utf-8"), guide + link + questions)

    def test_refused_parts_report_affected_part_and_repair_keeps_other_parts(self) -> None:
        _root, manifest, draft, original = self._draft_fixture()
        guide = SECTION_HEADINGS[0] + "\nClinical explanation.\n"
        questions = original[original.index(SECTION_HEADINGS[1]):]
        broken = questions.replace(SECTION_HEADINGS[1], "## ⭐ IMP Points")
        self._stage_part(manifest, 1, 2, guide)
        self._stage_part(manifest, 2, 2, broken)
        arguments = self._draft_arguments(manifest, from_parts=True)
        with self.assertRaises(ToolError) as caught:
            mcp_server._apply_review(arguments, self.workspace)
        message = str(caught.exception)
        self.assertIn("re-send part 2", message)
        self.assertIn("stage_draft_part", message)
        self.assertIn("Never send the whole draft", message)
        self._stage_part(manifest, 2, 2, questions)
        mcp_server._apply_review(arguments, self.workspace)
        self.assertEqual(draft.read_text(encoding="utf-8"), guide + questions)

    def test_unstaged_saved_draft_next_never_requests_full_content(self) -> None:
        _root, manifest, _draft, _original = self._draft_fixture()
        arguments = self._draft_arguments(manifest)
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        next_call = mcp_server._saved_draft_next(context, arguments, {"validate_draft": "badge failed"})
        self.assertNotIn("complete revised draft", next_call)
        self.assertIn("Never send the whole draft", next_call)

    def test_saved_draft_without_layout_can_be_repaired_in_small_retained_parts(self) -> None:
        _root, manifest, draft, original = self._draft_fixture()
        original = original.replace("Complete clinical explanation. " * 80,
                                    "Complete clinical explanation. " * 1800)
        draft.write_text(original, encoding="utf-8")
        arguments = self._draft_arguments(manifest)
        status = json.loads(mcp_server._read_draft(arguments, self.workspace))
        total = status["total_parts"]
        read_parts = [json.loads(mcp_server._read_draft({**arguments, "staged": True, "part": part}, self.workspace))["content"]
                      for part in range(1, total + 1)]
        self.assertEqual("".join(read_parts), original)
        self.assertTrue(all(len(part.encode("utf-8")) <= 8000 for part in read_parts))
        self._stage_part(manifest, total, total, read_parts[-1] + "\nRepaired detail.")
        mcp_server._apply_review({**arguments, "from_parts": True}, self.workspace)
        self.assertEqual(draft.read_text(encoding="utf-8"), original + "\nRepaired detail.")

    def test_repair_part_boundary_preserves_the_guide_heading_and_missing_part_recovery(self) -> None:
        _root, manifest, draft, original = self._draft_fixture()
        original = "# Lecture\n" + "p" * 7988 + "\n\n" + original
        draft.write_text(original, encoding="utf-8")
        arguments = self._draft_arguments(manifest)
        status = json.loads(mcp_server._read_draft(arguments, self.workspace))
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        self.assertEqual(mcp_server._read_staged_draft(context), original)
        guide_part = next(number for number in range(1, status["total_parts"] + 1)
                          if SECTION_HEADINGS[0] in mcp_server._staged_part_path(context, number).read_text(encoding="utf-8"))
        mcp_server._staged_part_path(context, guide_part).unlink()
        restored = json.loads(mcp_server._read_draft({**arguments, "staged": True, "part": guide_part}, self.workspace))
        self.assertIn(SECTION_HEADINGS[0], restored["content"])
        self.assertEqual(restored["parts"], status["total_parts"])
        mcp_server._apply_review({**arguments, "from_parts": True}, self.workspace)
        self.assertEqual(draft.read_text(encoding="utf-8"), original)

    def test_agy_cannot_remap_saved_repair_parts(self) -> None:
        _root, manifest, _draft, _original = self._draft_fixture()
        arguments = self._draft_arguments(manifest)
        mcp_server._read_draft(arguments, self.workspace)
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        directory = mcp_server._staged_draft_directory(context)
        before = {path.name: path.read_bytes() for path in directory.iterdir()}
        with self.assertRaisesRegex(ToolError, "stage_draft_part"):
            mcp_server._write_parts_with_agy({**arguments, "parts": [1]}, self.workspace)
        self.assertEqual({path.name: path.read_bytes() for path in directory.iterdir()}, before)

    @patch("mcp_server.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", ""))
    def test_review_extraction_cannot_remap_retained_merged_parts(self, _converter) -> None:
        from slide_figures import SLIDE_TEXT_NAME

        root, manifest, _draft, _sources, longest = self._multi_verbatim_fixture()
        (root / "Lecture" / "Corrosives.pdf").write_bytes(b"synthetic deck")
        arguments = self._draft_arguments(manifest)
        context = mcp_server._resolve_draft_context(arguments, self.workspace)
        total = mcp_server._merged_plan(context, mcp_server.DEFAULT_WRITE_PART_BYTES).layout["parts"]
        self._stage_revision(manifest, self._complete_revision(longest).replace(SECTION_HEADINGS[1], "## Invalid IMP"), total)

        def extract(_arguments: dict, _workspace: Path) -> str:
            directory = context.figure_directories[0]
            directory.mkdir(parents=True)
            figure_manifest(root / "Lecture/Corrosives.pdf", directory)
            (directory / SLIDE_TEXT_NAME).write_text("New extracted outline.\n")
            return "extracted"

        with patch.object(mcp_server, "_extract_figures", side_effect=extract):
            with self.assertRaises(ToolError):
                mcp_server._apply_review({**arguments, "from_parts": True}, self.workspace)
        before = {number: mcp_server._staged_part_path(context, number).read_bytes()
                  for number in range(2, total + 1)}
        self._stage_part(manifest, 1, total, "Repaired first part")
        self.assertEqual({number: mcp_server._staged_part_path(context, number).read_bytes()
                          for number in range(2, total + 1)}, before)

    def test_staged_read_prepares_saved_repair_without_large_live_paging(self) -> None:
        _root, manifest, draft, original = self._draft_fixture()
        draft.write_text(original + "detail " * 9000, encoding="utf-8")
        first = json.loads(mcp_server._read_draft(self._draft_arguments(
            manifest, staged=True, part=1, _max_part_bytes=20_000), self.workspace))
        self.assertGreater(first["parts"], 1)
        self.assertLessEqual(len(first["content"].encode("utf-8")), 8000)

    def test_successful_review_is_readable_and_records_conversation_id(self) -> None:
        root, manifest_path, draft_path, original = self._draft_fixture()
        second_manifest = self.workspace / "second-manifest.json"
        second_manifest.write_text(
            json.dumps(
                {
                    "title": "Second",
                    "recording_sources": ["Second.mp3"],
                    "exam_style_profile": {"mcq": {"options": {"count": 4}}},
                }
            ),
            encoding="utf-8",
        )
        import batch_state

        ledger_path = batch_state.create_ledger(
            "toxo", root / ".transcriber-cache", (manifest_path, second_manifest)
        )
        lecture_key = next(
            key
            for key, lecture in batch_state.read_ledger(ledger_path)["lectures"].items()
            if lecture["manifest_path"] == str(manifest_path.resolve())
        )
        for status in ("queued", "running", "draft_ready"):
            batch_state.update_ledger(
                ledger_path, batch_state.LedgerUpdate(lecture_key, status)
            )

        revised = original + "\n\nReviewed in chat."
        result = self._draft_tool_result(
            "apply_review",
            **self._draft_arguments(
                manifest_path,
                content=revised,
                confirmed=True,
                conversation_id="chat-123",
            ),
        )

        self.assertFalse(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revised)
        read_back = json.loads(
            mcp_server._read_draft(
                self._draft_arguments(manifest_path), self.workspace
            )
        )
        self.assertEqual(read_back["content"], revised)
        lecture = batch_state.read_ledger(ledger_path)["lectures"][lecture_key]
        self.assertEqual(lecture["status"], "accepted")
        self.assertEqual(lecture["conversation_id"], "chat-123")

    def test_a_failed_ledger_record_warns_but_keeps_the_saved_revision(self) -> None:
        # The draft is written before the ledger is touched, so a bookkeeping
        # failure must not be reported as a failed call: a caller told the
        # review could not be recorded would reasonably resend or abandon a
        # revision that is already safely on disk.
        _, manifest_path, draft_path, original = self._draft_fixture()
        revised = original + "\n\nReviewed in chat."

        import batch_state

        def explode(*_args: object, **_kwargs: object) -> None:
            raise batch_state.BatchStateError("ledger is unreadable")

        with patch.object(batch_state, "record_review", explode):
            result = self._draft_tool_result(
                "apply_review",
                **self._draft_arguments(
                    manifest_path, content=revised, confirmed=True
                ),
            )

        self.assertFalse(result["isError"])
        self.assertEqual(draft_path.read_text(encoding="utf-8"), revised)
        payload = json.loads(result["content"][0]["text"])
        self.assertIn("ledger is unreadable", payload["warning"])

    # -- list_modules ----------------------------------------------------

    def test_workspace_info_reports_served_path_and_empty_workspace(self) -> None:
        result = self._draft_tool_result("workspace_info")
        payload = json.loads(result["content"][0]["text"])

        self.assertEqual(payload["workspace"], str(self.workspace.resolve()))
        self.assertTrue(payload["exists"])
        self.assertFalse(payload["has_modules"])

        (self.workspace / "modules").mkdir()
        payload = json.loads(
            self._draft_tool_result("workspace_info")["content"][0]["text"]
        )
        self.assertTrue(payload["has_modules"])

    def test_workspace_info_reports_missing_workspace_without_raising(self) -> None:
        missing_workspace = self.workspace / "not-created"
        result = json.loads(mcp_server._workspace_info({}, missing_workspace))

        self.assertEqual(result["workspace"], str(missing_workspace.resolve()))
        self.assertFalse(result["exists"])
        self.assertFalse(result["has_modules"])

    def test_list_modules_returns_valid_json_with_expected_keys(self) -> None:
        self._make_module("toxo", display_name="Toxicology")
        result = mcp_server._list_modules({}, self.workspace)
        payload = json.loads(result)
        self.assertEqual(set(payload), {"workspace", "modules"})
        self.assertEqual(payload["workspace"], str(self.workspace.resolve()))
        modules = payload["modules"]
        self.assertIsInstance(modules, list)
        self.assertEqual(len(modules), 1)
        entry = modules[0]
        self.assertEqual(
            set(entry.keys()), {"module", "display_name", "notebooks", "root", "questions"}
        )
        self.assertEqual(entry["module"], "toxo")
        self.assertEqual(entry["display_name"], "Toxicology")

    def test_list_modules_lists_multiple_modules(self) -> None:
        self._make_module("toxo", display_name="Toxicology")
        self._make_module("pharm", display_name="Pharmacology")
        result = mcp_server._list_modules({}, self.workspace)
        modules = json.loads(result)["modules"]
        self.assertEqual(
            {entry["module"] for entry in modules}, {"toxo", "pharm"}
        )

    def test_list_modules_empty_workspace_returns_empty_modules_without_raising(
        self,
    ) -> None:
        # _discovered_modules now special-cases an empty (or missing)
        # modules/ directory instead of letting discover_modules's
        # ModuleConfigError bubble up as a ToolError -- see its docstring.
        (self.workspace / "modules").mkdir(parents=True)
        result = mcp_server._list_modules({}, self.workspace)
        payload = json.loads(result)
        self.assertEqual(payload["workspace"], str(self.workspace.resolve()))
        self.assertEqual(payload["modules"], [])

    # -- list_lectures -----------------------------------------------------
    #
    # Shape as of the multipart-grouping rewrite:
    #   {"title": ..., "recording_sources": [...], "paths": [...],
    #    "parts": N, "transcribed": bool}
    # The old "name"/"stem" keys are gone -- a multipart lecture is one unit.

    def _units(self, module_id: str = "toxo") -> list[dict]:
        result = json.loads(
            mcp_server._list_lectures({"module": module_id}, self.workspace)
        )
        return result["lectures"]

    def _by_title(self, module_id: str = "toxo") -> dict[str, dict]:
        return {unit["title"]: unit for unit in self._units(module_id)}

    def test_lecture_state_reports_artifact_paths_and_precedence(self) -> None:
        cases = (
            ((), "pending"),
            (("verbatim",), "verbatim"),
            (("draft",), "draft"),
            (("draft", "verbatim"), "draft"),
            (("transcript",), "final"),
            (("transcript", "verbatim"), "final"),
            (("transcript", "draft"), "final"),
            (("transcript", "draft", "verbatim"), "final"),
        )
        for index, (present, state) in enumerate(cases):
            with self.subTest(present=present, state=state):
                module_id = f"state{index}"
                root = self._make_module(module_id, emoji="👁️")
                (root / "Lecture" / "4- cornea.mp3").write_bytes(b"audio")
                paths = {
                    "transcript": root / "Transcripts" / "Cornea 👁️.md",
                    "draft": root / "Transcripts" / "4- cornea 👁️.md.draft.md",
                    "verbatim": root / "Verbatim" / "4- cornea.verbatim.md",
                }
                for artifact in present:
                    paths[artifact].parent.mkdir(parents=True, exist_ok=True)
                    paths[artifact].write_text("# lecture", encoding="utf-8")
                with _notebook_sources([]):
                    units = self._units(module_id)
                self.assertEqual(len(units), 1)
                unit = units[0]
                self.assertEqual(unit["state"], state)
                self.assertEqual(unit["transcribed"], state == "final")
                for artifact, path in paths.items():
                    self.assertEqual(
                        unit[artifact], str(path.resolve()) if artifact in present else None
                    )

    def test_multi_recording_state_requires_every_verbatim_and_preserves_precedence(self) -> None:
        for names in (("Corrosives Part 1", "Corrosives Part 2"),
                      ("Corrosives boys part 1", "Corrosives boys part 2", "Corrosives girls")):
            with self.subTest(names=names):
                root = self._make_module(f"states{len(names)}")
                (root / "Verbatim").mkdir()
                for name in reversed(names):
                    (root / "Lecture" / f"{name}.mp3").write_bytes(b"audio")
                expected_paths = []
                for index, name in enumerate(names):
                    path = root / "Verbatim" / f"{name}.verbatim.md"
                    path.write_text("كلام الدكتور", encoding="utf-8")
                    expected_paths.append(str(path))
                    with _notebook_sources([]):
                        unit = self._units(f"states{len(names)}")[0]
                    self.assertEqual(unit["title"], "Corrosives")
                    self.assertEqual(unit["state"], "verbatim" if index == len(names) - 1 else "pending")
                    self.assertIsNone(unit["verbatim"])
                    self.assertEqual(unit["verbatims"], expected_paths)
                draft = root / "Transcripts" / "Corrosives 🧪.md.draft.md"
                draft.write_text("# draft", encoding="utf-8")
                with _notebook_sources([]):
                    unit = self._units(f"states{len(names)}")[0]
                self.assertEqual(unit["state"], "draft")
                self.assertEqual(unit["verbatims"], expected_paths)
                final = root / "Transcripts" / "Corrosives 🧪.md"
                final.write_text("# final", encoding="utf-8")
                with _notebook_sources([]):
                    unit = self._units(f"states{len(names)}")[0]
                self.assertEqual(unit["state"], "final")
                self.assertEqual(unit["transcript"], str(final))

    def test_multipart_recordings_group_into_one_unit(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives Part 1.mp3").write_bytes(b"data")
        (root / "Lecture" / "Corrosives Part 2.mp3").write_bytes(b"data")
        units = self._units()
        self.assertEqual(len(units), 1)
        unit = units[0]
        self.assertEqual(unit["title"], "Corrosives")
        self.assertEqual(unit["parts"], 2)
        self.assertEqual(
            unit["recording_sources"],
            ["Corrosives Part 1.mp3", "Corrosives Part 2.mp3"],
        )

    def test_bare_number_parts_group_in_numeric_not_lexicographic_order(self) -> None:
        root = self._make_module("toxo")
        for name in ("Volatile 1.mp3", "Volatile 2.mp3", "Volatile 3.mp3", "Volatile 10.mp3"):
            (root / "Lecture" / name).write_bytes(b"data")
        units = self._units()
        self.assertEqual(len(units), 1)
        unit = units[0]
        self.assertEqual(unit["title"], "Volatile")
        self.assertEqual(unit["parts"], 4)
        self.assertEqual(
            unit["recording_sources"],
            ["Volatile 1.mp3", "Volatile 2.mp3", "Volatile 3.mp3", "Volatile 10.mp3"],
        )

    def test_parts_discovered_out_of_order_still_come_back_ordered(self) -> None:
        root = self._make_module("toxo")
        # Create Part 2 before Part 1 on disk.
        (root / "Lecture" / "Corrosives Part 2.mp3").write_bytes(b"data")
        (root / "Lecture" / "Corrosives Part 1.mp3").write_bytes(b"data")
        unit = self._by_title()["Corrosives"]
        self.assertEqual(
            unit["recording_sources"],
            ["Corrosives Part 1.mp3", "Corrosives Part 2.mp3"],
        )

    def test_lone_marker_is_not_retitled(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "food poisoning (1).mp3").write_bytes(b"data")
        units = self._units()
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["title"], "food poisoning (1)")
        self.assertEqual(units[0]["parts"], 1)

    def test_trailing_year_is_not_treated_as_a_part(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Revision 2024.mp3").write_bytes(b"data")
        units = self._units()
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["title"], "Revision 2024")
        self.assertEqual(units[0]["parts"], 1)

    def test_separator_forms_all_group(self) -> None:
        cases = [
            ("X - 1.mp3", "X - 2.mp3"),
            ("X.1.mp3", "X.2.mp3"),
            ("X_1.mp3", "X_2.mp3"),
            ("X(1).mp3", "X(2).mp3"),
            ("X جزء 1.mp3", "X جزء 2.mp3"),
        ]
        for index, (first, second) in enumerate(cases):
            with self.subTest(first=first, second=second):
                module_id = f"sep{index}"
                root = self._make_module(module_id)
                (root / "Lecture" / first).write_bytes(b"data")
                (root / "Lecture" / second).write_bytes(b"data")
                units = self._units(module_id)
                self.assertEqual(len(units), 1, units)
                self.assertEqual(units[0]["parts"], 2)

    def test_grouping_is_case_insensitive(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "corrosives part 1.mp3").write_bytes(b"data")
        (root / "Lecture" / "Corrosives Part 2.mp3").write_bytes(b"data")
        units = self._units()
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["parts"], 2)

    def test_transcribed_matches_group_title_with_suffix_emoji(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives Part 1.mp3").write_bytes(b"data")
        (root / "Lecture" / "Corrosives Part 2.mp3").write_bytes(b"data")
        # Real data puts the emoji as a SUFFIX, not a prefix.
        (root / "Transcripts" / "Corrosives \U0001f9ea.md").write_text(
            "# notes", encoding="utf-8"
        )
        unit = self._by_title()["Corrosives"]
        self.assertTrue(unit["transcribed"])

    def test_index_md_never_marks_a_lecture_transcribed(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Index.mp3").write_bytes(b"data")
        (root / "Transcripts" / "Index.md").write_text("# index", encoding="utf-8")
        unit = self._by_title()["Index"]
        self.assertFalse(unit["transcribed"])

    def test_non_recording_files_still_excluded(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives.mp3").write_bytes(b"data")
        (root / "Lecture" / "slides.pdf").write_bytes(b"data")
        (root / "Lecture" / "notes.docx").write_bytes(b"data")
        titles = {unit["title"] for unit in self._units()}
        self.assertEqual(titles, {"Corrosives"})

    def test_extension_matching_is_case_insensitive(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Lecture.MP3").write_bytes(b"data")
        titles = {unit["title"] for unit in self._units()}
        self.assertEqual(titles, {"Lecture"})

    def test_finds_recordings_nested_in_subfolders(self) -> None:
        root = self._make_module("toxo")
        nested = root / "Lecture" / "Week1"
        nested.mkdir(parents=True)
        (nested / "Nested.mp3").write_bytes(b"data")
        titles = {unit["title"] for unit in self._units()}
        self.assertIn("Nested", titles)

    def test_a_transcript_whose_recording_is_gone_is_still_listed(self) -> None:
        # The recording is often deleted once the transcript exists -- the audio
        # is large and the transcript is the deliverable. Listing only what can
        # still be transcribed then answers "no lectures" for a module whose
        # finished work is sitting right there.
        root = self._make_module("toxo")
        (root / "Transcripts" / "Corrosives \U0001f9ea.md").write_text(
            "# notes", encoding="utf-8"
        )
        units = self._units()
        self.assertEqual([unit["title"] for unit in units], ["Corrosives \U0001f9ea"])
        self.assertTrue(units[0]["transcribed"])
        self.assertEqual(units[0]["state"], "final")
        self.assertEqual(
            units[0]["transcript"],
            str((root / "Transcripts" / "Corrosives 🧪.md").resolve()),
        )
        self.assertIsNone(units[0]["draft"])
        self.assertIsNone(units[0]["verbatim"])
        # No audio to run a pipeline over, and the shape says so.
        self.assertEqual(units[0]["recording_sources"], [])
        self.assertEqual(units[0]["parts"], 0)

    def test_a_transcript_is_not_listed_twice_beside_its_recording(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives.mp3").write_bytes(b"data")
        (root / "Transcripts" / "Corrosives \U0001f9ea.md").write_text(
            "# notes", encoding="utf-8"
        )
        units = self._units()
        self.assertEqual([unit["title"] for unit in units], ["Corrosives"])
        self.assertTrue(units[0]["transcribed"])

    def test_slides_and_books_come_back_as_materials_not_lectures(self) -> None:
        # A chat model asked what a module holds, and given only lectures, will
        # list the folder itself and present "Book.pdf" as a lecture awaiting
        # transcription. Naming them is what stops that.
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives.mp3").write_bytes(b"data")
        (root / "Lecture" / "Book.pdf").write_bytes(b"data")
        (root / "Lecture" / "slides.pptx").write_bytes(b"data")
        payload = json.loads(mcp_server._list_lectures({"module": "toxo"}, self.workspace))
        self.assertEqual([unit["title"] for unit in payload["lectures"]], ["Corrosives"])
        self.assertEqual(
            sorted(item["name"] for item in payload["materials"]),
            ["Book.pdf", "slides.pptx"],
        )

    def test_uploaded_recordings_are_lectures_even_with_nothing_on_disk(self) -> None:
        # The audio is large and the transcript is the deliverable, so a
        # recording is routinely uploaded once and deleted. Listing only the
        # disk reported a module with thirteen recordings in its notebook as
        # three lectures, all of them done.
        self._make_module("toxo")
        remote = [
            _remote("Corrosive 1.mp3", "audio"),
            _remote("Corrosive 2.mp3", "audio"),
            _remote("Plant poisons.mp3", "audio"),
            _remote("Book.pdf", "pdf"),
        ]
        with _notebook_sources(remote):
            payload = json.loads(
                mcp_server._list_lectures({"module": "toxo"}, self.workspace))

        units = {unit["title"]: unit for unit in payload["lectures"]}
        # The two parts are one lecture, and the PDF is not one at all.
        self.assertEqual(sorted(units), ["Corrosive", "Plant poisons"])
        self.assertTrue(units["Corrosive"]["in_notebook_only"])
        self.assertEqual(units["Corrosive"]["parts"], 2)
        # Nothing openable is offered for a source that has no file.
        self.assertEqual(units["Corrosive"]["paths"], [])

    def test_a_recording_on_disk_is_not_listed_twice_when_also_uploaded(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Plant poisons.mp3").write_bytes(b"data")
        with _notebook_sources([_remote("Plant poisons.mp3", "audio")]):
            payload = json.loads(
                mcp_server._list_lectures({"module": "toxo"}, self.workspace))

        units = payload["lectures"]
        self.assertEqual([unit["title"] for unit in units], ["Plant poisons"])
        self.assertFalse(units[0]["in_notebook_only"])

    def test_an_unreachable_notebook_still_lists_the_local_half(self) -> None:
        # The notebook is across a network behind an unofficial client. A panel
        # showing nothing because a listing timed out would be worse than one
        # showing what it has and saying what it could not reach.
        root = self._make_module("toxo")
        (root / "Lecture" / "OPs.mp3").write_bytes(b"data")
        with _notebook_sources(RuntimeError("nlm: connection refused")):
            payload = json.loads(
                mcp_server._list_lectures({"module": "toxo"}, self.workspace))

        self.assertEqual([unit["title"] for unit in payload["lectures"]], ["OPs"])
        self.assertIn("connection refused", payload["warning"])

    def test_list_lectures_unknown_module_raises_tool_error_naming_it(self) -> None:
        self._make_module("toxo")
        with self.assertRaises(ToolError) as context:
            mcp_server._list_lectures({"module": "no-such-module"}, self.workspace)
        self.assertIn("no-such-module", str(context.exception))

    # -- through the MCP layer -------------------------------------------

    def test_list_lectures_through_server_handle_returns_parseable_json(self) -> None:
        root = self._make_module("toxo")
        (root / "Lecture" / "Corrosives Part 1.mp3").write_bytes(b"data")
        (root / "Lecture" / "Corrosives Part 2.mp3").write_bytes(b"data")
        stream = io.StringIO()
        server = mcp_server.Server(workspace=self.workspace, stdout=stream)
        server.handle(
            _request("tools/call", params=_call_params("list_lectures", module="toxo"))
        )
        result = _lines(stream)[0]["result"]
        self.assertFalse(result.get("isError", False))
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(payload["module"], "toxo")
        self.assertEqual(len(payload["lectures"]), 1)
        self.assertEqual(payload["lectures"][0]["title"], "Corrosives")
        self.assertEqual(payload["lectures"][0]["parts"], 2)

    def test_a_module_named_by_its_display_name_is_found(self) -> None:
        # Regression: asked to transcribe from "Ophthalmology", the model
        # passed the display name the student used, got "No module named",
        # and the run ended before its first step.
        root = self._make_module("ophtha", display_name="Ophthalmology")
        (root / "Lecture" / "Conjunctiva.mp3").write_bytes(b"data")
        stream = io.StringIO()
        server = mcp_server.Server(workspace=self.workspace, stdout=stream)
        server.handle(
            _request("tools/call", params=_call_params("list_lectures", module="ophthalmology"))
        )
        result = _lines(stream)[0]["result"]
        self.assertFalse(result.get("isError", False), result)
        self.assertEqual(json.loads(result["content"][0]["text"])["module"], "ophtha")

    def test_a_name_no_module_carries_still_says_so(self) -> None:
        self._make_module("ophtha", display_name="Ophthalmology")
        stream = io.StringIO()
        server = mcp_server.Server(workspace=self.workspace, stdout=stream)
        server.handle(
            _request("tools/call", params=_call_params("list_lectures", module="Dermatology"))
        )
        result = _lines(stream)[0]["result"]
        self.assertTrue(result.get("isError"))
        self.assertIn("No module named 'Dermatology'", result["content"][0]["text"])

    def test_two_recordings_ending_in_different_years_should_not_merge(self) -> None:
        # Regression: PART_SUFFIX once matched a two-digit suffix of a longer
        # digit run, so these two split as "Revision 20" + part 24/25 and
        # merged into one fake lecture. The (?<!\d) guard is what stops it.
        root = self._make_module("toxo")
        (root / "Lecture" / "Revision 2024.mp3").write_bytes(b"data")
        (root / "Lecture" / "Revision 2025.mp3").write_bytes(b"data")
        titles = {unit["title"] for unit in self._units()}
        self.assertEqual(titles, {"Revision 2024", "Revision 2025"})


class PartSplitAndGroupingUnitTests(unittest.TestCase):
    """_part_split and _group_recordings are the domain logic here --
    test them directly, with no filesystem involved."""

    def test_title_normalization_claims_only_matching_transcripts(self) -> None:
        cases = (
            ("Ｌｅｃ１２：Ｃｏｒｎｅａ", "cornea", True),
            ("محاضرة ١٢) Cornea", "cornea", True),
            ("lecture 123 cornea", "cornea", True),
            ("lec4_cornea", "cornea", True),
            ("Cornea👩🏽‍⚕️", "cornea", True),
            ("Cornea1️⃣", "cornea1", True),
            ("Straße ς", "STRASSE σ", True),
            ("Lacrimal__s", "lacrimal–s—ystem", True),
            ("Eye", "eye guide", True),
            ("Orbit", "orbital", False),
            ("Cornea", "corneal", True),
            ("ı", "i", False),
            ("👁️", "cornea", False),
            ("1234- cornea", "cornea", False),
            ("4- 5- cornea", "cornea", False),
            ("cornea", "guide cornea", False),
            ("3", "3", True),
        )
        for title, transcript, matched in cases:
            with self.subTest(title=title, transcript=transcript):
                units = mcp_server._classify_lectures(
                    [Path("Lecture") / f"{title}.mp3"], [f"{transcript}.md"]
                )
                self.assertEqual(units[0]["transcribed"], matched)
                self.assertEqual(
                    [unit["title"] for unit in units],
                    [title] if matched else [title, transcript],
                )

    def test_part_split_recognizes_part_word(self) -> None:
        self.assertEqual(mcp_server._part_split("Corrosives Part 1"), ("Corrosives", 1))
        self.assertEqual(mcp_server._part_split("Corrosives Part 2"), ("Corrosives", 2))

    def test_part_split_recognizes_bare_number(self) -> None:
        self.assertEqual(mcp_server._part_split("Volatile 1"), ("Volatile", 1))
        self.assertEqual(mcp_server._part_split("Volatile 10"), ("Volatile", 10))

    def test_part_split_recognizes_various_separators(self) -> None:
        self.assertEqual(mcp_server._part_split("X - 1")[1], 1)
        self.assertEqual(mcp_server._part_split("X.1")[1], 1)
        self.assertEqual(mcp_server._part_split("X_1")[1], 1)
        self.assertEqual(mcp_server._part_split("X(1)")[1], 1)
        self.assertEqual(mcp_server._part_split("X جزء 1")[1], 1)

    def test_part_split_whole_stem_being_a_number_has_no_title(self) -> None:
        # "The whole stem was a number. There is no title to group under."
        stem, part = mcp_server._part_split("1")
        self.assertEqual(stem, "1")
        self.assertIsNone(part)

    def test_part_split_no_marker_returns_none(self) -> None:
        self.assertEqual(mcp_server._part_split("Index"), ("Index", None))

    def test_group_recordings_singleton_keeps_raw_stem_as_title(self) -> None:
        units = mcp_server._group_recordings([Path("/x/food poisoning (1).mp3")])
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["title"], "food poisoning (1)")
        self.assertEqual(units[0]["parts"], 1)

    def test_group_recordings_orders_numeric_parts_out_of_order_input(self) -> None:
        units = mcp_server._group_recordings(
            [
                Path("/x/Volatile 10.mp3"),
                Path("/x/Volatile 2.mp3"),
                Path("/x/Volatile 1.mp3"),
                Path("/x/Volatile 3.mp3"),
            ]
        )
        self.assertEqual(len(units), 1)
        self.assertEqual(
            units[0]["recording_sources"],
            ["Volatile 1.mp3", "Volatile 2.mp3", "Volatile 3.mp3", "Volatile 10.mp3"],
        )

    def test_group_recordings_groups_case_insensitively(self) -> None:
        units = mcp_server._group_recordings(
            [Path("/x/corrosives part 1.mp3"), Path("/x/Corrosives Part 2.mp3")]
        )
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0]["parts"], 2)

    def test_group_recordings_preserves_input_order_of_distinct_titles(self) -> None:
        units = mcp_server._group_recordings(
            [Path("/x/Bravo.mp3"), Path("/x/Alpha.mp3")]
        )
        self.assertEqual([unit["title"] for unit in units], ["Bravo", "Alpha"])


class CompleteTranscriptContractTests(unittest.TestCase):
    def test_cornea_regression_reports_each_broken_section_heading(self) -> None:
        # The Cornea transcript shipped three non-contract headings.
        transcript = "\n\n".join(SECTION_HEADINGS).replace(
            "## 🌟 IMP Points", "## ⭐ IMP Points"
        ).replace("## ✍️ Written Questions", "## 📝 Written Questions").replace(
            "## 🩺 Clinical Cases", "## 🏥 Clinical Cases"
        )
        errors = mcp_server.validate_complete_transcript(transcript)

        for expected in (
            "expected '## 🌟 IMP Points', found '## ⭐ IMP Points'",
            "expected '## ✍️ Written Questions', found '## 📝 Written Questions'",
            "expected '## 🩺 Clinical Cases', found '## 🏥 Clinical Cases'",
        ):
            self.assertTrue(any(expected in error for error in errors), expected)

    def test_wrong_question_heading_is_reported_in_its_section(self) -> None:
        transcript = "\n\n".join(
            (
                SECTION_HEADINGS[0],
                SECTION_HEADINGS[1],
                SECTION_HEADINGS[2] + "\n\n### Question 1",
                SECTION_HEADINGS[3],
                SECTION_HEADINGS[4],
            )
        )

        errors = mcp_server.validate_complete_transcript(transcript)

        self.assertTrue(
            any("expected '### MCQ N', found '### Question 1'" in error for error in errors)
        )

    def test_cornea_substance_ratio_is_refused_and_corrosives_ratio_passes(self) -> None:
        # Retain the short Cornea / complete multipart Corrosives regression
        # without depending on a student's private module files.
        transcript = "\n\n".join(SECTION_HEADINGS) + "\n" + "شرح الدكتور " * 50
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cornea_verbatim = root / "cornea.verbatim.md"
            cornea_verbatim.write_text("كلام الدكتور " * 2000, encoding="utf-8")
            errors = mcp_server.validate_complete_transcript(
                transcript, verbatim_sources=(cornea_verbatim,),
            )
            ratio = len(transcript.encode("utf-8")) / len(cornea_verbatim.read_bytes())
            ratio_error = next(error for error in errors if "substance ratio" in error)
            self.assertIn(f"{ratio:.1%}", ratio_error)
            self.assertIn("expected at least 25.0%", ratio_error)

            sources = (root / "corrosives-1.verbatim.md", root / "corrosives-2.verbatim.md")
            for source in sources:
                source.write_text("كلام الدكتور " * 150, encoding="utf-8")
            errors = mcp_server.validate_complete_transcript(
                transcript, verbatim_sources=sources,
            )
            self.assertFalse(any("substance ratio" in error for error in errors))
