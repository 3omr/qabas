"""Regressions for endo transcripts with editorial titles and cohort recordings."""

import json
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import mcp_server
import nlm_client
import run_transcription as launcher
import universal_transcribe as engine
from transcriber_models import RemoteSource

ENDO_UNITS = {
    "1st lecture": (
        "Introduction to Endocrinology 🧬",
        ("1st lecture boys.mp3", "1st lecture girls.mp3"),
    ),
    "Hypothyroidism": (
        "Hypothyroidism & Autoimmune Thyroiditis 🧬",
        ("Hypothyroidism boys.m4a", "Hypothyroidism girls.m4a"),
    ),
    "Hypothyroidism 2": (
        "Hypothyroidism - Clinical Picture, Diagnosis & Treatment 🧬",
        ("Hypothyroidism 2 boys.m4a", "Hypothyroidism 2 girls.m4a"),
    ),
    "Hyperthyroidism": (
        "Hyperthyroidism & Thyrotoxicosis 🧬",
        ("Hyperthyroidism girls.m4a",),
    ),
}


def write_transcript(root: Path, title: str, sources: tuple[str, ...]) -> Path:
    path = root / "Transcripts" / f"{title}.md"
    citations = " · ".join(f"`{name}`" for name in sources)
    path.write_text(
        f"# {title}\n\n> **الملفات المعتمدة:** {citations}\n\n---\n\n## Guide\n",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def endo_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "modules" / "endo"
    for folder in ("Lecture", "Transcripts", "Questions", "Verbatim"):
        (root / folder).mkdir(parents=True)
    (root / "module.json").write_text(json.dumps({
        "schema_version": 1, "module_id": "endo", "display_name": "Endocrinology",
        "notebook": {"id": "uuid-endo", "title": "Endocrinology", "profile": None},
        "output": {"emoji": "🧬", "language": "Egyptian Arabic"},
    }), encoding="utf-8")
    for title, recordings in ENDO_UNITS.values():
        for recording in recordings:
            (root / "Lecture" / recording).write_bytes(b"audio")
            (root / "Verbatim" / f"{Path(recording).stem}.verbatim.md").write_text(
                "كلام الدكتور", encoding="utf-8"
            )
        write_transcript(root, title, (*recordings, "1st lecture.pdf", "Questions/exam-index.json"))
    (root / "Lecture" / "1st lecture.pdf").write_bytes(b"slides")
    (root / "Transcripts" / "Index.md").write_text("# Index", encoding="utf-8")
    monkeypatch.setattr(nlm_client, "load_config", lambda: {})
    monkeypatch.setattr(nlm_client, "list_remote_sources", lambda *args: [])
    return root


def listed_units(root: Path) -> list[dict]:
    return json.loads(mcp_server._list_lectures({"module": "endo"}, root.parents[1]))["lectures"]


def test_endo_headers_attach_finals_once_and_keep_recording_unit_titles(endo_module: Path) -> None:
    units = listed_units(endo_module)
    assert {unit["title"] for unit in units} == set(ENDO_UNITS)
    assert len(units) == 4
    for unit in units:
        title, recordings = ENDO_UNITS[unit["title"]]
        assert unit["state"] == "final"
        assert unit["transcribed"] is True
        assert unit["transcript"] == str(endo_module / "Transcripts" / f"{title}.md")
        assert unit["transcript_title"] == title
        assert unit["recording_sources"] == list(recordings)


@pytest.mark.parametrize("recordings", [
    (), ("1st lecture.pdf",),
    ("1st lecture boys.mp3",),
    ("Deleted boys.mp3", "Deleted girls.mp3"),
])
def test_recording_citations_disable_title_fallback_and_require_whole_unit(
    endo_module: Path, recordings: tuple[str, ...]
) -> None:
    for path in (endo_module / "Transcripts").glob("*.md"):
        if path.name != "Index.md":
            path.unlink()
    transcript = write_transcript(endo_module, "1st lecture 🧬", recordings)
    with transcript.open("a", encoding="utf-8") as body:
        body.write(
            "> **الملفات المعتمدة:** `1st lecture boys.mp3` · `1st lecture girls.mp3`\n"
        )
    units = listed_units(endo_module)
    introduction = next(unit for unit in units if unit["title"] == "1st lecture")
    has_recording_citations = bool(recordings and Path(recordings[0]).suffix == ".mp3")
    assert introduction["state"] == ("verbatim" if has_recording_citations else "final")
    orphans = [unit for unit in units if not unit["recording_sources"]]
    assert [unit["title"] for unit in orphans] == ([transcript.stem] if has_recording_citations else [])
    if orphans:
        assert orphans[0]["state"] == "final"


@pytest.mark.parametrize("extension", sorted(mcp_server.RECORDING_EXTENSIONS))
def test_header_recordings_match_paths_and_case_for_all_supported_extensions(
    endo_module: Path, extension: str
) -> None:
    recording = f"Unrelated{extension}"
    (endo_module / "Lecture" / recording).write_bytes(b"audio")
    transcript = write_transcript(
        endo_module, "No shared title words", (f"Lecture\\UNRELATED{extension.upper()}",)
    )
    units = listed_units(endo_module)
    matched = [unit for unit in units if unit["transcript"] == str(transcript)]
    assert len(matched) == 1
    assert matched[0]["title"] == "Unrelated"
    assert matched[0]["state"] == "final"


@pytest.mark.parametrize("title", list(ENDO_UNITS))
@pytest.mark.parametrize("tool", ["begin_lecture", "prepare_manifest", "auto_manifest"])
def test_completed_units_do_not_start_again_or_create_manifests(
    endo_module: Path, title: str, tool: str
) -> None:
    with pytest.raises((mcp_server.ToolError, launcher.LauncherError), match="already transcribed"):
        if tool == "auto_manifest":
            launcher.generate_auto_manifest(endo_module, title)
        else:
            mcp_server.TOOLS_BY_NAME[tool].handler(
                {"module": "endo", "lecture": title}, endo_module.parents[1]
            )
    assert not (endo_module / ".transcriber-cache" / "manifests").exists()
    assert not (endo_module / ".transcriber-cache" / "runs").exists()
    assert not (endo_module / "Questions" / "exam-index.json").exists()


def test_launcher_pending_inventory_uses_whole_unit_provenance_and_ignores_drafts(
    endo_module: Path,
) -> None:
    recordings = [
        RemoteSource(name, name, engine.normalize_source_key(name), engine.normalize_source_stem(name), "audio")
        for _, names in ENDO_UNITS.values() for name in names
    ]
    assert launcher._pending_recordings(engine, recordings, endo_module / "Transcripts") == []
    title, names = ENDO_UNITS["Hypothyroidism 2"]
    (endo_module / "Transcripts" / f"{title}.md").unlink()
    write_transcript(endo_module, "Hypothyroidism 2 🧬.draft", names)
    write_transcript(endo_module, "Hypothyroidism 2 🧬", names[:1])
    pending = launcher._pending_recordings(engine, recordings, endo_module / "Transcripts")
    assert [recording.title for recording in pending] == list(names)


def test_launcher_legacy_title_fallback_marks_all_cohorts_done(endo_module: Path) -> None:
    title, names = ENDO_UNITS["1st lecture"]
    (endo_module / "Transcripts" / f"{title}.md").unlink()
    write_transcript(endo_module, "1st lecture 🧬", ("1st lecture.pdf",))
    recordings = [RemoteSource(name, name, name, Path(name).stem, "audio") for name in names]
    assert launcher._pending_recordings(engine, recordings, endo_module / "Transcripts") == []
