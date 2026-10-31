"""Spoken emphasis, independent of assessment frequency or slide content."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

import agy_writer
import lecture_emphasis as emphasis
from phase_validation import retained_question_fingerprint
from question_prompts import IMP_EMPTY_NOTICES, IMP_HEADINGS
from question_provenance import repair_provenance_badges

SPOKEN = "Remember: never induce vomiting after corrosives. This mistake kills. Fever is also possible."
POINT = {"quote": "never induce vomiting after corrosives", "emphasis_quote": "This mistake kills.",
         "explanation": "Avoid induced vomiting", "category": "warnings"}
BLOCK = "### Question 1 **[IMP]**\n**Question:** What must be avoided after corrosives?\n**Model Answer:**\n- Induced vomiting\n**Clinical Explanation:** Doctor's warning.\n"
DRAFT = "## 🌟 IMP Points\n" + "\n".join(f"{heading}\n" + ("> [!CAUTION]\n> Never induce vomiting after corrosives." if index == 2 else IMP_EMPTY_NOTICES[index]) for index, heading in enumerate(IMP_HEADINGS)) + "\n## ❓ MCQs\n## ✍️ Written Questions\n" + BLOCK + "## 🩺 Clinical Cases\n"


def test_ledger_covers_every_character_and_recording_and_reuses_segments(tmp_path, monkeypatch):
    calls = []
    def extract(prompt, *_args, **_kwargs):
        segment = prompt.split("SPOKEN SEGMENT:\n", 1)[1]
        calls.append(segment)
        return {"points": [POINT] if SPOKEN in segment else []}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    text = "background " * 500 + SPOKEN
    path = tmp_path / "ledger.json"
    config = {"emphasis_segment_chars": 200, "lecture_writer_workers": 1}
    ledger = emphasis.build_ledger(("first.mp3", "second.mp3"), [text, SPOKEN], path, config)
    assert "".join(calls[:-1]) == text
    assert calls[-1] == SPOKEN
    assert len(ledger["points"]) == 2
    point = ledger["points"][-1]
    assert point["recording"] == "second.mp3"
    assert SPOKEN[point["start"]:point["end"]] == POINT["quote"]
    before = len(calls)
    assert emphasis.build_ledger(("first.mp3", "second.mp3"), [text, SPOKEN], path, config) == ledger
    assert len(calls) == before
    emphasis.build_ledger(("first.mp3", "second.mp3"), [text, SPOKEN + " changed"], path, config)
    assert len(calls) > before


def test_unspoken_quote_cannot_enter_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": [{**POINT, "quote": "slide-only fact"}]})
    ledger = emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {})
    assert ledger["complete"] and ledger["points"] == []
    assert ledger["rejected_points"][0]["raw"]["quote"] == "slide-only fact"
    assert "quote" in ledger["rejected_points"][0]["reason"]


def test_every_point_requires_section_two_and_generated_question_even_with_full_bank(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": [POINT]})
    ledger = emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {})
    point_id = ledger["points"][0]["id"]
    fingerprint = retained_question_fingerprint(BLOCK, "Question")
    def audit(*_args, **_kwargs):
        return {"sections": [{"point_id": point_id, "quote": "Never induce vomiting after corrosives."}],
                "questions": [{"fingerprint": fingerprint, "point_ids": [point_id]}], "unsupported_section2": []}
    monkeypatch.setattr(agy_writer, "request_json", audit)
    checked = emphasis.check_questions(DRAFT, ledger, {})
    assert emphasis.question_is_emphasized(BLOCK, "Question", checked)
    assert not emphasis.question_is_emphasized(BLOCK.replace("What must be avoided after corrosives?", "What causes fever?"), "Question", checked)
    with pytest.raises(ValueError, match="coverage"):
        emphasis.check_questions(DRAFT.replace(BLOCK, ""), ledger, {})


def test_past_exam_badge_is_independent_from_emphasis(tmp_path):
    paper = tmp_path / "Final_2024.txt"
    paper.write_text("1. What must be avoided after corrosives?\n")
    catalog = [{"canonical_name": paper.name, "aliases": [paper.name], "local_path": str(paper), "role": "past_exam", "verified_years": [2024], "content_status": "available"}]
    block = BLOCK.replace("**[IMP]**", "**[Past Exams - 2024]**") + "**Source:** Final_2024.txt\n"
    key = retained_question_fingerprint(block, "Question")
    ledger = {"points": [{"id": "e1"}], "question_points": {key: ["e1"]}}
    repaired, _ = repair_provenance_badges(block, catalog, ledger)
    assert "**[Past Exams (2024) / IMP]**" in repaired
    assert repair_provenance_badges(repaired, catalog, ledger) == (repaired, [])
    unimportant, _ = repair_provenance_badges(repaired, catalog, {"points": [], "question_points": {}})
    assert "**[Past Exams - 2024]**" in unimportant and " / IMP" not in unimportant
    missing = block.replace("What must be avoided after corrosives?", "What causes fever?")
    repaired, _ = repair_provenance_badges(missing, catalog, ledger)
    assert "**[Unverified Practice]**" in repaired and "[IMP]" not in repaired


@pytest.mark.parametrize("field", ["emphasis_segment_chars", "emphasis_prompt_chars"])
def test_invalid_limits_fail_before_model_request(tmp_path, field):
    with pytest.raises(ValueError, match=field):
        emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {field: 0})


def test_cached_prompt_version_is_invalidated(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: calls.append(1) or {"points": []})
    path = tmp_path / "ledger.json"
    emphasis.build_ledger(("a.mp3",), [SPOKEN], path, {})
    cached = json.loads(path.read_text())
    cached["version"] = "obsolete"
    path.write_text(json.dumps(cached))
    emphasis.build_ledger(("a.mp3",), [SPOKEN], path, {})
    assert len(calls) == 2


def test_unsupported_section_two_point_is_rejected_even_without_spoken_emphasis(monkeypatch):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {
        "sections": [], "questions": [], "unsupported_section2": ["A slide-only classification."]})
    with pytest.raises(ValueError, match="unsupported emphasis"):
        emphasis.check_questions("## 🌟 IMP Points\n- A slide-only classification.\n## ❓ MCQs\n", {"points": []}, {})


def test_interrupted_extraction_resumes_completed_segments(tmp_path, monkeypatch):
    calls = []
    def extract(prompt, *_a, **_k):
        calls.append(prompt)
        if len(calls) == 2:
            raise agy_writer.AgyWriterError("interrupted")
        return {"points": []}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    path = tmp_path / "ledger.json"
    with pytest.raises(agy_writer.AgyWriterError):
        emphasis.build_ledger(("a.mp3",), ["x" * 30], path, {"emphasis_segment_chars": 10, "lecture_writer_workers": 1})
    ledger = emphasis.build_ledger(("a.mp3",), ["x" * 30], path, {"emphasis_segment_chars": 10, "lecture_writer_workers": 1})
    assert ledger["complete"] and len(calls) == 4


def test_prompt_budget_never_silently_drops_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: pytest.fail("oversized prompt must fail before invocation"))
    with pytest.raises(ValueError, match="No evidence was truncated"):
        emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {"emphasis_segment_chars": 10, "emphasis_prompt_chars": 20})


@pytest.mark.parametrize("emphasized", [False, True])
def test_unlocated_question_uses_spoken_evidence_only(emphasized):
    block = BLOCK.replace("**[IMP]**", "**[Past Exams - 2025]**") + "**Source:** Missing.txt\n"
    key = retained_question_fingerprint(block, "Question")
    ledger = {"points": [{"id": "e1"}], "question_points": {key: ["e1"] if emphasized else []}}
    revised, corrections = repair_provenance_badges(block, [], ledger)
    assert ("**[IMP]**" in revised) is emphasized
    assert ("**[Unverified Practice]**" in revised) is not emphasized
    assert "Missing.txt" not in revised
    assert corrections[0]["retained_fingerprint"] == key
    assert repair_provenance_badges(revised, [], ledger) == (revised, [])


def test_sourced_and_generated_copies_remain_independent_through_final_review():
    from phase_validation import deduplicate_question_section

    source = BLOCK.replace("**[IMP]**", "**[Question Bank]** **[IMP]**") + "**Source:** Bank.txt\n"
    draft = DRAFT.replace("## 🩺 Clinical Cases", source.replace("Question 1", "Question 2") + "## 🩺 Clinical Cases")
    reviewed = deduplicate_question_section(draft, "Question")
    assert len(emphasis._section_blocks(reviewed, "Question")) == 2
    assert "**[Question Bank]** **[IMP]**" in reviewed
    assert "**[IMP]**" in reviewed


def test_split_emphasis_cue_keeps_spoken_quote_and_interactive_answer(tmp_path, monkeypatch):
    text = "Remember this question: what must you avoid? Induced vomiting. This kills."
    point = {"quote": "what must you avoid?", "emphasis_quote": "This kills.",
             "category": "class_questions", "explanation": "Avoid induced vomiting",
             "answer_quote": "Induced vomiting."}
    def extract(prompt, *_a, **_k):
        return {"points": [point] if "This kills." in prompt else []}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    ledger = emphasis.build_ledger(("a.mp3",), [text], tmp_path / "ledger.json", {"emphasis_segment_chars": 50})
    assert ledger["points"][0]["answer_quote"] == "Induced vomiting."
    assert text[ledger["points"][0]["start"]:ledger["points"][0]["end"]] == point["quote"]
    def imprecise(prompt, *_a, **_k):
        if "Resolve the doctor's class question" in prompt:
            return {"answer_quote": "Induced vomiting.", "answer": "Avoid induced vomiting", "related_to_lecture": True}
        return {"points": [{**point, "answer_quote": "Slide-only answer"}]}
    monkeypatch.setattr(agy_writer, "request_json", imprecise)
    repaired = emphasis.build_ledger(("a.mp3",), [text], tmp_path / "invalid.json", {})
    assert repaired["points"][0]["answer_quote"] == "Induced vomiting."
    assert "answer_quote" in repaired["rejected_points"][0]["reason"]


@pytest.mark.parametrize("result", [
    {"sections": {}, "questions": [], "unsupported_section2": []},
    {"sections": [None], "questions": [], "unsupported_section2": []},
    {"sections": [], "questions": [{"fingerprint": [], "point_ids": []}], "unsupported_section2": []},
])
def test_malformed_semantic_review_cannot_grant_importance(monkeypatch, result):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: result)
    with pytest.raises(ValueError, match="coverage"):
        emphasis.check_questions(DRAFT, {"points": [{"id": "e1"}]}, {})


def test_unverified_badge_and_sourced_imp_keep_distinct_validation_rules():
    from phase_validation import (
        _badge_errors,
        _mcq_field_errors,
        _option_shape_errors,
        _written_field_errors,
    )
    from transcriber_models import QuestionEvidence
    from transcript_parser import IMPORTANT, PAST_EXAMS, parse_badges

    evidence = QuestionEvidence({}, [])
    practice = BLOCK.replace("**[IMP]**", "**[Unverified Practice]**")
    assert _badge_errors(practice, set()) == _written_field_errors(practice, evidence) == []
    mcq = ("### MCQ 1 **[Unverified Practice]**\n**Question:** Novel assessment?\n"
           "**Options:**\na. First\nb. Second\nc. Third\n**Correct Answer:** a. First\n**Clinical Explanation:** Spoken explanation.\n")
    assert _mcq_field_errors(mcq, evidence) == []
    sourced_imp = mcq.replace("**[Unverified Practice]**", "**[Question Bank]** **[IMP]**") + "**Source:** Bank.txt\n"
    assert _option_shape_errors(sourced_imp, 1, {}) == []
    badges = parse_badges("**[Past Exams (2024) / IMP]**")
    assert [badge.kind for badge in badges] == [PAST_EXAMS, IMPORTANT]
    assert badges[0].years == (2024,)


def test_corrupt_saved_evidence_refuses_validation_and_can_be_rebuilt(tmp_path, monkeypatch):
    transcript = tmp_path / "Transcripts/Lecture.md.draft.md"
    path = emphasis.ledger_path(transcript)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"version": emphasis.PROMPT_VERSION, "input_files": []}))
    assert emphasis.read_ledger(path) == {}
    assert emphasis.validation_errors(DRAFT, emphasis.saved_ledger(transcript))
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": []})
    ledger = emphasis.build_ledger(("a.mp3",), [SPOKEN], path, {})
    assert ledger["complete"]
    assert emphasis.read_ledger(path) == ledger


def test_whitespace_variants_preserve_original_spans(tmp_path, monkeypatch):
    text = "Remember\n this: avoid\t vomiting. Answer:\nnever induce\n vomiting."
    point = {"quote": "avoid  vomiting.", "emphasis_quote": "Remember this:",
             "answer_quote": "never induce vomiting.", "category": "class_questions", "explanation": "Avoid vomiting"}
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": [point]})
    ledger = emphasis.build_ledger(("a.mp3",), [text], tmp_path / "ledger.json", {})
    assert not ledger["rejected_points"]
    actual = ledger["points"][0]
    for field, prefix in (("quote", ""), ("emphasis_quote", "emphasis_"), ("answer_quote", "answer_")):
        assert text[actual[prefix + "start"]:actual[prefix + "end"]] == actual[field]
        assert actual[field].split() == point[field].split()


@pytest.mark.parametrize("item", [None, {**POINT, "category": "unknown"}, {**POINT, "explanation": 7}])
def test_invalid_points_are_recorded_without_blocking_valid_points(tmp_path, monkeypatch, item):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": [item, POINT]})
    ledger = emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {})
    assert len(ledger["points"]) == 1
    assert ledger["rejected_points"][0]["raw"] == item


@pytest.mark.parametrize("payload", [None, [], {}, {"points": {}}])
def test_invalid_extraction_payload_still_fails(tmp_path, monkeypatch, payload):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: payload)
    with pytest.raises(ValueError, match="requires points"):
        emphasis.build_ledger(("a.mp3",), [SPOKEN], tmp_path / "ledger.json", {})


def test_concurrent_extraction_checkpoints_completion_in_recording_order(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    first_started, second_saved, release = Event(), Event(), Event()
    path = tmp_path / "ledger.json"
    write_json = emphasis._atomic_write_json
    def checkpoint(target, value):
        write_json(target, value)
        if "first.mp3:10" in value["segments"]:
            second_saved.set()
    def extract(prompt, *_a, **_k):
        segment = prompt.split("SPOKEN SEGMENT:\n")[1]
        if segment == "ImportantA":
            first_started.set()
            assert release.wait(10)
        else:
            assert first_started.wait(10)
        return {"points": [{**POINT, "quote": segment, "emphasis_quote": segment}]}
    monkeypatch.setattr(emphasis, "_atomic_write_json", checkpoint)
    monkeypatch.setattr(agy_writer, "request_json", extract)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(emphasis.build_ledger, ("first.mp3", "second.mp3"),
                             ["ImportantAImportantB", "ImportantC"], path,
                             {"emphasis_segment_chars": 10, "lecture_writer_workers": 2})
        try:
            assert second_saved.wait(10)
            partial = json.loads(path.read_text())
            assert not partial["complete"]
            assert "first.mp3:0" not in partial["segments"]
            assert partial["points"][0]["quote"] == "ImportantB"
        finally:
            release.set()
        ledger = future.result(timeout=10)
    assert [point["quote"] for point in ledger["points"]] == ["ImportantA", "ImportantB", "ImportantC"]
    assert json.loads(path.read_text()) == ledger


def test_class_question_uses_later_verbatim_explanation(tmp_path, monkeypatch):
    question = {"quote": "What must you avoid?", "emphasis_quote": "What must you avoid?",
                "explanation": "Avoid induced vomiting", "category": "class_questions"}
    text = "What must you avoid?\n\n" + "unrelated context " * 50 + "\n\nAvoid induced vomiting."
    def extract(prompt, *_a, **_k):
        if "Resolve the doctor's class question" in prompt:
            assert "Avoid induced vomiting." in prompt
            return {"answer_quote": "Avoid induced vomiting."}
        return {"points": [question] if "What must you avoid?" in prompt.split("SPOKEN SEGMENT:\n")[1] else []}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    ledger = emphasis.build_ledger(("a.mp3",), [text], tmp_path / "ledger.json", {"emphasis_segment_chars": 100})
    point = ledger["points"][0]
    assert point["answer_quote"] == text[point["answer_start"]:point["answer_end"]] == "Avoid induced vomiting."
    assert point["answer_recording"] == "a.mp3"


def test_five_spoken_groups_and_warning_callouts():
    from phase_validation import imp_structure_errors
    from question_prompts import IMP_EMPTY_NOTICES, IMP_HEADINGS, build_imp_prompt

    section = "\n".join(f"{heading}\n{notice}" for heading, notice in zip(IMP_HEADINGS, IMP_EMPTY_NOTICES))
    assert not imp_structure_errors(section)
    assert not imp_structure_errors(section.replace(IMP_EMPTY_NOTICES[1], "No class questions were asked."))
    assert not imp_structure_errors(section.replace(IMP_EMPTY_NOTICES[1], IMP_EMPTY_NOTICES[1].rstrip(".")))
    assert imp_structure_errors(section.replace(IMP_EMPTY_NOTICES[2], "- A dangerous mistake"))
    for callout in ("WARNING", "CAUTION"):
        assert not imp_structure_errors(section.replace(IMP_EMPTY_NOTICES[2], f"> [!{callout}]\n> A dangerous mistake"))
    prompt = build_imp_prompt("Lecture", "spoken ledger")
    assert all(heading in prompt for heading in IMP_HEADINGS)
    assert "attendance without a marks rule" in prompt and "later" in prompt and "point IDs" in prompt


def test_new_categories_keep_exact_evidence_in_lecture_time_order(tmp_path, monkeypatch):
    text = "Remember treatment. What drug? Atropine. This kills. Attendance has marks. This comes in the exam: atropine."
    points = [
        {"quote": "Remember treatment.", "emphasis_quote": "Remember", "category": "key_points", "explanation": "Treatment"},
        {"quote": "What drug?", "emphasis_quote": "What drug?", "answer_quote": "Atropine.", "category": "class_questions", "explanation": "Atropine"},
        {"quote": "This kills.", "emphasis_quote": "kills", "category": "warnings", "severity": "lethal", "explanation": "Danger"},
        {"quote": "Attendance has marks.", "emphasis_quote": "has marks", "category": "course_instructions", "explanation": "Attendance marks"},
        {"quote": "This comes in the exam: atropine.", "emphasis_quote": "comes in the exam", "answer_quote": "atropine.", "category": "exam_flagged", "explanation": "Atropine"},
    ]
    def extract(prompt, *_a, **_k):
        assert "Exclude classroom management" in prompt and "Exclude jokes" in prompt
        return {"points": list(reversed(points))}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    ledger = emphasis.build_ledger(("a.mp3",), [text], tmp_path / "ledger.json", {})
    assert [point["category"] for point in ledger["points"]] == list(emphasis.CATEGORIES)
    assert [text[point["start"]:point["end"]] for point in ledger["points"]] == [point["quote"] for point in points]


def test_unanswered_medical_class_question_keeps_labelled_best_answer(tmp_path, monkeypatch):
    point = {"quote": "Which antidote treats organophosphates?", "emphasis_quote": "Which antidote treats organophosphates?",
             "category": "class_questions", "explanation": "Antidote question", "related_to_lecture": True}
    def extract(prompt, *_a, **_k):
        if "Resolve the doctor's class question" in prompt:
            return {"answer_quote": "", "answer": "Atropine", "related_to_lecture": True}
        return {"points": [point]}
    monkeypatch.setattr(agy_writer, "request_json", extract)
    ledger = emphasis.build_ledger(("a.mp3",), [point["quote"]], tmp_path / "ledger.json", {})
    actual = ledger["points"][0]
    assert actual["answer"] == "Atropine" and actual["answer_source"] == "not stated in the lecture"
    assert actual["answer_quote"] == ""
    from phase_validation import imp_structure_errors
    from question_prompts import IMP_EMPTY_NOTICES, IMP_HEADINGS
    body = "\n".join(f"{heading}\n{notice}" for heading, notice in zip(IMP_HEADINGS, IMP_EMPTY_NOTICES))
    answered = body.replace(IMP_EMPTY_NOTICES[1], "- **Q:** Which antidote? **Answer:** Atropine (مش مذكورة في المحاضرة)")
    assert not imp_structure_errors(answered)
    assert imp_structure_errors(answered.replace(" (مش مذكورة في المحاضرة)", ""))
    assert imp_structure_errors(answered.replace("**Answer:** Atropine", ""))
    assert not imp_structure_errors(answered.replace("(مش مذكورة في المحاضرة)", "«Atropine is the antidote.»"))
    question = BLOCK.replace("What must be avoided after corrosives?", point["quote"]).replace("Induced vomiting", "Atropine")
    draft = "## 🌟 IMP Points\n" + answered + "\n## ❓ MCQs\n## ✍️ Written Questions\n" + question + "## 🩺 Clinical Cases\n"
    def audit(prompt, *_a, **_k):
        assert "labelled fallback" in prompt
        return {"sections": [{"point_id": actual["id"], "quote": "Atropine (مش مذكورة في المحاضرة)"}],
                "questions": [{"fingerprint": retained_question_fingerprint(question, "Question"), "point_ids": [actual["id"]]}] if retained_question_fingerprint(question, "Question") in prompt else [],
                "unsupported_section2": []}
    monkeypatch.setattr(agy_writer, "request_json", audit)
    checked = emphasis.check_questions(draft, ledger, {})
    assert emphasis.question_is_emphasized(question, "Question", checked)
    assert emphasis.check_questions(draft.replace(question, ""), ledger, {})["section_points"] == [actual["id"]]



def test_unrelated_classroom_question_is_not_in_ledger(tmp_path, monkeypatch):
    point = {"quote": "Who brought the cable?", "emphasis_quote": "Who brought the cable?", "category": "class_questions",
             "explanation": "Classroom equipment", "related_to_lecture": False}
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: {"points": [point]})
    ledger = emphasis.build_ledger(("a.mp3",), [point["quote"]], tmp_path / "ledger.json", {})
    assert ledger["points"] == [] and "unrelated" in ledger["rejected_points"][0]["reason"]


def test_sourced_question_counts_as_tested_spoken_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_writer, "request_json", lambda *_args, **_kwargs: {"points": [POINT]})
    ledger = emphasis.build_ledger(("lecture.mp3",), [SPOKEN], tmp_path / "emphasis.json", {})
    point_id = ledger["points"][0]["id"]
    sourced = BLOCK.replace("**[IMP]**", "**[Past Exams (2024) / IMP]**") + "**Source:** Final_2024.txt\n"
    key = retained_question_fingerprint(sourced, "Question")
    monkeypatch.setattr(agy_writer, "request_json", lambda *_args, **_kwargs: {
        "sections": [{"point_id": point_id, "quote": "Never induce vomiting after corrosives."}],
        "questions": [{"fingerprint": key, "point_ids": [point_id]}], "unsupported_section2": []})
    draft = DRAFT.replace(BLOCK, sourced)
    checked = emphasis.check_questions(draft, ledger, {})
    assert checked["generated_questions"] == []
    assert checked["question_points"][key] == [point_id]
    assert emphasis.validation_errors(draft, checked) == []


@pytest.mark.parametrize("workers", [1, 2])
def test_bounded_review_overlaps_requests_and_merges_in_input_order(monkeypatch, workers):
    from threading import Barrier, Event, Lock

    barrier = Barrier(workers, timeout=5)
    lock = Lock()
    finished = Event()
    active = peak = 0
    completed = []
    blocks = {str(index): "q" * 100 for index in range(4)}
    def prompt_for(batch):
        return 'SPOKEN EMPHASIS LEDGER:\n[]\nSECTION 2:\n\nQUESTIONS BY FINGERPRINT:\n' + json.dumps(batch)
    budget = len(prompt_for({"0": blocks["0"]}))
    def audit(prompt, *_args, **_kwargs):
        nonlocal active, peak
        assert len(prompt) <= budget
        key = next(iter(json.loads(prompt.split("QUESTIONS BY FINGERPRINT:\n")[1])))
        with lock:
            active += 1
            peak = max(peak, active)
        barrier.wait()
        if workers == 2 and key == "0":
            assert finished.wait(5)
        with lock:
            completed.append(key)
            active -= 1
        if key == "1":
            finished.set()
        return {"sections": [], "questions": [{"fingerprint": key, "point_ids": [key]}], "unsupported_section2": []}
    monkeypatch.setattr(agy_writer, "request_json", audit)
    result = emphasis._bounded_review(prompt_for(blocks), budget, "fake", 10, workers=workers)
    assert peak == workers
    assert [entry["fingerprint"] for entry in result["questions"]] == list(blocks)
    if workers == 2:
        assert completed.index("1") < completed.index("0")


def test_bounded_review_propagates_request_cancellation_to_workers(monkeypatch):
    from threading import Barrier, Event

    import cancellation

    cancelled = Event()
    barrier = Barrier(2, action=cancelled.set, timeout=5)
    def audit(*_args, **_kwargs):
        barrier.wait()
        cancellation.check_cancelled()
        pytest.fail("worker lost the request cancellation context")
    monkeypatch.setattr(agy_writer, "request_json", audit)
    prompt = 'SPOKEN EMPHASIS LEDGER:\n[]\nSECTION 2:\n\nQUESTIONS BY FINGERPRINT:\n' + json.dumps({"a": "x" * 100, "b": "y" * 100})
    with cancellation.request_scope(cancelled), pytest.raises(cancellation.OperationCancelled):
        emphasis._bounded_review(prompt, len(prompt) - 50, "fake", 10, workers=2)


def test_badge_only_repair_reuses_coverage_without_requests(monkeypatch):
    key = retained_question_fingerprint(BLOCK, "Question")
    ledger = {"complete": True, "points": [{"id": "e1"}], "question_points": {key: ["e1"]},
              "section_coverage_keys": emphasis.section_coverage_keys(DRAFT)}
    sourced = DRAFT.replace("**[IMP]**", "**[Past Exams - 2025]**")
    repaired, corrections = repair_provenance_badges(sourced, [], ledger)
    assert corrections
    monkeypatch.setattr(agy_writer, "request_json", lambda *_a, **_k: pytest.fail("unchanged wording must reuse review"))
    refreshed = emphasis.refresh_coverage(repaired, ledger, {}, model="fake", timeout=10)
    assert emphasis.validation_errors(repaired, refreshed) == []


@pytest.mark.parametrize("changed_section", range(4))
def test_changed_assessment_reviews_only_its_section(monkeypatch, changed_section):
    from assessment_parts import HEADINGS
    from test_assessment_parts import _question

    draft = DRAFT.split("## ❓ MCQs")[0] + "".join(HEADINGS[index] + "\n" + _question(index, 1, f"Unique stem {index}") for index in (1, 2, 3))
    ledger = {"complete": True, "points": [{"id": "e1", "category": "class_questions", "quote": "warning", "explanation": "warning"}],
              "question_points": {retained_question_fingerprint(_question(index, 1, f"Unique stem {index}"), kind): ["e1"]
                                  for index, kind in enumerate(("MCQ", "Question", "Clinical Case"), 1)},
              "section_points": ["e1"], "section_coverage_keys": emphasis.section_coverage_keys(draft)}
    changed = draft.replace("Never induce vomiting", "Never ever induce vomiting") if changed_section == 0 else draft.replace(f"Unique stem {changed_section}", f"Revised stem {changed_section}")
    audits = []
    def audit(prompt, *_args, **_kwargs):
        section, raw = prompt.split("\nSECTION 2:\n")[1].split("\nQUESTIONS BY FINGERPRINT:\n")
        blocks = json.loads(raw)
        audits.append((section, blocks))
        assert bool(section.strip()) == (changed_section == 0)
        assert all(f"Revised stem {changed_section}" in block for block in blocks.values())
        return {"sections": [{"point_id": "e1", "quote": "Never ever induce vomiting after corrosives."}] if changed_section == 0 else [],
                "questions": [{"fingerprint": key, "point_ids": ["e1"]} for key in blocks], "unsupported_section2": []}
    monkeypatch.setattr(agy_writer, "request_json", audit)
    checked = emphasis.refresh_coverage(changed, ledger, {}, model="fake", timeout=10)
    assert len(audits) == 1
    assert emphasis.validation_errors(changed, checked) == []
    assert checked["section_points"] == ["e1"]


def test_guide_quizzes_and_assembly_normalization_do_not_change_coverage():
    guide = "## 📖 Chronological Guide\n" + BLOCK.replace("What must be avoided", "Guide quiz: what must be avoided")
    normalized = DRAFT.replace("Question 1", "Question 8").replace("## 🌟 IMP Points", "## 🌟 IMP Points (reviewed)").replace("## ❓ MCQs", "---\n\n## ❓ MCQs")
    assert emphasis.coverage_key(guide + normalized) == emphasis.coverage_key(DRAFT)


def test_duplicate_question_cleanup_preserves_reviewed_identities():
    from question_sections import normalize_question_sections

    repeated = DRAFT.replace(BLOCK, BLOCK + "\n" + BLOCK)
    cleaned = normalize_question_sections(repeated)
    assert cleaned != repeated
    assert emphasis.coverage_key(cleaned) == emphasis.coverage_key(repeated)


def test_point_batch_reviews_keep_support_from_either_half(monkeypatch):
    points = [{"id": str(index), "quote": "q" * 100} for index in range(4)]
    def prompt_for(batch):
        return 'SPOKEN EMPHASIS LEDGER:\n' + json.dumps(batch) + '\nSECTION 2:\nclaim\nQUESTIONS BY FINGERPRINT:\n{"question": "stem"}'
    budget = len(prompt_for(points[:1]))
    def audit(prompt, *_args, **_kwargs):
        assert len(prompt) <= budget
        batch = json.loads(prompt.split("SPOKEN EMPHASIS LEDGER:\n")[1].split("\nSECTION 2:")[0])
        point_id = batch[0]["id"]
        return {"sections": [{"point_id": point_id, "quote": "claim"}],
                "questions": [{"fingerprint": "question", "point_ids": [point_id]}],
                "unsupported_section2": ["always unsupported"] + ([] if point_id == "3" else ["claim"])}
    monkeypatch.setattr(agy_writer, "request_json", audit)
    checked = emphasis._bounded_review(prompt_for(points), budget, "fake", 10, workers=2)
    assert [entry["point_id"] for entry in checked["sections"]] == ["0", "1", "2", "3"]
    assert checked["questions"] == [{"fingerprint": "question", "point_ids": ["0", "1", "2", "3"]}]
    assert set(checked["unsupported_section2"]) == {"always unsupported"}
