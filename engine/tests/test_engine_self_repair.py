"""Unattended repairs use synthetic source papers and never need a chat response."""

import argparse
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import mcp_server
import run_transcription
import universal_transcribe
from agy_index_fixtures import write_agy_index
from exam_index import write_index
from module_registry import load_module
from question_provenance import (
    assessment_catalog,
    final_provenance_errors,
    repair_provenance_badges,
    repair_saved_draft,
)
from test_agy_writer import write_all

pytest_plugins = ["test_agy_writer"]

RAW_SCENARIO = "Female patient 42y old, presented with farm machinery injury in left forearm muscle, with 750ml blood loss. (5 marks) a) Describe treatment?"
SCENARIO = "A 42-year-old female presents with a farm machinery injury in her left forearm muscle, complicated by estimated blood loss of 750 ml."


def case_block(badge, sources, scenario=SCENARIO):
    return (f"### Clinical Case 1 {badge}\n\n**Scenario:** {scenario}\n\n"
            "**Questions:**\n1. Describe treatment.\n\n" + "".join(f"**Source:** Questions/{name}\n" for name in sources)
            + "\n**Model Answer:**\n1. Control bleeding and restore circulating volume.\n\n"
            "**Clinical Explanation:**\nشرح الحالة وعلاج فقد الدم.\n")


@pytest.fixture
def papers(tmp_path):
    root = tmp_path / "modules/synthetic"
    questions = root / "Questions"
    questions.mkdir(parents=True)
    (root / "Lecture").mkdir()
    (root / "Transcripts").mkdir()
    (root / "module.json").write_text(json.dumps({
        "schema_version": 1, "module_id": "synthetic", "display_name": "Synthetic",
        "notebook": {"id": "test-notebook", "title": "Synthetic", "profile": None},
        "output": {"emoji": "🧪", "language": "Egyptian Arabic"},
    }), encoding="utf-8")
    for name in ("Final_2024.txt", "Principles_Question_Bank.txt"):
        (questions / name).write_text("1. " + RAW_SCENARIO, encoding="utf-8")
    write_index(write_agy_index(questions, "synthetic"), questions)
    manifest = {"assessment_sources": [
        {"path": "Questions/Final_2024.txt", "type": "past_exam", "years": [2024]},
        {"path": "Questions/Principles_Question_Bank.txt", "type": "question_bank", "years": []},
    ]}
    return root, assessment_catalog(root, manifest)


@pytest.mark.parametrize("badge,sources,expected", [
    ("**[Past Exams - 2024]**", ["Final_2024.txt", "Principles_Question_Bank.txt"], "**[Past Exams - 2024]**"),
    ("**[Past Exams - 2024, 2025]**", ["Principles_Question_Bank.txt"], "**[Question Bank]**"),
    ("**[Question Bank]**", ["Final_2024.txt"], "**[Past Exams - 2024]**"),
    ("**[Past Exams - 2025]**", ["Final_2024.txt"], "**[Past Exams - 2024]**"),
])
def test_badge_uses_the_question_source_not_the_claimed_year(papers, badge, sources, expected):
    _root, catalog = papers
    block = case_block(badge, sources)
    revised, corrections = repair_provenance_badges(block, catalog)
    assert revised == block.replace(badge, expected)
    assert final_provenance_errors(revised, catalog) == []
    assert bool(corrections) == (badge != expected)
    assert repair_provenance_badges(revised, catalog) == (revised, [])


@pytest.mark.parametrize("damage", ["different-quantity", "different-age", "different-side", "different-unit", "unknown-source", "duplicate-candidate", "unrelated"])
def test_uncertain_question_keeps_wording_with_only_evidenced_badge(papers, damage):
    root, catalog = papers
    scenario = SCENARIO
    source = "Final_2024.txt"
    if damage == "different-quantity":
        scenario = scenario.replace("750", "950")
    elif damage == "different-age":
        scenario = scenario.replace("42", "52")
    elif damage == "different-side":
        scenario = scenario.replace("left", "right")
    elif damage == "different-unit":
        scenario = scenario.replace("ml", "l")
    elif damage == "unknown-source":
        source = "Missing_2024.txt"
    elif damage == "duplicate-candidate":
        path = root / "Questions" / source
        path.write_text(path.read_text() + "\n2. " + RAW_SCENARIO)
    else:
        scenario = "A child has a fever and persistent headache without any injury."
    block = case_block("**[Past Exams - 2025]**", [source], scenario)
    revised, corrections = repair_provenance_badges(block, catalog)
    assert scenario in revised
    assert "1. Describe treatment." in revised
    assert corrections
    assert final_provenance_errors(revised, catalog) == []
    if damage == "unknown-source":
        assert "**[Past Exams - 2024]**" in revised
    elif damage == "duplicate-candidate":
        assert "**[Question Bank]**" in revised
        assert "Principles_Question_Bank.txt" in revised
        assert "**[Past Exams" not in revised
    else:
        assert "**[IMP]**" in revised
        assert "No question occurrence was confirmed" in revised


def test_saved_badge_repairs_are_atomic_and_recorded_once(papers):
    root, catalog = papers
    transcript = root / "Transcripts/Synthetic.md.draft.md"
    transcript.parent.mkdir(exist_ok=True)
    block = case_block("**[Past Exams - 2025]**", ["Principles_Question_Bank.txt"])
    transcript.write_text(block)
    revised, corrections = repair_saved_draft(transcript, catalog)
    assert transcript.read_text() == revised == block.replace("**[Past Exams - 2025]**", "**[Question Bank]**")
    journal = root / ".transcriber-cache/review-repairs" / f"{transcript.name}.json"
    assert json.loads(journal.read_text()) == corrections
    assert corrections[0]["evidenced_years"] == []
    assert repair_saved_draft(transcript, catalog) == (revised, [])
    assert json.loads(journal.read_text()) == corrections


@pytest.mark.parametrize("check", ["validate", "provenance"])
def test_validation_saves_confirmed_badges_even_when_other_findings_remain(lecture, capsys, check):
    workspace, root, arguments = lecture
    manifest = Path(arguments["manifest_path"])
    settings = json.loads(manifest.read_text())
    settings["assessment_sources"] = [{"path": "Questions/Final 2023.txt", "type": "past_exam", "years": [2023]}]
    manifest.write_text(json.dumps(settings))
    transcript = root / "Transcripts/Corrosives.md.draft.md"
    block = ("### MCQ 1 **[Question Bank]**\n**Question:** Corrosives cause:\n"
             "**Source:** Questions/Final 2023.txt\n")
    transcript.write_text(block)
    context = run_transcription.LauncherContext(Path(universal_transcribe.__file__), universal_transcribe, {}, load_module(root), lambda: ())
    args = argparse.Namespace(source_manifest=str(manifest), validate_draft=str(transcript), verify_provenance=str(transcript))
    if check == "validate":
        assert run_transcription._run_draft_validation(args, context) == 1
    else:
        assert run_transcription._run_provenance_check(args, context) == 0
    assert transcript.read_text() == block.replace("**[Question Bank]**", "**[Past Exams - 2023]**")
    assert "[AUTO-REPAIR]" in capsys.readouterr().out


def test_review_reports_badge_repairs_and_preserves_staged_recovery(lecture, fake_agy):
    workspace, root, arguments = lecture
    manifest = Path(arguments["manifest_path"])
    settings = json.loads(manifest.read_text())
    settings["assessment_sources"] = [{"path": "Questions/Final 2023.txt", "type": "past_exam", "years": [2023]}]
    manifest.write_text(json.dumps(settings))
    report = write_all(lecture)
    assert report["error"] is None
    context = mcp_server._resolve_draft_context(arguments, workspace)
    staged = mcp_server._staged_draft_directory(context)
    last = staged / f"part-{report['total_parts']}.md"
    questions = last.read_text().replace("## ❓ MCQs\n", "## ❓ MCQs\n### MCQ 1 **[Question Bank]**\n"
        "**Question:** Corrosives cause:\n**Source:** Questions/Final 2023.txt\n"
        "**Model Answer:** A. Burns\n")
    last.write_text(questions)
    reviewed = json.loads(mcp_server._apply_review({**arguments, "from_parts": True}, workspace))
    assert reviewed["automatic_corrections"][0]["evidenced_years"] == [2023]
    assert "**[Past Exams - 2023]**" in context.path.read_text()
    last.unlink()
    recovered = json.loads(mcp_server._read_draft({**arguments, "staged": True, "part": report["total_parts"]}, workspace))
    assert "**[Past Exams - 2023]**" in recovered["content"]


@pytest.mark.parametrize("old_version,attempt_count", [(True, 2), (False, 1)])
def test_old_or_underattempted_parse_refusal_gets_a_corrected_map(lecture, monkeypatch, old_version, attempt_count):
    workspace, _root, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    texts, _outline, fingerprint = mcp_server._topic_inputs(context)
    directory = mcp_server._staged_draft_directory(context)
    directory.mkdir(parents=True)
    (directory / "topics.json").write_text(json.dumps({"version": mcp_server.TOPIC_CACHE_VERSION - int(old_version),
        "fingerprint": fingerprint, "proposal": None, "failure_kind": "parse", "attempts": [{"status": "parse"}] * attempt_count}))
    proposal = {"topics": [{"title": "Corrosives", "gloss": "مواد كاوية", "spans": [{
        "recording": "Corrosives.mp3", "cohort": "unknown", "first_words": " ".join(texts[0].split()[:8]),
        "last_words": " ".join(texts[0].split()[-8:]),
    }]}]}
    monkeypatch.setattr(agy_writer, "request_json", lambda *_args, **_kwargs: proposal)
    mcp_server._ensure_topic_map(context)
    assert mcp_server._cached_topics(context)
    assert json.loads((directory / "topics.json").read_text())["failure_kind"] is None


@pytest.mark.parametrize("malformed", [False, True])
def test_rejected_map_is_persisted_and_retry_receives_specific_anchor_findings(lecture, monkeypatch, malformed):
    workspace, _root, arguments = lecture
    context = mcp_server._resolve_draft_context(arguments, workspace)
    rejected = {"topics": [{"title": "Corrosives", "gloss": "مواد كاوية", "spans": [{
        "recording": "Corrosives.mp3", "cohort": "unknown", "first_words": "absent opening words",
        "last_words": "absent closing words",
    }]}]}
    prompts = []
    def unavailable_map(prompt, *_args, **_kwargs):
        prompts.append(prompt)
        if malformed:
            return agy_writer._proposal_json('{"topics": [', ["topics"])
        return rejected
    monkeypatch.setattr(agy_writer, "request_json", unavailable_map)
    mcp_server._ensure_topic_map(context)
    cache = json.loads((mcp_server._staged_draft_directory(context) / "topics.json").read_text())
    assert cache["rejected_proposal"] == ('{"topics": [' if malformed else rejected)
    assert [attempt["status"] for attempt in cache["attempts"]] == ["parse", "parse"]
    if malformed:
        assert "invalid proposal JSON" in prompts[1]
    else:
        assert "Corrosives.mp3" in prompts[1] and "span 1 first_words='absent opening words'" in prompts[1]
        assert "too many unplaceable" in prompts[1]
    mcp_server._ensure_topic_map(context)
    assert len(prompts) == 2


def test_cached_rejected_map_is_repaired_locally_without_another_model_call(lecture, monkeypatch):
    workspace, root, arguments = lecture
    text = "alpha opening details alpha closing beta opening details beta closing"
    (root / "Verbatim/Corrosives.verbatim.md").write_text(text)
    context = mcp_server._resolve_draft_context(arguments, workspace)
    _texts, _outline, fingerprint = mcp_server._topic_inputs(context)
    proposal = {"topics": [{"title": title, "gloss": f"موضوع {number}", "spans": [{
        "recording": "Corrosives.mp3", "cohort": "unknown", "first_words": first, "last_words": last,
    }]} for number, (title, first, last) in enumerate([
        ("Alpha", "alpha closing", "alpha opening"), ("Beta", "beta opening", "beta closing")
    ])]}
    directory = mcp_server._staged_draft_directory(context)
    directory.mkdir(parents=True)
    (directory / "topics.json").write_text(json.dumps({"version": 2, "fingerprint": fingerprint,
        "proposal": None, "rejected_proposal": proposal, "failure_kind": "parse"}))
    def unavailable(*_args, **_kwargs):
        raise AssertionError("Deterministically repairable cached evidence must not spend a model call")
    monkeypatch.setattr(agy_writer, "request_json", unavailable)
    mcp_server._ensure_topic_map(context)
    topics = mcp_server._cached_topics(context)
    assert topics is not None and len(topics) == 2
    assert [text[topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in topics] == [
        "alpha opening details alpha closing", "beta opening details beta closing",
    ]
    assert json.loads((directory / "topics.json").read_text())["anchor_counts"]["repaired"] == 2
