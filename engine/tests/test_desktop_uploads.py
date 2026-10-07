"""Regressions from Critical thinking's missing NotebookLM audio (October 2026)."""

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import mcp_server
import nlm_client
import recording_uploads
from run_transcription import generate_auto_manifest


class FakeNlm:
    def __init__(self):
        self.sources = []
        self.added = []
        self.commands = []
        self.processing_polls = 0
        self.keep_processing = False
        self.add_error = False

    def __call__(self, command, **kwargs):
        self.commands.append(command)
        if command[1:3] == ["source", "list"]:
            if self.processing_polls:
                self.processing_polls -= 1
            elif not self.keep_processing:
                for source in self.sources:
                    if source.get("status") not in {"error", "failed"}:
                        source["status"] = "ready"
            return subprocess.CompletedProcess(command, 0, json.dumps(self.sources), "")
        if command[1:3] == ["source", "add"]:
            path = Path(command[command.index("--file") + 1])
            self.added.append(path)
            self.sources.append({"id": f"audio-{len(self.added)}", "title": command[command.index("--title") + 1] if "--title" in command else path.name,
                                 "type": "audio", "status": "processing"})
            if self.add_error:
                return subprocess.CompletedProcess(command, 1, "", "source add timed out")
            assert "--wait" in command and "--wait-timeout" in command
            return subprocess.CompletedProcess(command, 0, "{}", "")
        if command[1:3] == ["source", "delete"]:
            self.sources = [source for source in self.sources if source["id"] != command[3]]
            return subprocess.CompletedProcess(command, 0, "{}", "")
        if "--output" in command:
            assert command[command.index("--engine") + 1] == "notebooklm-raw"
            path = Path(command[command.index("--output") + 1])
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("Complete doctor's explanation", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0, "Done", "")
        raise AssertionError(f"Unexpected command: {command}")


@pytest.fixture
def critical_thinking(tmp_path, monkeypatch):
    root = tmp_path / "modules" / "critical-thinking"
    for folder in ("Lecture", "Questions", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(json.dumps({
        "schema_version": 1, "module_id": "critical-thinking",
        "display_name": "Critical Thinking", "aliases": ["ct"],
        "notebooks": [{"id": "ct-notebook", "title": "Critical Thinking"}],
        "notebook_profile": "student", "lecture_slides": {},
    }), encoding="utf-8")
    recording = root / "Lecture" / "Critical thinking girls.m4a"
    recording.write_bytes(b"compressed recording")
    original = root / ".transcriber-cache" / "originals" / recording.name
    original.parent.mkdir(parents=True)
    original.write_bytes(b"large original recording")
    config_path = tmp_path / "nlm-config.json"
    config_path.write_text(json.dumps({"nlm_executable": sys.executable}), encoding="utf-8")
    monkeypatch.setattr(nlm_client, "CONFIG_PATH", str(config_path))
    monkeypatch.setattr(nlm_client, "_INVENTORY_CACHE_ROOT", root / ".transcriber-cache" / "inventory")
    fake = FakeNlm()
    monkeypatch.setattr(recording_uploads, "compress_recording", lambda path, *_: path)
    monkeypatch.setattr(subprocess, "run", fake)
    monkeypatch.setattr(recording_uploads.time, "sleep", lambda _: None)
    return root, recording, fake


def call_tool(workspace, name, **arguments):
    stream = io.StringIO()
    server = mcp_server.Server(workspace=workspace, stdout=stream)
    server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": name, "arguments": arguments}})
    return json.loads(stream.getvalue())["result"]


@pytest.mark.parametrize("redo", [False, True])
def test_begin_missing_audio_uploads_and_opens_lecture_in_same_call(critical_thinking, tmp_path, redo):
    root, recording, fake = critical_thinking
    response = call_tool(tmp_path, "begin_lecture", module="ct", lecture="Critical thinking", redo=redo)
    assert not response["isError"]
    payload = json.loads(response["content"][0]["text"])
    assert payload["route"] == "verbatim"
    assert payload["uploaded"] == [recording.name]
    assert payload["text"] == "Complete doctor's explanation"
    assert fake.added == [recording]
    assert all("--profile" in command and "student" in command for command in fake.commands if command[1] == "source")
    assert "slides" not in json.loads(Path(payload["manifest_path"]).read_text())
    assert not list((root / "Questions").iterdir())
    repeated = json.loads(mcp_server._begin_lecture({"module": "ct", "lecture": "Critical thinking", "redo": redo}, tmp_path))
    assert repeated["uploaded"] == []
    assert fake.added == [recording]


def test_confirmed_upload_waits_for_ready_then_begin_reuses_uploaded_audio(critical_thinking, tmp_path):
    root, recording, fake = critical_thinking
    fake.processing_polls = 3
    unrelated = root / "Lecture" / "Unrelated.mp3"
    unrelated.write_bytes(b"unrequested recording")
    response = call_tool(tmp_path, "upload_recordings", module="ct",
                         files=[str(recording)], confirmed=True)
    assert not response["isError"]
    payload = json.loads(response["content"][0]["text"])
    assert payload["status"] == "ready"
    assert payload["files"][0]["status"] == "uploaded"
    assert payload["files"][0]["source_id"] == "audio-1"
    assert fake.added == [recording]
    payload = json.loads(mcp_server._begin_lecture(
        {"module": "ct", "lecture": "Critical thinking"}, tmp_path))
    assert payload["route"] == "verbatim"
    assert payload["text"] == "Complete doctor's explanation"
    assert fake.added == [recording]


def test_partial_cohort_uploads_only_missing_local_recording(critical_thinking, tmp_path):
    root, recording, fake = critical_thinking
    boys = root / "Lecture" / "Critical thinking boys.m4a"
    boys.write_bytes(b"already transcribed recording")
    (root / "Verbatim").mkdir()
    (root / "Verbatim" / "Critical thinking boys.verbatim.md").write_text(
        "Complete boys explanation", encoding="utf-8"
    )
    part_two = root / "Lecture" / "Critical thinking girls part 2.m4a"
    part_two.write_bytes(b"already uploaded recording")
    fake.sources = [{"id": "part-two", "title": part_two.name, "type": "audio", "status": "ready"}]
    payload = json.loads(mcp_server._begin_lecture(
        {"module": "ct", "lecture": "Critical thinking"}, tmp_path))
    assert payload["route"] == "verbatim"
    assert payload["uploaded"] == [recording.name]
    assert fake.added == [recording]


@pytest.mark.parametrize("filename", ["slides.pdf", "../Questions/audio.m4a", "absent.mp3", "linked.m4a", "."])
def test_upload_rejects_non_recordings_and_paths_outside_lecture(critical_thinking, tmp_path, filename):
    root, recording, fake = critical_thinking
    (root / "Lecture" / "slides.pdf").write_bytes(b"slides")
    outside = root / "Questions" / "audio.m4a"
    outside.write_bytes(b"outside recording")
    (root / "Lecture" / "linked.m4a").symlink_to(outside)
    response = call_tool(tmp_path, "upload_recordings", module="ct", files=[str(recording), filename], confirmed=True)
    assert response["isError"]
    assert not fake.commands
    assert not fake.added


def test_already_uploaded_recording_is_reported_without_reupload(critical_thinking, tmp_path):
    _root, recording, fake = critical_thinking
    fake.sources = [{"id": "existing", "title": recording.name, "type": "audio", "status": "ready"}]
    response = call_tool(tmp_path, "upload_recordings", module="ct", files=[recording.name], confirmed=True)
    payload = json.loads(response["content"][0]["text"])
    assert payload["status"] == "ready"
    assert payload["files"][0]["status"] == "already-uploaded"
    assert payload["files"][0]["source_id"] == "existing"
    assert not fake.added


@pytest.mark.parametrize("confirmed", [False, None, "true", 1])
def test_unconfirmed_recording_upload_is_refused_before_nlm(critical_thinking, tmp_path, confirmed):
    _root, recording, fake = critical_thinking
    arguments = {"module": "ct", "files": [str(recording)]}
    if confirmed is not None:
        arguments["confirmed"] = confirmed
    response = call_tool(tmp_path, "upload_recordings", **arguments)
    assert response["isError"]
    assert "confirmed" in response["content"][0]["text"]
    assert not fake.commands


def test_processing_timeout_and_retry_never_duplicate_upload(critical_thinking, tmp_path, monkeypatch):
    _root, recording, fake = critical_thinking
    fake.keep_processing = True
    monkeypatch.setattr(recording_uploads, "READY_TIMEOUT_SECONDS", 0)
    arguments = {"module": "ct", "files": [str(recording)], "confirmed": True}
    first = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    second = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    assert first["status"] == second["status"] == "processing"
    assert "timeout" in first["files"][0]["message"]
    assert fake.added == [recording]
    fake.keep_processing = False
    ready = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    assert ready["status"] == "ready"
    assert ready["files"][0]["status"] == "already-uploaded"
    assert fake.added == [recording]


def test_source_add_timeout_with_processing_audio_does_not_reupload(critical_thinking, tmp_path, monkeypatch):
    _root, recording, fake = critical_thinking
    fake.add_error = fake.keep_processing = True
    monkeypatch.setattr(recording_uploads, "READY_TIMEOUT_SECONDS", 0)
    arguments = {"module": "ct", "files": [str(recording)], "confirmed": True}
    first = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    assert "source add timed out" in first["files"][0]["error"]
    mcp_server._upload_recordings(arguments, tmp_path)
    assert fake.added == [recording]


@pytest.mark.parametrize("remote_slides", [False, True])
def test_auto_manifest_omits_slides_without_a_matching_local_file(critical_thinking, remote_slides):
    root, _recording, fake = critical_thinking
    (root / "Lecture" / "Critical thinking.pdf").mkdir()
    if remote_slides:
        fake.sources = [{"id": "remote-slides", "title": "Critical thinking.pdf", "type": "pdf"}]
    manifest = generate_auto_manifest(root, "Critical thinking", sys.executable)
    assert "slides" not in json.loads(manifest.read_text())


def test_begin_repairs_cached_phantom_slides_on_retry(critical_thinking, tmp_path):
    root, _recording, _fake = critical_thinking
    manifest = generate_auto_manifest(root, "Critical thinking", discover_remote=False)
    payload = json.loads(manifest.read_text())
    payload["slides"] = {"path": "Lecture/Critical thinking.pdf", "action": "auto"}
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    response = json.loads(mcp_server._begin_lecture(
        {"module": "ct", "lecture": "Critical thinking"}, tmp_path))
    assert response["route"] == "verbatim"
    assert "slides" not in json.loads(manifest.read_text())


@pytest.mark.parametrize("failure", ["processing", "upload", "offline"])
def test_begin_upload_failure_names_files_and_reason_without_starting_engine(critical_thinking, tmp_path, monkeypatch, failure):
    _root, recording, fake = critical_thinking
    monkeypatch.setattr(recording_uploads, "READY_TIMEOUT_SECONDS", 0)
    fake.keep_processing = True
    fake.add_error = failure == "upload"
    if failure == "offline":
        def offline(command, **kwargs):
            if command[1:3] == ["source", "add"]:
                return subprocess.CompletedProcess(command, 1, "", "connection refused")
            return fake(command, **kwargs)
        monkeypatch.setattr(subprocess, "run", offline)
    payload = json.loads(mcp_server._begin_lecture({"module": "ct", "lecture": "Critical thinking"}, tmp_path))
    assert payload["status"] == payload["route"] == "needs_upload"
    assert [entry["name"] for entry in payload["files"]] == [recording.name]
    assert payload["reason"]
    assert payload["uploaded"] == []
    assert not list((_root / "Verbatim").glob("*.md"))
    assert all("--engine" not in command for command in fake.commands)
    assert "Ask" not in payload["next"]


@pytest.mark.parametrize("status", ["error", "failed"])
def test_failed_remote_recording_is_reuploaded_without_changing_original(critical_thinking, tmp_path, monkeypatch, status):
    _root, recording, fake = critical_thinking
    original = recording.read_bytes()
    fake.sources = [{"id": "failed-audio", "title": recording.name, "type": "audio", "status": status}]
    monkeypatch.setattr(recording_uploads, "READY_TIMEOUT_SECONDS", 0)
    arguments = {"module": "ct", "files": [str(recording)], "confirmed": True}
    payload = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    assert payload["status"] == "ready"
    assert payload["files"][0]["source_id"] == "audio-1"
    assert fake.added == [recording]
    assert recording.read_bytes() == original
    assert all(source["id"] != "failed-audio" for source in fake.sources)
    assert [command[2] for command in fake.commands if command[1:3] in [["source", "add"], ["source", "delete"]]] == ["add", "delete"]
    repeated = json.loads(mcp_server._upload_recordings(arguments, tmp_path))
    assert repeated["files"][0]["status"] == "already-uploaded"
    assert fake.added == [recording]


def test_different_audio_extension_is_not_a_replacement_for_failed_original(critical_thinking, tmp_path, monkeypatch):
    _root, recording, fake = critical_thinking
    other = recording.with_suffix(".mp3").name
    fake.sources = [{"id": "failed-original", "title": recording.name, "type": "audio", "status": "error"},
                    {"id": "other-recording", "title": other, "type": "audio", "status": "ready"}]
    monkeypatch.setattr(recording_uploads, "READY_TIMEOUT_SECONDS", 0)
    payload = json.loads(mcp_server._upload_recordings({"module": "ct", "files": [str(recording)], "confirmed": True}, tmp_path))
    assert payload["files"][0]["source_id"] == "audio-1"
    assert fake.added == [recording]
    assert any(source["id"] == "other-recording" for source in fake.sources)
    assert not any(source["id"] == "failed-original" for source in fake.sources)


def test_compressed_recording_readiness_uses_original_upload_title(critical_thinking, tmp_path, monkeypatch):
    root, recording, fake = critical_thinking
    original = recording.with_suffix(".wav")
    recording.rename(original)
    prepared = root / ".transcriber-cache" / "recordings" / recording.name
    prepared.parent.mkdir(parents=True)
    prepared.write_bytes(b"smaller AAC")
    monkeypatch.setattr(recording_uploads, "compress_recording", lambda *_: prepared)
    response = call_tool(tmp_path, "upload_recordings", module="ct", files=[str(original)], confirmed=True)
    payload = json.loads(response["content"][0]["text"])
    assert payload["status"] == "ready"
    assert payload["files"][0]["source_id"] == "audio-1"
    assert fake.added == [prepared]
    assert fake.sources[0]["title"] == original.name
    assert original.read_bytes() == b"compressed recording"


def test_persistent_configuration_overrides_frozen_bundle_defaults(tmp_path, monkeypatch):
    persistent = tmp_path / "engine-settings.json"
    persistent.write_text(json.dumps({"recording_upload_bitrate_kbps": 64}), encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "ephemeral-bundle"), raising=False)
    monkeypatch.setattr(nlm_client, "CONFIG_PATH", str(tmp_path / "ephemeral-bundle" / "config.json"))
    monkeypatch.setenv("TRANSCRIBER_CONFIG_PATH", str(persistent))
    assert nlm_client.load_config()["recording_upload_bitrate_kbps"] == 64


@pytest.mark.parametrize("contents", [None, "{", "[]"])
def test_explicit_persistent_configuration_fails_loud_when_invalid(tmp_path, monkeypatch, contents):
    persistent = tmp_path / "engine-settings.json"
    if contents is not None:
        persistent.write_text(contents, encoding="utf-8")
    monkeypatch.setenv("TRANSCRIBER_CONFIG_PATH", str(persistent))
    with pytest.raises(nlm_client.Phase0Error, match="TRANSCRIBER_CONFIG_PATH"):
        nlm_client.load_config()
