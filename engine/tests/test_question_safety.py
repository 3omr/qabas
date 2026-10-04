"""Synthetic regressions for the 2026-10-04 exam loss and repeated assessments."""

import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import mcp_server as tools
from exam_index import build_index, write_index
from phase_validation import SECTION_HEADINGS
from pipeline_repair import _scaffold, salvage
from question_sections import normalize_question_sections
from test_agy_writer import fake_agy as fake_agy
from test_agy_writer import lecture as lecture
from test_lecture_pipeline import pipeline as pipeline
from transcript_parser import parse_transcript


def mcq(number, badge="Past Exams - 2023", *, stem="Corrosives cause:", answer="a. Burns", source=None):
    source = source or ("Final 2023.txt" if badge != "IMP" else "")
    return (f"### MCQ {number} **[{badge}]**\n**Question:** {stem}\n"
            "**Options:**\na. Burns\nb. Fever\nc. Cough\nd. Rash\n"
            f"**Correct Answer:** {answer}\n**Clinical Explanation:** شرح للمعلومة\n"
            + (f"**Source:** {source}\n" if source else ""))


@pytest.fixture
def staged(lecture):
    workspace, root, request = lecture
    manifest = Path(request["manifest_path"])
    payload = json.loads(manifest.read_text())
    payload["assessment_sources"] = [{"path": "Questions/Final 2023.txt", "type": "past_exam", "year": "2023"}]
    manifest.write_text(json.dumps(payload))
    context = tools._resolve_draft_context(request, workspace)
    guide = "### Corrosives\n" + "Corrosives cause burns. Explain the clinical treatment fully.\n\n" * 25

    def seed(questions, written="", cases=""):
        text = _scaffold(guide, ["", questions, written, cases])
        tools._seed_repair_parts(context, text)
        return text

    return workspace, root, request, context, seed


def test_isolated_checks_keep_questions_numbered_above_one(staged):
    workspace, _, request, context, seed = staged
    seed(mcq(1) + "\n" + mcq(2, "IMP", stem="A different generated stem?"),
         "### Question 1 **[IMP]**\n**Question:** Explain burns?\n**Model Answer:** Burns\n\n"
         "### Question 2 **[IMP]**\n**Question:** Explain treatment?\n**Model Answer:** Treatment\n",
         "### Clinical Case 1 **[IMP]**\n**Scenario:** First patient\n**Questions:** Diagnosis?\n**Model Answer:** Burns\n\n"
         "### Clinical Case 2 **[IMP]**\n**Scenario:** Second patient\n**Questions:** Treatment?\n**Model Answer:** Support\n")
    notes = salvage(request, workspace)
    parsed = parse_transcript(context.path.read_text())
    assert (len(parsed.mcqs), len(parsed.written), len(parsed.cases)) == (2, 2, 2)
    assert not any("question(s)" in note for note in notes)


@pytest.mark.parametrize("badge,source", [("Past Exams - 2024", "Final 2023.txt"), ("Question Bank", "Bank.txt")])
def test_evidenced_question_with_editorial_error_is_rewritten_never_pruned(staged, monkeypatch, badge, source):
    workspace, root, request, context, seed = staged
    if source == "Bank.txt":
        (root / "Questions/Final 2023.txt").unlink()
        (root / "Questions/Bank.txt").write_text("1. Corrosives cause:\na. Burns\nb. Fever\nc. Cough\nd. Rash\n")
        write_index(build_index(root / "Questions", "toxo"), root / "Questions")
        manifest = Path(request["manifest_path"])
        payload = json.loads(manifest.read_text())
        payload["assessment_sources"] = [{"path": "Questions/Bank.txt", "type": "question_bank"}]
        manifest.write_text(json.dumps(payload))
    seed(mcq(1, badge, source=source, answer="b. Burns"))

    def write(prompt, *args, **kwargs):
        # Only the external writer is replaced. Real checks must accept its answer.
        assert "Correct Answer" in prompt and "b. Burns" in prompt
        return agy_writer.WrittenPart(mcq(1, "Question Bank" if source == "Bank.txt" else "Past Exams - 2023", source=source), 0)

    monkeypatch.setattr(agy_writer, "write", write)
    notes = salvage(request, workspace)
    parsed = parse_transcript(context.path.read_text())
    assert len(parsed.mcqs) == 1
    assert parsed.mcqs[0].correct_answer == "a. Burns"
    assert parsed.mcqs[0].badges[0].label == ("Question Bank" if source == "Bank.txt" else "Past Exams - 2023")
    assert not any("question(s)" in note for note in notes)


def test_failed_rewrite_finalizes_evidenced_wording_without_invalid_answer(staged, monkeypatch):
    workspace, _, request, context, seed = staged
    original = seed(mcq(1, answer="b. Burns"))
    monkeypatch.setattr(agy_writer, "write", lambda *_: agy_writer.WrittenPart("", 0))
    notes = salvage(request, workspace)
    saved = context.path.read_text()
    assert "source excerpt" in "\n".join(notes)
    assert "Corrosives cause:" in saved
    assert "a. Burns\n> b. Fever\n> c. Cough\n> d. Rash" in saved
    assert "b. Burns" not in saved
    assert original in [path.read_text() for path in context.module_root.glob(".transcriber-cache/stale-staged/*/*/part-*.md")]



def test_paper_evidence_repairs_missing_manifest_and_source_reference(staged):
    workspace, _, request, context, seed = staged
    manifest = Path(request["manifest_path"])
    payload = json.loads(manifest.read_text())
    payload["assessment_sources"] = []
    manifest.write_text(json.dumps(payload))
    seed(mcq(1, source="Wrong-reference.txt"))
    notes = salvage(request, workspace)
    assert len(parse_transcript(context.path.read_text()).mcqs) == 1
    assert "**Source:** Final 2023.txt" in context.path.read_text()
    assert json.loads(manifest.read_text())["assessment_sources"][0]["path"] == "Questions/Final 2023.txt"
    assert not any("question(s)" in note for note in notes)


def test_undated_question_in_mixed_bank_is_never_pruned_when_manifest_omits_bank(staged, monkeypatch):
    workspace, root, request, context, seed = staged
    stem = "List the complications caused by an ingestion of corrosive liquids:"
    (root / "Questions/Mixed Bank.txt").write_text(
        "--- End 2023 ---\n1. A dated assessment of burns:\na. Burns\nb. Fever\nc. Cough\nd. Rash\n"
        + "--- Page 2 ---\n1. " + stem + "\na. Burns\nb. Fever\nc. Cough\nd. Rash\n")
    write_index(build_index(root / "Questions", "toxo"), root / "Questions")
    manifest = Path(request["manifest_path"])
    payload = json.loads(manifest.read_text())
    payload["assessment_sources"] = []
    manifest.write_text(json.dumps(payload))
    original = seed(mcq(1, "Question Bank", source="Mixed Bank.txt", stem=stem, answer="b. Burns"))
    monkeypatch.setattr(agy_writer, "write", lambda *_: agy_writer.WrittenPart("", 0))
    notes = salvage(request, workspace)
    assert stem in context.path.read_text()
    assert "**[Question Bank]**" in context.path.read_text()
    assert not any("question(s)" in note for note in notes)
    assert original in [path.read_text() for path in context.module_root.glob(".transcriber-cache/stale-staged/*/*/part-*.md")]



@pytest.mark.parametrize("question,rejected", [("1. Describe another condition?", True), ("1. What is the diagnosis?", False)])
def test_sourced_case_rewrite_preserves_subquestions_except_numbering(staged, monkeypatch, question, rejected):
    workspace, root, request, context, seed = staged
    scenario = "A patient presents with burns after ingestion of a corrosive liquid."
    (root / "Questions/Final 2023.txt").write_text("1. " + scenario + "\n")
    write_index(build_index(root / "Questions", "toxo"), root / "Questions")
    case = ("### Clinical Case 1 **[Past Exams - 2023]**\n**Scenario:** " + scenario
            + "\n**Questions:**\n2. What is the diagnosis?\n**Model Answer:** Burns\n**Source:** Final 2023.txt\n")
    original = seed("", cases=case)
    revised = case.replace("2. What is the diagnosis?", question)
    monkeypatch.setattr(agy_writer, "write", lambda *_: agy_writer.WrittenPart(revised, 0))
    if rejected:
        notes = salvage(request, workspace)
        assert "source excerpt" in "\n".join(notes)
        assert "What is the diagnosis?" in context.path.read_text()
        assert "Describe another condition" not in context.path.read_text()
        assert original in [path.read_text() for path in context.module_root.glob(".transcriber-cache/stale-staged/*/*/part-*.md")]
    else:
        notes = salvage(request, workspace)
        assert len(parse_transcript(context.path.read_text()).cases) == 1
        assert "1. What is the diagnosis?" in context.path.read_text()
        assert not any("question(s)" in note for note in notes)


def test_quoted_past_exam_case_survives_salvage(staged):
    workspace, root, request, context, seed = staged
    scenario = "A patient presents with burns after ingestion of a corrosive liquid."
    (root / "Questions/Final 2023.txt").write_text("1. " + scenario + "\n")
    write_index(build_index(root / "Questions", "toxo"), root / "Questions")
    case = ("### Clinical Case 1 **[Past Exams - 2023]**\n**Scenario:** " + scenario
            + "\n**Questions:**\n1. What is the diagnosis?\n**Model Answer:** Burns\n**Source:** Final 2023.txt\n")
    seed("", cases="> [!TIP]\n" + "\n".join("> " + line for line in case.splitlines()))
    notes = salvage(request, workspace)
    assert len(parse_transcript(context.path.read_text()).cases) == 1
    assert scenario in context.path.read_text()
    assert not any("question(s)" in note for note in notes)


@pytest.mark.parametrize("heading", ["### MCQ **1**", "### MCQ", "### Question 1"])
def test_damaged_assessment_heading_is_repaired_without_losing_evidenced_wording(staged, heading):
    workspace, _, request, context, seed = staged
    original = seed(mcq(1).replace("### MCQ 1", heading))
    salvage(request, workspace)
    assert parse_transcript(context.path.read_text()).mcqs[0].stem == "Corrosives cause:"
    assert original in [path.read_text() for path in context.module_root.glob(".transcriber-cache/stale-staged/*/*/part-*.md")]


def test_pruning_rewrites_first_and_counts_only_invalid_generated_items(staged, monkeypatch):
    workspace, _, request, context, seed = staged
    seed(mcq(1) + "\n" + mcq(2, "IMP", stem="Invented second stem?", answer="b. Burns")
         + "\n" + mcq(3, "IMP", stem="Healthy third generated stem?"))
    attempts = []

    def write(prompt, *args, **kwargs):
        attempts.append(prompt)
        return agy_writer.WrittenPart("", 0)

    monkeypatch.setattr(agy_writer, "write", write)
    notes = salvage(request, workspace)
    parsed = parse_transcript(context.path.read_text())
    assert [question.number for question in parsed.mcqs] == [1, 2]
    assert parsed.mcqs[1].stem == "Healthy third generated stem?"
    assert attempts and "Invented second stem" in attempts[0]
    assert "1 question(s) that could not be validated were left out." in notes
    assert any("MCQ 2" in note and "[IMP]" in note for note in notes)


def test_question_rewrite_cannot_append_a_quoted_second_question(staged, monkeypatch):
    workspace, _, request, context, seed = staged
    stem = "A generated question requiring repair?"
    seed(mcq(1, "IMP", stem=stem, answer="b. Burns"))
    extra = mcq(2, "IMP", stem="An extra question appended by the repair?")
    answer = mcq(1, "IMP", stem=stem) + "\n" + "\n".join("> " + line for line in extra.splitlines())
    monkeypatch.setattr(agy_writer, "write", lambda *_: agy_writer.WrittenPart(answer, 0))
    notes = salvage(request, workspace)
    assert "extra question appended" not in context.path.read_text()
    assert "1 question(s) that could not be validated were left out." in notes


def test_questions_part_replacement_and_review_remove_repeated_sections(lecture, fake_agy):
    from test_agy_writer import write_all

    workspace, _, request = lecture
    report = write_all(lecture)
    total = report["total_parts"]
    context = tools._resolve_draft_context(request, workspace)
    questions = "\n".join([SECTION_HEADINGS[1], SECTION_HEADINGS[2], mcq(1, "IMP"),
                           SECTION_HEADINGS[3], SECTION_HEADINGS[4]]) + "\n"
    # Re-sending replaces the same file, even when the writer repeats its whole answer.
    tools._stage_draft_part({**request, "part": total, "parts": total, "content": questions * 2}, workspace)
    tools._stage_draft_part({**request, "part": total, "parts": total, "content": questions * 2}, workspace)
    tools._apply_review({**request, "from_parts": True}, workspace)
    first = context.path.read_text()
    tools._apply_review({**request, "from_parts": True}, workspace)
    assert context.path.read_text() == first
    assert all(first.count(heading) == 1 for heading in SECTION_HEADINGS)
    assert len(parse_transcript(first).mcqs) == 1
    assert tools._read_staged_draft(context) == first


def test_review_coalesces_old_repair_parts_without_losing_distinct_questions(staged):
    workspace, _, request, context, seed = staged
    original = seed(mcq(1, "IMP"))
    original = original.replace("شرح للمعلومة", "شرح للمعلومة " * 450)
    tail = original[original.index(SECTION_HEADINGS[1]):].replace(SECTION_HEADINGS[3], mcq(2, "IMP", stem="Distinct retained question?") + "\n" + SECTION_HEADINGS[3])
    parts = tools._seed_repair_parts(context, original + tail)
    assert len(parts) > 1
    tools._apply_review({**request, "from_parts": True}, workspace)
    saved = context.path.read_text()
    assert all(saved.count(heading) == 1 for heading in SECTION_HEADINGS)
    assert [question.stem for question in parse_transcript(saved).mcqs] == ["Corrosives cause:", "Distinct retained question?"]
    assert tools._read_staged_draft(context) == saved


def test_saved_triplicate_assessments_do_not_trigger_loss_of_content_guard(staged):
    workspace, _, request, context, seed = staged
    original = seed(mcq(1, "IMP").replace("شرح للمعلومة", "شرح للمعلومة " * 300))
    tail = original[original.index(SECTION_HEADINGS[1]):]
    duplicated = original + tail * 2
    context.path.write_text(duplicated)
    tools._seed_repair_parts(context, duplicated)
    tools._apply_review({**request, "from_parts": True}, workspace)
    saved = context.path.read_text()
    assert len(saved) < len(duplicated) / 2
    assert len(parse_transcript(saved).mcqs) == 1
    assert tools._section_body(saved, SECTION_HEADINGS[0]) == tools._section_body(original, SECTION_HEADINGS[0])
    assert tools._read_staged_draft(context) == saved


def test_deduplication_preserves_guide_with_inline_assessment_label(staged):
    *_, seed = staged
    original = seed(mcq(1, "IMP"))
    start = original.index(SECTION_HEADINGS[1])
    guide = original[:start].replace("### Corrosives", "The doctor mentions this label: " + SECTION_HEADINGS[1] + "\n### Corrosives")
    revised = normalize_question_sections(guide + original[start:] * 2)
    assert revised.startswith(guide)
    assert re.findall(r"(?m)^## .+$", revised) == list(SECTION_HEADINGS)


def test_unlocated_sourced_question_survives_unavailable_answer_repair_as_practice(staged, monkeypatch):
    workspace, _, request, context, seed = staged
    stem = 'Which novel clinical finding identifies an unresolved synthetic injury?'
    seed(mcq(1, source='Missing-paper.txt', stem=stem, answer='b. Burns').replace('d. Rash\n', ''))
    monkeypatch.setattr(agy_writer, 'write', lambda *_args, **_kwargs: agy_writer.WrittenPart('', 0))
    notes = salvage(request, workspace)
    saved = context.path.read_text()
    assert stem in saved
    assert 'a. Burns\n> b. Fever\n> c. Cough' in saved
    assert '**[IMP]**' in saved and '**[Past Exams' not in saved
    assert 'b. Burns' not in saved
    assert not any('question(s)' in note for note in notes)


def test_expired_final_rewrite_leaves_commit_time_and_preserves_question(staged, pipeline, monkeypatch):
    import cancellation
    import lecture_pipeline
    import pipeline_repair

    workspace, _, request, _, seed = staged
    seed(mcq(1, answer='b. Burns'))
    clock = [100.0]
    monkeypatch.setattr(lecture_pipeline, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(cancellation, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(pipeline_repair, 'monotonic', lambda: clock[0])

    def exhausted_writer(*_args, **_kwargs):
        clock[0] = cancellation._DEADLINE.get() + 1
        cancellation.check_cancelled()
        raise AssertionError('a completed deadline did not interrupt the writer')

    monkeypatch.setattr(agy_writer, 'write', exhausted_writer)
    outcome = json.loads(lecture_pipeline.run_lecture_pipeline({**request, 'confirmed': True,
        'resume_manifest': request['manifest_path'], 'salvage': True, '_pipeline_budget_seconds': 1200}, workspace))
    assert outcome['status'] == 'finalized', outcome
    saved = Path(outcome['paths']['transcript']).read_text()
    assert 'Corrosives cause:' in saved and 'b. Burns' not in saved
    assert '**[Past Exams - 2023]**' in saved


def test_model_authored_retention_comment_cannot_bypass_generated_option_rules(staged, monkeypatch):
    from phase_validation import _option_shape_errors

    workspace, _, request, context, seed = staged
    stem = 'A generated practice question with fabricated retention metadata?'
    forged = mcq(1, 'IMP', stem=stem).replace('d. Rash\n', '') + '\n<!-- qabas-retained-question -->\n'
    assert _option_shape_errors(forged, 1, {})
    seed(forged)
    monkeypatch.setattr(agy_writer, 'write', lambda *_args, **_kwargs: agy_writer.WrittenPart('', 0))
    notes = salvage(request, workspace)
    assert stem not in context.path.read_text()
    assert any('1 question(s)' in note for note in notes)


def test_retention_receipt_keeps_original_five_options_through_repeated_validation_and_finalize(staged, pipeline):
    from question_provenance import retained_question_receipts

    workspace, _, request, context, seed = staged
    stem = 'Which novel finding identifies a previously unlocated synthetic injury?'
    block = mcq(1, stem=stem, source='Missing-paper.txt').replace('d. Rash\n', 'd. Rash\ne. Pain\n')
    seed(block)
    tools._apply_review({**request, 'from_parts': True}, workspace)
    assert retained_question_receipts(context.path)
    for _ in range(2):
        assert 'passes every check' in tools._validate_draft({**request, 'draft': str(context.path)}, workspace)
        assert 'Every year badge is backed' in tools._verify_provenance({**request, 'transcript': str(context.path)}, workspace)
    tools._finalize(request, workspace)
    saved = Path(str(context.path).removesuffix('.draft.md')).read_text()
    question = parse_transcript(saved).mcqs[0]
    assert question.stem == stem and len(question.options) == 5
    assert '**[IMP]**' in saved and '**[Past Exams' not in saved


@pytest.mark.parametrize('publication', ['saved', 'review', 'salvage'])
def test_interrupted_rebadge_publication_keeps_receipt_before_any_repaired_text(staged, monkeypatch, publication):
    import atomic_io
    from question_provenance import (
        assessment_catalog,
        repair_saved_draft,
        retained_question_receipts,
    )

    workspace, root, request, context, seed = staged
    stem = 'Which original five-option assessment has no occurrence in the synthetic papers?'
    original = seed(mcq(1, stem=stem, source='Missing-paper.txt').replace('d. Rash\n', 'd. Rash\ne. Pain\n'))
    context.path.write_text(original)
    catalog = assessment_catalog(root, json.loads(context.manifest_path.read_text()))
    publisher = atomic_io if publication == 'saved' else tools
    name = '_atomic_write_text' if publication == 'saved' else '_save_review' if publication == 'review' else '_seed_repair_parts'
    publish = getattr(publisher, name)

    def interrupted_publish(*args, **kwargs):
        result = publish(*args, **kwargs)
        if publication != 'saved' or args[0] == context.path:
            raise OSError('synthetic interruption immediately after publishing repaired text')
        return result

    with monkeypatch.context() as patch:
        patch.setattr(publisher, name, interrupted_publish)
        with pytest.raises((OSError, tools.ToolError), match='synthetic interruption'):
            if publication == 'saved':
                repair_saved_draft(context.path, catalog)
            elif publication == 'review':
                tools._apply_review({**request, 'from_parts': True}, workspace)
            else:
                salvage(request, workspace)
    assert retained_question_receipts(context.path)
    if publication == 'salvage':
        tools._apply_review({**request, 'from_parts': True}, workspace)
    assert 'passes every check' in tools._validate_draft({**request, 'draft': str(context.path)}, workspace)
    assert stem in context.path.read_text() and '**[IMP]**' in context.path.read_text()


@pytest.mark.parametrize('publication', ['saved', 'review', 'salvage'])
def test_failed_receipt_write_leaves_original_source_claim_for_recovery(staged, monkeypatch, publication):
    import pipeline_repair
    import question_provenance

    workspace, root, request, context, seed = staged
    original = seed(mcq(1, stem='An original unlocated assessment?', source='Missing-paper.txt'))
    context.path.write_text(original)
    catalog = question_provenance.assessment_catalog(root, json.loads(context.manifest_path.read_text()))

    def unavailable_journal(*_args):
        raise OSError('synthetic receipt storage failure')

    monkeypatch.setattr(question_provenance, 'record_provenance_repairs', unavailable_journal)
    monkeypatch.setattr(pipeline_repair, 'record_provenance_repairs', unavailable_journal)
    with pytest.raises(OSError, match='synthetic receipt storage failure'):
        if publication == 'saved':
            question_provenance.repair_saved_draft(context.path, catalog)
        elif publication == 'review':
            tools._apply_review({**request, 'from_parts': True}, workspace)
        else:
            salvage(request, workspace)
    assert context.path.read_text() == original
    parts = ''.join(tools._read_review_draft(tools._staged_part_path(context, number))
                    for number in tools._staged_part_numbers(tools._staged_draft_directory(context)))
    assert parts == original
