"""Bad topic maps cannot silently drop a cohort or create unsafe slices."""

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from phase_validation import SECTION_HEADINGS, guide_topic_errors
from test_multi_recording_plan import SOURCES, lecture_topics
from topic_map import duplicate_topic_errors, duplicate_topic_pairs, parse_topics
from transcript_contract import validate_complete_transcript


def test_topics_resolve_exact_anchors_from_every_cohort():
    texts, payload = lecture_topics()
    parsed = parse_topics(payload, SOURCES, texts)
    for index, source in enumerate(SOURCES):
        spans = [topic["spans"][index] for topic in parsed]
        recovered = " ".join(texts[index][span["start"]:span["end"]] for span in spans)
        assert recovered == texts[index]
        assert all(span["recording"] == source for span in spans)
        assert {span["cohort"] for span in spans} == {"boys" if index < 2 else "girls"}


@pytest.mark.parametrize("damage", ["missing-anchor", "unknown-recording", "empty", "missing-cohort", "overlap", "duplicate", "wrong-cohort", "small-gap", "matched-slide"])
def test_invalid_maps_are_rejected_instead_of_dropping_spoken_points(damage):
    texts, payload = lecture_topics()
    if damage == "empty":
        payload = {"topics": []}
    elif damage == "missing-cohort":
        for topic in payload["topics"]:
            topic["spans"].pop()
    elif damage == "overlap":
        payload["topics"][1]["spans"].append(copy.deepcopy(payload["topics"][0]["spans"][0]))
    elif damage == "wrong-cohort":
        payload["topics"][0]["spans"][0]["cohort"] = "girls"
    elif damage == "small-gap":
        payload["topics"][0]["spans"][0]["first_words"] = " ".join(texts[0].split()[1:4])
    elif damage == "matched-slide":
        payload["topics"][0]["slide_title"] = "Transport"
        payload["topics"][1]["slide_title"] = "Transport"
    elif damage == "duplicate":
        payload["topics"][1]["title"] = payload["topics"][0]["title"]
        payload["topics"][1]["gloss"] = payload["topics"][0]["gloss"]
    else:
        payload["topics"][0]["spans"][0]["first_words" if damage == "missing-anchor" else "recording"] = "absent"
    with pytest.raises(ValueError):
        parse_topics(payload, SOURCES, texts)


@pytest.mark.parametrize("lecture", ["endo", "shock"])
def test_reviewer_heading_lists_find_only_the_expected_pairs(lecture):
    fixture = json.loads((Path(__file__).parent / "fixtures/topic-headings" / f"{lecture}.json").read_text())
    headings = [heading.removeprefix("### ") for heading in fixture["headings"]]
    expected = [tuple(heading.removeprefix("### ") for heading in pair) for pair in fixture["expected_pairs"]]
    assert duplicate_topic_pairs(headings) == expected
    text = "\n\n".join([SECTION_HEADINGS[0], *fixture["headings"], *SECTION_HEADINGS[1:]])
    findings = [error for error in validate_complete_transcript(text) if error.startswith("duplicate guide topic:")]
    assert findings == duplicate_topic_errors(headings)
    assert len(findings) == len(expected)


@pytest.mark.parametrize("headings", [
    ["Hormone Nature, Signaling Mechanisms & Transport", "Hormone Transport & Binding Proteins"],
    ["The Prolactin Exception & Dopamine Regulation", "Prolactin Regulation & Dopamine Control"],
    ["Hormone transport — نواقل الهرمونات", "Hormone transport — تصنيع الهرمونات"],
    ["Hypovolemic shock — صدمة نقص حجم الدم", "Hypovolemic shock: causes — صدمة نقص حجم الدم"],
    ["Cardiogenic shock: causes — أسباب الصدمة القلبية", "Cardiogenic shock: management — أسباب الصدمة القلبية"],
    ["Hormone Transport & Binding Proteins — نواقل الهرمونات والبروتينات الناقلة", "Hormone Transport Across Cell Membranes — نقل الهرمونات عبر أغشية الخلايا"],
    ["Diagnostic approach — الخطوات الثلاث لتشخيص المريض", "Diagnostic approach — الخطوات الأربع لتشخيص المريض"],
])
def test_partial_title_agreement_or_different_scopes_cannot_trigger_a_merge(headings):
    assert duplicate_topic_pairs(headings) == []


def test_exact_repeated_heading_without_a_gloss_is_still_reported():
    headings = ["Hormone Transport & Binding Proteins", "Hormone Transport & Binding Proteins"]
    assert duplicate_topic_pairs(headings) == [(headings[0], headings[1])]


def test_distinct_endocrine_topics_and_assessment_headings_do_not_collide():
    guide = "\n".join(f"### {title}\nSpoken point" for title in (
        "Hormone Synthesis", "Hormone Secretion", "Thyroid Diagnosis", "Thyroid Treatment",
        "Prolactin Regulation & Dopamine Control", "Growth Hormone Regulation & Feedback Control",
        "Clinical Features of Shock", "Clinical Features of Sepsis",
    ))
    assert guide_topic_errors(guide) == []


@pytest.mark.parametrize("supplement,valid", [
    ("> [!summary]- في السلايدات ومتشرحش\n> - Key classification.", True),
    ("> [!summary] في السلايدات ومتشرحش\n> - Key classification.", False),
    ("> [!summary]- في السلايدات ومتشرحش\n> - Key number.\n### Another topic", False),
    ("> [!summary]- في السلايدات ومتشرحش", False),
    ("> [!summary]- في السلايدات ومتشرحش\n> ### Slide title", False),
    (("> [!summary]- في السلايدات ومتشرحش\n> - Item.\n") * 2, False),
])
def test_unspoken_section_is_one_folded_callout_at_the_guide_end(supplement, valid):
    errors = guide_topic_errors("### Transport — نقل الهرمونات\nSpoken detail.\n\n" + supplement)
    assert (errors == []) is valid


def test_final_document_validator_accepts_folded_guide_summary():
    from universal_transcribe import final_document_errors

    text = "\n\n".join([
        SECTION_HEADINGS[0], "### Transport — النقل\nSpoken detail.",
        "> [!summary]- في السلايدات ومتشرحش\n> - Key classification.",
        *SECTION_HEADINGS[1:],
    ])
    assert not any("callout" in error or "summary" in error for error in final_document_errors(text, set()))


def test_unspoken_summary_in_assessments_is_refused():
    text = "\n\n".join([*SECTION_HEADINGS, "> [!summary]- في السلايدات ومتشرحش\n> - Important item."])
    assert any("summary belongs only" in error for error in validate_complete_transcript(text))


def test_lecture_frequent_content_words_cannot_merge_distinct_complications():
    headings = [
        "Renal injury, Proteinuria & Hematuria — إصابة الكلى والبروتين في البول والدم",
        "Renal injury, Proteinuria & Edema — إصابة الكلى والبروتين في البول والتورم",
        "Renal injury and Proteinuria Screening — فحص إصابة الكلى والبروتين في البول",
        "Renal injury and Proteinuria Follow-up — متابعة إصابة الكلى والبروتين في البول",
        "Renal injury and Proteinuria Prognosis — مستقبل إصابة الكلى والبروتين في البول",
        "Renal injury and Proteinuria Complications — مضاعفات إصابة الكلى والبروتين في البول",
    ]
    assert duplicate_topic_pairs(headings) == []
