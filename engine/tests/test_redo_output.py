"""A confirmed redo must never destroy the student's previous revision."""

import sys
from pathlib import Path
from urllib.parse import quote

import pytest

sys.path.insert(
    0, str(Path(__file__).parents[1] / "scripts")
)
from output_assembly import commit_managed_transcript
from transcriber_models import OutputTarget, TranscriberError, TranscriptIdentity


@pytest.mark.parametrize("same_name", [True, False])
def test_redo_archives_previous_transcript_and_replaces_duplicate_index_rows(
    tmp_path, same_name
):
    previous = tmp_path / "Hyperthyroidism & Thyrotoxicosis 🧬.md"
    previous.write_text("Student's existing transcript", encoding="utf-8")
    name = previous.name if same_name else "Hyperthyroidism 🧬.md"
    target = OutputTarget(str(tmp_path), name, str(tmp_path / name))
    old_row = f"| Old title | [فتح التفريغ](./{quote(previous.name)}) | old |\n"
    index = tmp_path / "Index.md"
    index.write_text(
        "# Index\n"
        + old_row
        + old_row.replace("(./", "(<./").replace(") |", ">) |")
        + "| Other | [link](./Other.md) | keep |\n",
        encoding="utf-8",
    )
    identity = TranscriptIdentity(
        "Endocrine", "Hyperthyroidism", "🧬", "Hyperthyroidism.mp3"
    )

    commit_managed_transcript(identity, target, "New reviewed transcript", str(previous))

    archived = list((tmp_path / ".previous").glob("*.md"))
    assert len(archived) == 1
    assert archived[0].read_text(encoding="utf-8") == "Student's existing transcript"
    assert (
        Path(target.output_path).read_text(encoding="utf-8") == "New reviewed transcript"
    )
    rows = index.read_text(encoding="utf-8")
    assert rows.count("فتح التفريغ") == 1
    assert "Hyperthyroidism" in rows
    assert "Old title" not in rows
    assert "Other.md" in rows
    assert previous.exists() == same_name


def test_failed_redo_commit_restores_live_transcript_and_keeps_archive(
    tmp_path, monkeypatch
):
    import output_assembly

    previous = tmp_path / "Lecture.md"
    previous.write_text("Student's existing transcript", encoding="utf-8")
    index = tmp_path / "Index.md"
    index.write_text("Old index", encoding="utf-8")
    replace = output_assembly.os.replace

    def fail_index(source, destination):
        if str(destination) == str(index):
            raise OSError("Index write failed")
        return replace(source, destination)

    monkeypatch.setattr(output_assembly.os, "replace", fail_index)
    target = OutputTarget(str(tmp_path), previous.name, str(previous))
    identity = TranscriptIdentity("Subject", "Lecture", "🧬", "Lecture.mp3")
    with pytest.raises(TranscriberError, match="Index write failed"):
        commit_managed_transcript(identity, target, "New transcript", str(previous))
    assert previous.read_text(encoding="utf-8") == "Student's existing transcript"
    assert index.read_text(encoding="utf-8") == "Old index"
    assert len(list((tmp_path / ".previous").glob("*.md"))) == 1


def test_non_redo_commit_preserves_existing_index_behavior(tmp_path):
    target = OutputTarget(str(tmp_path), "Lecture.md", str(tmp_path / "Lecture.md"))
    identity = TranscriptIdentity("Subject", "Lecture", "🧬", "Lecture.mp3")
    commit_managed_transcript(identity, target, "First transcript")
    first_index = (tmp_path / "Index.md").read_bytes()
    commit_managed_transcript(identity, target, "Replaced transcript")
    assert (tmp_path / "Index.md").read_bytes() == first_index
    assert Path(target.output_path).read_text() == "Replaced transcript"
    assert not (tmp_path / ".previous").exists()


@pytest.mark.parametrize("valid_draft", [True, False])
@pytest.mark.parametrize("unconverted_questions", [False, True])
def test_redo_finalize_validates_before_archiving_and_marks_completion(
    tmp_path, monkeypatch, valid_draft, unconverted_questions
):
    import json

    import universal_transcribe as engine
    from transcriber_models import NotebookTarget, RunRequest, ValidationError

    root = tmp_path / "module"
    transcripts = root / "Transcripts"
    for folder in ("Lecture", "Questions", "Transcripts"):
        (root / folder).mkdir(parents=True)
    (root / "Lecture" / "Hyperthyroidism.mp3").write_bytes(b"recording")
    old = transcripts / "Hyperthyroidism & Thyrotoxicosis 🧬.md"
    old.write_text("Student's existing transcript", encoding="utf-8")
    target = OutputTarget(
        str(transcripts),
        "Hyperthyroidism 🧬.md",
        str(transcripts / "Hyperthyroidism 🧬.md"),
    )
    draft = Path(target.output_path + ".draft.md")
    reviewed = "\n\n".join(
        heading + "\n\nشرح المحاضرة بالكامل" for heading in engine.SECTION_HEADINGS
    )
    draft.write_text(reviewed if valid_draft else "Invalid draft", encoding="utf-8")
    index = transcripts / "Index.md"
    old_index = f"# Index\n| Old title | [فتح التفريغ](./{quote(old.name)}) | old |\n"
    index.write_text(old_index, encoding="utf-8")
    manifest = {
        "title": "Hyperthyroidism",
        "recording_sources": ["Hyperthyroidism.mp3"],
        "redo": True,
        "replaces_transcript": str(old),
    }
    assessments = ()
    if unconverted_questions:
        (root / "Questions" / "Final 2023.pdf").write_bytes(b"PDF awaiting OCR")
        assessments = (
            {
                "path": "Questions/Final 2023.pdf",
                "type": "past_exam",
                "year": 2023,
                "action": "auto",
            },
        )
        manifest["assessment_sources"] = list(assessments)
    path = root / ".transcriber-cache" / "manifest.json"
    path.parent.mkdir()
    path.write_text(json.dumps(manifest), encoding="utf-8")
    # Only notebook lookup/listing are replaced; audit, validation, and commit are real.
    notebook = NotebookTarget("test", "test", "https://example.invalid", "Test")
    monkeypatch.setattr(engine, "resolve_notebooks", lambda *_: (notebook,))
    monkeypatch.setattr(engine, "list_remote_sources", lambda *_: [])
    request = RunRequest(
        "Endocrine",
        ("test",),
        "Hyperthyroidism.mp3",
        ("Hyperthyroidism.mp3",),
        None,
        str(root),
        "Hyperthyroidism",
        "🧬",
        target,
        False,
        finalize_draft=True,
        assessment_sources=assessments,
        source_manifest=manifest,
        source_manifest_path=str(path),
    )
    if not valid_draft:
        with pytest.raises(ValidationError):
            engine._finalize_pipeline({}, request)
        assert old.read_text(encoding="utf-8") == "Student's existing transcript"
        assert index.read_text(encoding="utf-8") == old_index
        assert not (transcripts / ".previous").exists()
        assert draft.exists()
        return
    assert engine._finalize_pipeline({}, request) == 0
    archived = list((transcripts / ".previous").glob("*.md"))
    assert archived[0].read_text(encoding="utf-8") == "Student's existing transcript"
    assert Path(target.output_path).read_text(encoding="utf-8").strip() == reviewed
    assert index.read_text(encoding="utf-8").count("فتح التفريغ") == 1
    assert json.loads(path.read_text(encoding="utf-8"))["redo_completed"] is True
    assert not old.exists()
    assert not draft.exists()
