"""Lecture evidence and printed keys stay independent of exam provenance."""

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from lecture_answers import prepare_answers, select_evidence
from phase_validation import _field_content, _mcq_field_errors
from transcriber_models import QuestionEvidence
from transcript_contract import (
    answer_source_errors,
    repair_answer_sources,
    validate_complete_transcript,
)

MCQ = """### MCQ 1 **[Past Exams - 2023]**
**Question:** Corrosives cause:
**Options:**
a. Burns
b. Fever
c. Cough
d. Rash
**Correct Answer:** a. Burns
**Answer source:** lecture
**Answer quote:** Corrosives cause burns.
**Clinical Explanation:** شرح الدكتور.
**Source:** Questions/Final 2023.txt
"""
ENTRY = {"id": "q1", "stem": "Corrosives cause:", "options": {"a": "Burns", "b": "Fever", "c": "Cough", "d": "Rash"}, "answer": None, "answer_status": "no_key"}


@pytest.mark.parametrize("status", ["no_key", "uncertain"])
def test_missing_paper_key_uses_valid_lecture_quote_without_index_edits(status):
    entry = {**ENTRY, "answer_status": status}
    before = copy.deepcopy(entry)
    text = prepare_answers(MCQ, [entry], ["Corrosives\n cause  burns."])
    assert _field_content(text, "Correct Answer") == "a. Burns"
    assert _field_content(text, "Answer source") == "lecture"
    assert _field_content(text, "Answer quote") == "Corrosives cause burns."
    assert _field_content(text, "Clinical Explanation") == "شرح الدكتور."
    assert not answer_source_errors(text)
    assert not _mcq_field_errors(text, QuestionEvidence({}, []))
    assert entry == before


def test_printed_key_wins_over_model_and_lecture():
    entry = {**ENTRY, "answer_status": "printed", "answer": "b"}
    result = prepare_answers(MCQ, [entry], ["Corrosives cause burns."])
    assert _field_content(result, "Correct Answer") == "b. Fever"
    assert "**Answer source:**" not in result and "**Answer quote:**" not in result
    assert "**Clinical Explanation:** شرح الدكتور." in result
    assert "**Source:** Questions/Final 2023.txt" in result


def test_invalid_quote_is_dropped_without_losing_answer_or_explanation():
    result = prepare_answers(MCQ, [ENTRY], ["The lecture discusses emesis."])
    assert "**Answer quote:**" not in result
    assert _field_content(result, "Answer source") == "not stated in the lecture"
    assert _field_content(result, "Correct Answer") == "a. Burns"
    assert _field_content(result, "Clinical Explanation") == "شرح الدكتور."
    assert not answer_source_errors(result)


def test_not_stated_marker_is_accepted_without_quote():
    text = MCQ.replace("lecture\n**Answer quote:** Corrosives cause burns.", "not stated in the lecture")
    assert prepare_answers(text, [ENTRY], []) == text
    assert not answer_source_errors(text)
    assert not any("Answer source" in error for error in validate_complete_transcript(text))


def test_quote_in_guide_is_valid_and_cannot_cross_verbatim_files():
    text = "## 📖 Chronological Guide\nCorrosives cause burns.\n## ❓ MCQs\n" + MCQ
    assert repair_answer_sources(text) == text
    assert "**Answer quote:**" not in repair_answer_sources(MCQ, ["Corrosives cause", "burns."])


def test_evidence_selection_is_deterministic_bounded_and_reports_omissions():
    questions = {"entries": [ENTRY, {**ENTRY, "id": "q2"}, {**ENTRY, "id": "printed", "answer_status": "printed"}]}
    sources = [("recording 1", "Corrosives cause burns.\n\n" * 80), ("guide", "Corrosives cause severe burns.")]
    result = select_evidence(questions, sources, {"answer_evidence_chars": 700}, 1800)
    assert result == select_evidence(questions, sources, {"answer_evidence_chars": 700}, 1800)
    assert len(json.dumps(result, ensure_ascii=False)) <= 1800
    assert set(result) == {"1", "2"}
    for entry in result.values():
        assert entry["passages"] and entry["omitted_passages"] > 0
        assert sum(len(json.dumps(passage, ensure_ascii=False)) + 2 for passage in entry["passages"]) <= 700
        for passage in entry["passages"]:
            assert dict(sources)[passage["source"]][passage["start"]:passage["end"]] == passage["text"]
    with pytest.raises(ValueError, match="No evidence was truncated"):
        select_evidence(questions, sources, {}, 1)


def test_long_paragraphs_supply_bounded_excerpts():
    source = "Corrosives cause burns. " * 400
    selected = select_evidence({"entries": [ENTRY]}, [("doctor", source)], {}, 3000)
    assert selected["1"]["passages"]
    assert len(json.dumps(selected, ensure_ascii=False)) <= 3000


def test_printed_written_answer_retains_bullets():
    written = MCQ.replace("MCQ 1", "Question 1").replace("**Correct Answer:** a. Burns", "**Model Answer:**\n- Model guess")
    entry = {**ENTRY, "answer_status": "printed", "model_answer": ["Printed point one", "Printed point two"]}
    result = prepare_answers(written, [entry], [])
    assert _field_content(result, "Model Answer") == "- Printed point one\n- Printed point two"
    assert _field_content(result, "Clinical Explanation") == "شرح الدكتور."


def test_quoted_question_fields_preserve_printed_priority_and_clean_invalid_quote():
    quoted = "\n".join("> " + line if line.startswith("**") else line for line in MCQ.splitlines()) + "\n"
    printed = prepare_answers(quoted, [{**ENTRY, "answer_status": "printed", "answer": "b"}], [])
    assert _field_content(printed, "Correct Answer") == "b. Fever"
    assert "> **Correct Answer:** b. Fever" in printed
    assert "Answer source" not in printed and "Answer quote" not in printed
    missing = prepare_answers(quoted, [ENTRY], [])
    assert _field_content(missing, "Answer source") == "not stated in the lecture"
    assert "Answer quote" not in missing


def test_answer_marker_before_section_separator_is_accepted():
    text = MCQ.replace("**Answer source:** lecture\n**Answer quote:** Corrosives cause burns.\n", "")
    text += "**Answer source:** lecture\n**Answer quote:** Corrosives cause burns.\n\n---\n"
    assert repair_answer_sources(text, ["Corrosives cause burns."]) == text
    assert not answer_source_errors(text)


def test_arabic_stems_keep_distinct_printed_keys_and_retrieve_evidence():
    question = MCQ.replace("Corrosives cause:", "المواد الكاوية تسبب ماذا؟")
    entries = [{**ENTRY, "stem": "ما هو علاج الحساسية؟", "answer_status": "printed", "answer": "b"},
               {**ENTRY, "stem": "المواد الكاوية تسبب ماذا؟", "answer_status": "printed", "answer": "a"}]
    assert _field_content(prepare_answers(question, entries, []), "Correct Answer") == "a. Burns"
    missing = {**entries[1], "answer_status": "no_key", "options": {}}
    evidence = select_evidence({"entries": [missing]}, [("doctor", "المواد الكاوية تسبب الحروق.")], {}, 2000)
    assert evidence["1"]["passages"]
