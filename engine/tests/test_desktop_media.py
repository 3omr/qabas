"""Telegram and WhatsApp containers must reach both verbatim routes."""

import json
import sys
from argparse import Namespace
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(
    0, str(Path(__file__).parents[1] / "scripts")
)
import mcp_server
import run_transcription
import source_preparation
import universal_transcribe
from engines.notebooklm_raw import NotebookLMRawEngine
from engines.whisper import WhisperEngine
from module_registry import discover_modules
from source_naming import normalize_source_stem
from transcriber_models import RemoteSource


@pytest.mark.parametrize(
    "suffix",
    [".oga", ".ogg", ".opus", ".m4a", ".mp3", ".wav", ".aac", ".webm", ".mp4", ".amr"],
)
def test_common_message_containers_are_recordings_and_reach_both_routes(
    tmp_path, monkeypatch, suffix
):
    root = tmp_path / "modules" / "pediatrics"
    for folder in ("Lecture", "Questions", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "module_id": "pediatrics",
                "display_name": "Pediatrics",
                "notebook": {"id": "test-notebook"},
                "output": {"emoji": "👶", "language": "Egyptian Arabic"},
            }
        ),
        encoding="utf-8",
    )
    title = "Introduction & Growth - important point"
    recording = root / "Lecture" / (title + suffix)
    recording.write_bytes(b"audio fixture")
    monkeypatch.setattr("nlm_client.list_remote_sources", lambda *_: [])
    listing = json.loads(mcp_server._list_lectures({"module": "pediatrics"}, tmp_path))
    assert listing["lectures"][0]["recording_sources"] == [recording.name]
    assert listing["materials"] == []
    manifest = run_transcription.generate_auto_manifest(
        root, recording.name, discover_remote=False
    )
    assert json.loads(manifest.read_text(encoding="utf-8"))["recording_sources"] == [
        recording.name
    ]
    module = discover_modules(tmp_path)[0]
    context = run_transcription.LauncherContext(
        Path(universal_transcribe.__file__), universal_transcribe, {}, module, lambda: ()
    )
    for route in ("whisper", "notebooklm-raw"):
        assert (
            run_transcription._transcription_recording(
                Namespace(lecture=title, engine=route), context
            )
            == recording
        )
    remote = RemoteSource(
        "audio-id",
        recording.name,
        recording.name.casefold(),
        normalize_source_stem(recording.name),
        "audio",
    )
    notebook = NotebookLMRawEngine(
        notebook_uuid="test-notebook",
        source_lister=lambda *_: [remote],
        content_fetcher=lambda *_: "Doctor's words",
    )
    assert notebook.transcribe(recording).text == "Doctor's words"

    class SpeechModel:
        def transcribe(self, path, **kwargs):
            assert path == str(recording)
            return [
                SimpleNamespace(start=0, end=1, text="Doctor's words")
            ], SimpleNamespace(language="en", duration=1)

    whisper = WhisperEngine(
        device="cpu",
        compute_type="int8",
        model_factory=lambda *_args, **_kwargs: SpeechModel(),
    )
    assert whisper.transcribe(recording).text == "Doctor's words"
    if suffix in {".oga", ".opus", ".amr", ".webm"}:
        entry = source_preparation.PreparationEntry(
            relative_path=f"Lecture/{recording.name}", role="recording", action="auto"
        )
        action, output_suffix, hint = source_preparation._auto_action(
            recording, entry, 100_000
        )
        assert (action, output_suffix) == ("convert", ".m4a")
        assert "ffmpeg" in hint
        monkeypatch.setattr(source_preparation.shutil, "which", lambda _: None)
        with pytest.raises(source_preparation.PreparationError, match="ffmpeg"):
            source_preparation._convert_source(recording, tmp_path / "converted.m4a")
