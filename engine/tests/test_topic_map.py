"""Bad topic maps cannot silently drop a cohort or create unsafe slices."""

import copy
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))

from phase_validation import SECTION_HEADINGS, guide_topic_errors
from test_multi_recording_plan import SOURCES, lecture_topics
from topic_map import (
    duplicate_topic_errors,
    duplicate_topic_pairs,
    parse_topics,
    topic_anchor_counts,
)
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


@pytest.mark.parametrize("damage", ["most-anchors", "unknown-recording", "empty", "missing-cohort", "overlap", "duplicate", "wrong-cohort"])
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
    elif damage == "duplicate":
        payload["topics"][1]["title"] = payload["topics"][0]["title"]
        payload["topics"][1]["gloss"] = payload["topics"][0]["gloss"]
    elif damage == "most-anchors":
        for topic in payload["topics"]:
            for span in topic["spans"]:
                span["first_words"] = span["last_words"] = "unrelated invented passage"
    else:
        payload["topics"][0]["spans"][0]["recording"] = "absent"
    with pytest.raises(ValueError):
        parse_topics(payload, SOURCES, texts)


def synthetic_map(passages):
    source = "Synthetic boys.m4a"
    topics = [{"title": f"Topic {index}", "gloss": f"موضوع {index}", "spans": [{
        "recording": source, "cohort": "boys", "first_words": passage,
        "last_words": passage,
    }]} for index, passage in enumerate(passages)]
    return (source,), [" ".join(passages)], {"topics": topics}


def test_distinct_spoken_topics_can_reference_the_same_slide():
    sources, texts, payload = synthetic_map(["افتتاح الموضوع", "شرح آخر مستقل"])
    for topic in payload["topics"]:
        topic["slide_title"] = "Shared slide"
    parsed = parse_topics(payload, sources, texts)
    assert len(parsed) == 2
    assert [texts[0][topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in parsed] == ["افتتاح الموضوع", "شرح آخر مستقل"]


def test_agy_metadata_is_ignored_without_mutating_the_proposal():
    sources, texts, payload = synthetic_map(["مقدمة الدرس وأمثلة بسيطة"])
    payload.update(toolAction="Submitting map", toolSummary="Finished")
    original = copy.deepcopy(payload)
    parsed = parse_topics(payload, sources, texts)
    assert parsed[0]["spans"][0]["end"] == len(texts[0])
    assert payload == original
    payload["unexpected"] = True
    with pytest.raises(ValueError):
        parse_topics(payload, sources, texts)


@pytest.mark.parametrize("passage,anchor,first_kind", [
    ("أول حالة فيها إصابة واضحة في الرئة", "اول حاله فيها اصابه واضحه في الرئه", "fuzzy"),
    ("بداية الحديث عن الحالة دي محتاجة متابعة دقيقة", "مقدمة الكلام عن الحالة دي محتاجة متابعة دقيقة", "repaired"),
    ("المريض عنده ألم شديد والضغط منخفض جدا النهارده", "المريض عنده ألمشديد والضغط منخفض جدا النهارده", "fuzzy"),
    ("انتبه للحالة لأن المريض بيحتاج سوائل بسرعة", "انتبه للحاله لان المريض بيحتاج سوائل بسرعه", "fuzzy"),
    ("المريض محتاج متابعة وبعدها هنراجع الباراميتر الموجود في التقرير", "المريض محتاج متابعة وبعدها هنراجع الباراميترات الموجود في التقرير", "fuzzy"),
])
def test_noisy_anchors_recover_the_original_text(passage, anchor, first_kind):
    sources, texts, payload = synthetic_map([passage])
    payload["topics"][0]["spans"][0].update(first_words=anchor, last_words=anchor)
    parsed = parse_topics(payload, sources, texts)
    span = parsed[0]["spans"][0]
    assert texts[0][span["start"]:span["end"]] == passage
    assert span["anchor_resolution"] == {"first_words": first_kind, "last_words": "fuzzy"}


def test_unplaceable_paraphrased_tail_snaps_to_the_next_topic():
    passages = ["بداية المحاضرة موضوع تمهيدي", "القلب بيضخ الدم للجسم ونراقب النبض", "الكلى تخرج المياه الزائدة"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][1]["spans"][0]["last_words"] = "شرح الدورة الدموية بطريقة مختلفة تماما"
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in parsed] == passages
    assert parsed[1]["spans"][0]["anchor_resolution"]["last_words"] == "repaired"


def test_repeated_anchor_uses_both_neighbouring_spans():
    passages = ["مقدمة مشتركة ثم تفاصيل أولى", "مقدمة مشتركة ثم تفاصيل ثانية", "خاتمة واضحة"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][1]["spans"][0]["first_words"] = "مقدمة مشتركة"
    parsed = parse_topics(payload, sources, texts)
    span = parsed[1]["spans"][0]
    assert texts[0][span["start"]:span["end"]] == passages[1]
    assert span["anchor_resolution"]["first_words"] == "exact"


def test_later_return_keeps_its_original_topic_ownership():
    passages = ["افتتاح أول", "شرح ثاني", "عودة للأول"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][0]["spans"].extend(payload["topics"].pop()["spans"])
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][span["start"]:span["end"]] for span in parsed[0]["spans"]] == [passages[0], passages[2]]


def test_ambiguous_later_return_cannot_reopen_an_already_owned_passage():
    opening = "unique alpha introduction detail context marker"
    closing = "unique alpha closing detail context marker"
    repeat = "common repeated phrase one two three"
    beta = "unique beta introduction detail context marker unique beta closing detail context marker"
    alpha = " ".join([opening, repeat, closing])
    sources, texts, payload = synthetic_map([alpha, beta, repeat])
    payload["topics"][0]["spans"][0].update(first_words=opening, last_words=closing)
    payload["topics"][0]["spans"].extend(payload["topics"].pop()["spans"])
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][span["start"]:span["end"]] for span in parsed[0]["spans"]] == [alpha, repeat]
    span = parsed[1]["spans"][0]
    assert texts[0][span["start"]:span["end"]] == beta


def test_broad_overlap_cannot_hide_a_repeat_proven_by_its_last_anchor():
    opening = "unique alpha introduction detail context marker"
    closing = "unique alpha closing detail context marker"
    repeat = "common repeated phrase one two three"
    beta_close = "unique beta closing detail context marker"
    gamma_open = "unique gamma introduction detail context marker"
    passages = [f"{opening} {closing}", f"{repeat} {beta_close}", f"{gamma_open} {repeat}"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][0]["spans"][0].update(first_words=opening, last_words=gamma_open)
    payload["topics"][1]["spans"][0].update(first_words=repeat, last_words=beta_close)
    payload["topics"][2]["spans"][0].update(first_words=gamma_open, last_words="unrelated completely absent words")
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in parsed] == passages


@pytest.mark.parametrize("edge", ["first_words", "last_words"])
def test_isolated_missing_anchor_uses_the_neighbouring_edge(edge):
    passages = ["افتتاح المحاضرة", "القلب يضخ الدم", "نهاية المحاضرة"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][1]["spans"][0][edge] = "حديث آخر لا يشبه النص إطلاقا"
    parsed = parse_topics(payload, sources, texts)
    span = parsed[1]["spans"][0]
    assert texts[0][span["start"]:span["end"]] == passages[1]
    assert span["anchor_resolution"][edge] == "repaired"


def test_gaps_and_broad_overlaps_partition_at_topic_starts():
    passages = ["الافتتاح وبعض التفاصيل", "القلب وضغط الدم", "الكلى والسوائل"]
    sources, texts, payload = synthetic_map(passages)
    payload["topics"][0]["spans"][0]["first_words"] = "وبعض التفاصيل"
    payload["topics"][0]["spans"][0]["last_words"] = passages[-1]
    payload["topics"][1]["spans"][0].update(first_words="القلب", last_words="وضغط")
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in parsed] == passages
    assert parsed[0]["spans"][0]["anchor_resolution"]["first_words"] == "repaired"
    assert all(topic["spans"][0]["anchor_resolution"]["last_words"] == "repaired" for topic in parsed[:2])


@pytest.mark.parametrize("damage", ["overlap", "reversed", "reversed-tail", "unordered"])
def test_located_spans_repair_boundaries_without_reassigning_topics(damage):
    passages = ["alpha opening detailed words alpha closing", "beta opening detailed words beta closing",
                "gamma opening detailed words gamma closing"]
    sources, texts, payload = synthetic_map(passages)
    for topic, passage in zip(payload["topics"], passages):
        topic["spans"][0].update(first_words=" ".join(passage.split()[:2]), last_words=" ".join(passage.split()[-2:]))
    if damage == "unordered":
        payload["topics"].reverse()
        passages.reverse()
    elif damage == "overlap":
        payload["topics"][0]["spans"][0]["last_words"] = "gamma closing"
    elif damage == "reversed-tail":
        # Repeated closing words do not justify swapping ownership to an earlier topic.
        texts[0] = texts[0].replace("alpha closing", "repeated closing repeated closing")
        payload["topics"][0]["spans"][0]["last_words"] = "repeated closing"
        payload["topics"][1]["spans"][0]["last_words"] = "repeated closing"
        passages[0] = passages[0].replace("alpha closing", "repeated closing repeated closing")
    else:
        span = payload["topics"][1]["spans"][0]
        span["first_words"], span["last_words"] = span["last_words"], span["first_words"]
    parsed = parse_topics(payload, sources, texts)
    assert [texts[0][topic["spans"][0]["start"]:topic["spans"][0]["end"]] for topic in parsed] == passages
    ordered = sorted((topic["spans"][0] for topic in parsed), key=lambda span: span["start"])
    assert " ".join(texts[0][span["start"]:span["end"]] for span in ordered) == texts[0]
    assert all(left["end"] <= right["start"] for left, right in zip(ordered, ordered[1:]))
    if damage != "unordered":
        assert topic_anchor_counts(parsed)["repaired"] > 0


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
