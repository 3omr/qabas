"""Persist quoted spoken emphasis and independently checked assessment coverage.

Only ordered verbatims enter extraction. Question receipts bind semantic review
against that evidence to exact wording/options; Markdown badges grant no receipt.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path
from threading import Lock
from typing import Any

import agy_writer
import cancellation
from atomic_io import _atomic_write_json
from phase_validation import (
    SECTION_HEADINGS,
    _section_blocks,
    imp_structure_errors,
    retained_question_fingerprint,
)
from question_prompts import IMP_EMPTY_NOTICES

PROMPT_VERSION = "spoken-emphasis-4"
CATEGORIES = ("key_points", "class_questions", "warnings", "course_instructions", "exam_flagged")
# Class questions and course instructions are covered by Section 2 only.
GENERATED_CATEGORIES = frozenset({"key_points", "warnings", "exam_flagged"})
POINT_SCHEMA = {"type": "object", "properties": {
    "points": {"type": "array", "items": {"type": "object", "properties": {
        **{field: {"type": "string"} for field in ("quote", "emphasis_quote", "explanation", "category", "answer_quote", "severity")},
        "related_to_lecture": {"type": "boolean"},
    }, "required": ["quote", "emphasis_quote", "explanation", "category"]}},
}, "required": ["points"]}
COVERAGE_SCHEMA = {"type": "object", "properties": {
    "sections": {"type": "array", "items": {"type": "object", "properties": {
        "point_id": {"type": "string"}, "quote": {"type": "string"}}, "required": ["point_id", "quote"]}},
    "questions": {"type": "array", "items": {"type": "object", "properties": {
        "fingerprint": {"type": "string"}, "point_ids": {"type": "array", "items": {"type": "string"}}},
        "required": ["fingerprint", "point_ids"]}},
    "unsupported_section2": {"type": "array", "items": {"type": "string"}},
}, "required": ["sections", "questions", "unsupported_section2"]}


def limits(config: dict[str, Any]) -> tuple[int, int]:
    """Resolve validated extraction and editorial input character budgets."""
    values = []
    for key, default in (("emphasis_segment_chars", 12000), ("emphasis_prompt_chars", 100000)):
        value = config.get(key, default)
        if type(value) is not int or value <= 0:
            raise ValueError(f"{key} must be a positive integer")
        values.append(value)
    if values[0] >= values[1]:
        raise ValueError("emphasis_prompt_chars must exceed emphasis_segment_chars")
    return values[0], values[1]


def fingerprint(sources: tuple[str, ...], texts: list[str], config: dict[str, Any]) -> str:
    """Hash ordered recording identities, complete verbatims and extraction rules."""
    from lecture_answers import evidence_limit

    # 2000 was the answer_evidence_chars default when complete ledgers were first saved;
    # hashing it for an unset value keeps those ledgers reusable under the 600 default.
    answer_chars = evidence_limit({"answer_evidence_chars": config.get("answer_evidence_chars", 2000)})
    return hashlib.sha256(json.dumps([PROMPT_VERSION, limits(config), answer_chars, list(zip(sources, texts))], ensure_ascii=False).encode()).hexdigest()


def read_ledger(path: Path) -> dict[str, Any]:
    """Read an engine-owned cache; corrupt or obsolete caches grant no emphasis."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict) or value.get("version") != PROMPT_VERSION:
        return {}
    if (not isinstance(value.get("fingerprint"), str) or type(value.get("complete")) is not bool
        or not isinstance(value.get("segments"), dict) or not isinstance(value.get("points"), list)
        or not isinstance(value.get("question_points"), dict) or not isinstance(value.get("input_files", {}), dict)):
        return {}
    if any(not isinstance(point, dict) or not isinstance(point.get("id"), str) for point in value["points"]):
        return {}
    if any(not isinstance(key, str) or not isinstance(points, list) or any(not isinstance(point, str) for point in points)
           for key, points in value["question_points"].items()):
        return {}
    section_keys = value.get("section_coverage_keys", {})
    if not isinstance(section_keys, dict) or any(key not in {"0", "1", "2", "3"} or not isinstance(digest, str)
                                                  for key, digest in section_keys.items()):
        return {}
    for name, digest in value.get("input_files", {}).items():
        if not isinstance(name, str) or not isinstance(digest, str):
            return {}
        source = Path(name)
        try:
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                return {}
        except OSError:
            return {}
    return value


def ledger_path(transcript: Path) -> Path:
    """Keep editorial evidence beside the transcript's staged-part metadata."""
    return transcript.parent.parent / ".transcriber-cache/staged-drafts" / transcript.name / "emphasis.json"


def bounded_prompt(prompt: str, budget: int) -> str:
    """Refuse a request that cannot be split further, preserving all evidence for retry."""
    if len(prompt) > budget:
        raise ValueError(f"ASSESSMENT_SECTION_FAILED: one indivisible request needs {len(prompt)} characters, "
                         f"over emphasis_prompt_chars={budget}. No evidence was truncated.")
    return prompt


def _segments(text: str, budget: int) -> list[tuple[int, str]]:
    # Overlap one complete preceding segment in the extraction prompt below, so
    # an emphasis cue and its explanation can straddle any partition.
    return [(start, text[start:start + budget]) for start in range(0, len(text), budget)]


def build_ledger(sources: tuple[str, ...], texts: list[str], path: Path, config: dict[str, Any],
                 *, model: str = agy_writer.DEFAULT_MODEL, timeout: int = agy_writer.DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Extract segments concurrently, checkpoint responses, and drop unquoted claims.

    Failures leave completed segments reusable. No partial ledger is marked complete.
    Character spans index the original recording's verbatim, not a shortened guide.
    """
    segment_chars, prompt_chars = limits(config)
    if len(sources) != len(texts) or not sources or any(not text.strip() for text in texts):
        raise ValueError("Emphasis requires every ordered recording's complete verbatim")
    digest = fingerprint(sources, texts, config)
    cached = read_ledger(path)
    ledger: dict[str, Any] = cached if cached.get("fingerprint") == digest else {
        "version": PROMPT_VERSION, "fingerprint": digest, "segments": {}, "points": [], "question_points": {}, "complete": False,
    }
    if ledger.get("complete"):
        return ledger
    lock = Lock()
    tasks = [(recording, text, start, segment) for recording, text in zip(sources, texts)
             for start, segment in _segments(text, segment_chars)]
    resolved: dict[str, tuple[list[dict[str, Any]], list[dict[str, Any]]]] = {}

    def extract(recording: str, text: str, start: int, segment: str) -> None:
        cancellation.check_cancelled()
        key = f"{recording}:{start}"
        previous = text[max(0, start - segment_chars):start]
        prompt = (agy_writer.NO_TOOLS_RULE + "\nExtract EVERY explicitly emphasized medical point from this doctor's speech. "
                  "Use key_points for stressed medical facts (repetition, important/focus cues, slowing down, board writing or returning to them); "
                  "class_questions for EVERY question about the lecture's medical content, with the accepted doctor/student answer or later verbatim explanation as answer_quote. "
                  "Retain medical questions even when no answer is spoken; omit answer_quote so a best answer can be generated and explicitly labelled as not stated. "
                  "Never include unrelated class questions such as who brought the cable. Return related_to_lecture=true for medical class questions. "
                  "warnings for medical warnings, traps and dangerous mistakes (severity lethal for lethal mistakes, otherwise warning); "
                  "course_instructions for exam scope, past-paper repetition, study files, grading, attendance marks or promised revision lectures; "
                  "exam_flagged only for explicit will/may-come exam cues, with cue quote and expected answer_quote. "
                  "Exclude classroom management, chatter, latecomers, equipment trouble, attendance without a marks rule, greetings and thanks. "
                  "Exclude jokes unless they teach a medical fact; extract the fact, not the joke. Never invent spoken evidence. "
                  "Ordinary explanation alone does not establish emphasis. "
                  "Never infer importance from slides, exam frequency or your medical knowledge. "
                  "Return points with exact quote and emphasis_quote from the speech, a concise explanation in Egyptian colloquial Arabic with English medical terms, and category "
                  + ", ".join(CATEGORIES) + ". Return an empty points array when none is emphasized. "
                  "The preceding context resolves split statements; include only points whose quote or emphasis cue touches the current segment.\n"
                  f"RECORDING: {recording}\nPRECEDING CONTEXT:\n{previous}\nSPOKEN SEGMENT:\n{segment}")
        payload = ledger["segments"].get(key)
        if payload is None:
            payload = agy_writer.request_json(bounded_prompt(prompt, prompt_chars), POINT_SCHEMA, timeout=timeout, model=model)
        if not isinstance(payload, dict) or not isinstance(payload.get("points"), list):
            raise ValueError("Emphasis response requires points")
        accepted: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        window = previous + segment
        base = start - len(previous)
        source_hash = hashlib.sha256(text.encode()).hexdigest()
        for item in payload["points"]:
            try:
                if (not isinstance(item, dict) or any(not isinstance(item.get(field), str) or not item[field].strip()
                    for field in ("quote", "emphasis_quote", "explanation", "category"))
                    or item["category"] not in CATEGORIES):
                    raise ValueError("Invalid emphasis point fields/category")
                if "related_to_lecture" in item and type(item["related_to_lecture"]) is not bool:
                    raise ValueError("Invalid related_to_lecture field")
                if item["category"] == "class_questions" and item.get("related_to_lecture") is False:
                    raise ValueError("Classroom question unrelated to lecture medical content")
                if "severity" in item and item["severity"] not in ("warning", "lethal", ""):
                    raise ValueError("Invalid emphasis severity")
                point = dict(item)
                for field, prefix in (("quote", ""), ("emphasis_quote", "emphasis_"), ("answer_quote", "answer_")):
                    if field == "answer_quote" and (field not in item or item[field] == ""):
                        continue
                    quote = item.get(field)
                    match = (re.search(r"\s+".join(re.escape(word) for word in quote.split()), window)
                             if isinstance(quote, str) and quote.strip() else None)
                    if match is None:
                        if field == "answer_quote" and item["category"] == "class_questions":
                            rejected.append({"raw": item, "reason": "Unlocated answer_quote; medical class question retained for answering"})
                            point.pop("answer_quote", None)
                            continue
                        raise ValueError(f"{field} must occur in its spoken segment/context")
                    point[field] = match.group()
                    point[prefix + "start"], point[prefix + "end"] = base + match.start(), base + match.end()
                point.update(id=hashlib.sha256(f"{recording}:{source_hash}:{point['start']}:{point['quote']}".encode()).hexdigest(),
                             recording=recording, source_fingerprint=source_hash)
                accepted.append(point)
            except ValueError as error:
                rejected.append({"raw": item, "reason": str(error), "recording": recording, "segment_start": start})
        with lock:
            ledger["segments"][key] = payload
            resolved[key] = accepted, rejected
            points_by_id: dict[str, dict[str, Any]] = {}
            rejected_points = []
            for name, _text, offset, _segment in tasks:
                points, rejects = resolved.get(f"{name}:{offset}", ([], []))
                for point in points:
                    points_by_id.setdefault(point["id"], point)
                rejected_points.extend(rejects)
            ledger.update(points=sorted(points_by_id.values(), key=lambda point: (sources.index(point["recording"]), point["start"])),
                          rejected_points=rejected_points)
            _atomic_write_json(path, ledger)

    with ThreadPoolExecutor(max_workers=agy_writer.writer_workers(config)) as pool:
        futures = [pool.submit(copy_context().run, extract, recording, text, start, segment)
                   for recording, text, start, segment in tasks]
        for future in futures:
            future.result()
    _resolve_spoken_answers(ledger, sources, texts, path, config, model=model, timeout=timeout)
    ledger.update(complete=True)
    _atomic_write_json(path, ledger)
    return ledger


def _resolve_spoken_answers(ledger: dict[str, Any], sources: tuple[str, ...], texts: list[str], path: Path,
                            config: dict[str, Any], *, model: str, timeout: int) -> None:
    """Ground deferred class/exam answers in later verbatim explanations only."""
    from lecture_answers import select_evidence

    retained = []
    for point in ledger["points"]:
        if point["category"] not in {"class_questions", "exam_flagged"} or point.get("answer_quote"):
            if point.get("answer_quote"):
                point.update(answer=point["answer_quote"], answer_source="lecture")
            retained.append(point)
            continue
        cancellation.check_cancelled()
        key = point["id"]
        answers = ledger.setdefault("deferred_answers", {})
        if key not in answers:
            prefix = (agy_writer.NO_TOOLS_RULE + "\nResolve the doctor's class question or exam-flagged point from later spoken explanation. "
                      "Use only these verbatim passages, including an accepted student answer. Return answer_quote as an exact "
                      "supporting answer sentence, or an empty string if the lecture supplies none. "
                      "Also return answer with a concise best medical answer, and related_to_lecture indicating whether this is about the lecture's medical content. "
                      "Exclude unrelated classroom questions such as who brought the cable. Never attribute a best answer to the doctor without a supporting quote.\nPOINT:\n"
                      + json.dumps(point, ensure_ascii=False) + "\nVERBATIM ANSWER EVIDENCE:\n")
            budget = limits(config)[1]
            bounded_prompt(prefix, budget)
            evidence = select_evidence({"entries": [{"stem": point["quote"]}]}, list(zip(sources, texts)), config, budget - len(prefix))
            response = agy_writer.request_json(bounded_prompt(prefix + json.dumps(evidence, ensure_ascii=False), budget),
                {"type": "object", "properties": {"answer_quote": {"type": "string"}, "answer": {"type": "string"}, "related_to_lecture": {"type": "boolean"}}, "required": ["answer_quote", "answer", "related_to_lecture"]},
                model=model, timeout=timeout)
            if not isinstance(response, dict) or not isinstance(response.get("answer_quote"), str):
                raise ValueError("Deferred spoken answer response requires answer_quote")
            answers[key] = response
            _atomic_write_json(path, ledger)
        response = answers[key]
        if (not isinstance(response, dict) or not isinstance(response.get("answer_quote"), str)
            or ("related_to_lecture" in response and type(response["related_to_lecture"]) is not bool)):
            raise ValueError("Invalid deferred spoken answer response")
        quote = response["answer_quote"]
        if response.get("related_to_lecture") is False:
            ledger.setdefault("rejected_points", []).append({"raw": point, "reason": "Classroom question unrelated to lecture medical content"})
            continue
        located = False
        if quote.strip():
            pattern = r"\s+".join(re.escape(word) for word in quote.split())
            for recording, text in zip(sources, texts):
                match = re.search(pattern, text)
                if match:
                    point.update(answer=match.group(), answer_source="lecture", answer_quote=match.group(), answer_recording=recording,
                                 answer_start=match.start(), answer_end=match.end())
                    retained.append(point)
                    located = True
                    break
        if not located:
            if point["category"] == "class_questions":
                answer = response.get("answer")
                if not isinstance(answer, str) or not answer.strip():
                    raise ValueError("Unanswered medical class question requires a best answer")
                point.update(answer=answer, answer_quote="", answer_source="not stated in the lecture")
                retained.append(point)
                if quote:
                    ledger.setdefault("rejected_points", []).append({"raw": response, "reason": "Unlocated class answer quote; best answer retained with absence marker"})
            else:
                ledger.setdefault("rejected_points", []).append({"raw": point, "reason": "No verbatim-supported answer_quote"})
    ledger["points"] = retained


def question_is_emphasized(block: str, kind: str, ledger: dict[str, Any]) -> bool:
    """Accept only question receipts referring to an existing spoken point."""
    ids = {point["id"] for point in ledger.get("points", [])}
    return bool(ids.intersection(ledger.get("question_points", {}).get(retained_question_fingerprint(block, kind), [])))


class CoverageError(ValueError):
    """A valid semantic audit found assertions or coverage needing one rewrite.

    ``generated`` carries the found and required counts of generated IMP
    questions that test key points, warnings or exam-flagged points.
    """

    def __init__(self, section: set[str], unsupported: list[str], points: list[dict[str, Any]],
                 *, generated: tuple[int, int] | None = None):
        if unsupported:
            message = "Section 2 contains unsupported emphasis: " + str(unsupported)
        elif generated is not None:
            message = (f"Missing spoken emphasis coverage: {generated[0]} generated IMP questions test key points, "
                       f"warnings or exam-flagged points; at least {generated[1]} are required")
        else:
            message = f"Missing spoken emphasis coverage: Section 2={sorted(section)}"
        super().__init__(message)
        self.correction = "\nCORRECTIVE SPOKEN EMPHASIS AUDIT:\n" + json.dumps({
            "missing_section2_ids": sorted(section),
            "missing_points": compact_points([point for point in points if point["id"] in section]),
            "unsupported_section2": unsupported,
            **({"generated_imp_questions": {"found": generated[0], "required": generated[1]}} if generated else {}),
        }, ensure_ascii=False)


def compact_points(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep the ledger fields writers and audits use; offsets and extraction metadata stay on disk."""
    result = []
    for point in points:
        compact: dict[str, Any] = {key: point[key] for key in ("id", "category", "quote", "explanation", "answer_quote") if key in point}
        if point.get("answer") and not point.get("answer_quote"):
            compact["explanation"] += " Answer: " + point["answer"] + " (مش مذكورة في المحاضرة)"
        result.append(compact)
    return result


def _bounded_review(prompt: str, budget: int, model: str, timeout: int, *, workers: int = 1) -> dict[str, Any]:
    """Review bounded leaves concurrently and merge in recursive split order.

    One pool owns every leaf; merge callbacks never occupy workers. Copied
    request contexts carry cancellation and deadlines to every model call.
    A divisible leaf that times out is reviewed again as halves.
    """
    prefix, rest = prompt.split("SPOKEN EMPHASIS LEDGER:\n", 1)
    raw_points, rest = rest.split("\nSECTION 2:\n", 1)
    section, raw_blocks = rest.split("\nQUESTIONS BY FINGERPRINT:\n", 1)
    points, blocks = json.loads(raw_points), json.loads(raw_blocks)
    def request_review(request: str) -> dict[str, Any]:
        cancellation.check_cancelled()
        try:
            value = agy_writer.request_json(request, COVERAGE_SCHEMA, timeout=timeout, model=model)
        except agy_writer.AgyWriterError as error:
            if agy_writer.TIMED_OUT not in str(error) or not _divisible(request):
                raise
            return _bounded_review(request, len(request) - 1, model, timeout, workers=2)
        if not isinstance(value, dict) or any(not isinstance(value.get(key), list) for key in ("sections", "questions", "unsupported_section2")):
            raise ValueError("Invalid emphasis coverage arrays")
        return value

    def plan(points: list[Any], section: str, blocks: dict[str, str]) -> Callable[[], dict[str, Any]]:
        request = prefix + "SPOKEN EMPHASIS LEDGER:\n" + json.dumps(points, ensure_ascii=False) + "\nSECTION 2:\n" + section + "\nQUESTIONS BY FINGERPRINT:\n" + json.dumps(blocks, ensure_ascii=False)
        if len(request) <= budget:
            future = pool.submit(copy_context().run, request_review, request)
            return future.result
        if len(blocks) > 1:
            items = list(blocks.items())
            middle = len(items) // 2
            children = [plan(points, section, dict(items[:middle])), plan(points, section, dict(items[middle:]))]
        elif len(points) > 1:
            middle = len(points) // 2
            children = [plan(points[:middle], section, blocks), plan(points[middle:], section, blocks)]
        elif len(section.splitlines(keepends=True)) > 1:
            lines = section.splitlines(keepends=True)
            middle = len(lines) // 2
            children = [plan(points, "".join(lines[:middle]), blocks), plan(points, "".join(lines[middle:]), blocks)]
        else:
            bounded_prompt(request, budget)
            raise AssertionError("unreachable")
        def merge() -> dict[str, Any]:
            results = [child() for child in children]
            if len(blocks) <= 1 and len(points) > 1:
                # A claim is unsupported only if neither point batch supports it.
                shared = set(results[0]["unsupported_section2"]) & set(results[1]["unsupported_section2"])
                for value in results:
                    value["unsupported_section2"] = sorted(shared)
            return {key: [item for result in results for item in result[key]] for key in ("sections", "questions", "unsupported_section2")}
        return merge

    with ThreadPoolExecutor(max_workers=workers) as pool:
        result = plan(points, section, blocks)()
    merged: dict[str, set[str]] = {}
    for entry in result["questions"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("fingerprint"), str) or not isinstance(entry.get("point_ids"), list) or any(not isinstance(point, str) for point in entry["point_ids"]):
            raise ValueError("Invalid question emphasis coverage fingerprint/point")
        merged.setdefault(entry["fingerprint"], set()).update(entry["point_ids"])
    result["questions"] = [{"fingerprint": key, "point_ids": sorted(ids)} for key, ids in merged.items()]
    return result


def _divisible(request: str) -> bool:
    """Whether ``_bounded_review`` can split a coverage request into smaller requests."""
    _prefix, rest = request.split("SPOKEN EMPHASIS LEDGER:\n", 1)
    raw_points, rest = rest.split("\nSECTION 2:\n", 1)
    section, raw_blocks = rest.split("\nQUESTIONS BY FINGERPRINT:\n", 1)
    return len(json.loads(raw_blocks)) > 1 or len(json.loads(raw_points)) > 1 or len(section.splitlines()) > 1


def check_questions(draft: str, ledger: dict[str, Any], config: dict[str, Any],
                    *, model: str = agy_writer.DEFAULT_MODEL, timeout: int = agy_writer.DEFAULT_TIMEOUT_SECONDS, review_section: int | None = None,
                    workers: int | None = None) -> dict[str, Any]:
    """Independently match Section 2 and exact questions to quoted spoken points.

    ``review_section`` None reviews a whole draft and 0 reviews Section 2 alone;
    both require Section 2 coverage of every point. 1–3 review one of Sections
    3–5, which must hold ``_emphasis_minimum`` generated questions testing key
    points, warnings or exam-flagged points. Question matches grant importance
    independently of provenance. Oversized audits are split into bounded requests,
    at most ``workers`` (default ``lecture_writer_workers``) at once.
    """
    _segment_chars, budget = limits(config)
    if not isinstance(ledger.get("points"), list):
        raise ValueError("Spoken emphasis ledger is missing; regenerate questions evidence")
    sections = assessment_sections(draft)
    reviewed = range(4) if review_section is None else [review_section]
    entries = [(retained_question_fingerprint(block, kind), block)
               for index, kind in enumerate(("MCQ", "Question", "Clinical Case"), 1)
               if index in reviewed for block in _section_blocks(sections[index], kind)]
    blocks = dict(entries)
    generated_keys = {key for key, block in entries if not sourced_question(block)}
    section = sections[0] if review_section in (None, 0) else ""
    ids = {point["id"] for point in ledger["points"]}
    if ids or any(line.strip() and line.strip() not in IMP_EMPTY_NOTICES and not line.startswith(("#", "---")) for line in section.splitlines()):
        prompt = (agy_writer.NO_TOOLS_RULE + "\nIndependently audit spoken-emphasis coverage. Match medical meaning, not badges or shared topic words. "
                  "Return sections entries {point_id, quote} only for a Section 2 excerpt explaining that exact point. "
                  "Return questions entries {fingerprint, point_ids} only when the question actually tests that emphasized point. "
                  "Return unsupported_section2 containing every substantive Section 2 assertion lacking ledger support (ignore headings and explicit absence notices). "
                  "An unrelated frequent-exam or slide-only point gets no match. Never trust claimed IMP badges. "
                  "Check category grouping and lecture-time order within groups. Section 2 must not restate the whole guide. "
                  "Lethal warnings require CAUTION; other warnings require WARNING. EVERY medical class question must have an answer: "
                  "prefer the accepted or later verbatim-supported answer with a short supporting quote. "
                  "When answer_source is not stated in the lecture, require the best answer and the exact marker (مش مذكورة في المحاضرة); "
                  "that labelled fallback is supported by the class-question ledger item and must not be called unsupported merely because its answer is not spoken. "
                  "exam-flagged items require cue and expected answer. Classroom management and chatter are unsupported. "
                  "Displayed quotes may lightly repair ASR garbling: match ledger IDs and meaning, not quote spelling. "
                  "Include every supported point; do not invent IDs.\nSPOKEN EMPHASIS LEDGER:\n"
                  + json.dumps(compact_points(ledger["points"]), ensure_ascii=False) + "\nSECTION 2:\n" + section
                  + "\nQUESTIONS BY FINGERPRINT:\n" + json.dumps(blocks, ensure_ascii=False))
        result = _bounded_review(prompt, budget, model, timeout, workers=workers or agy_writer.writer_workers(config))
    else:
        result = {"sections": [], "questions": [], "unsupported_section2": []}
    if not isinstance(result, dict) or any(not isinstance(result.get(field), list) for field in ("sections", "questions", "unsupported_section2")):
        raise ValueError("Invalid emphasis coverage arrays")
    if any(not isinstance(assertion, str) for assertion in result["unsupported_section2"]):
        raise ValueError("Invalid unsupported Section 2 coverage assertions")
    section_ids = set()
    mapping = {}
    for entry in result["sections"]:
        if (not isinstance(entry, dict) or not isinstance(entry.get("point_id"), str)
            or entry["point_id"] not in ids or not isinstance(entry.get("quote"), str)
            or not entry["quote"].strip() or entry["quote"] not in section):
            raise ValueError("Invalid Section 2 emphasis coverage quote/point")
        section_ids.add(entry["point_id"])
    for entry in result["questions"]:
        if (not isinstance(entry, dict) or not isinstance(entry.get("fingerprint"), str)
            or entry["fingerprint"] not in blocks or not isinstance(entry.get("point_ids"), list)
            or any(not isinstance(point, str) or point not in ids for point in entry["point_ids"])):
            raise ValueError("Invalid question emphasis coverage fingerprint/point")
        mapping[entry["fingerprint"]] = entry["point_ids"]
    reviews_section2 = review_section in (None, 0)
    unsupported = result["unsupported_section2"] + (imp_structure_errors(section) if reviews_section2 else [])
    missing = ids - section_ids if reviews_section2 else set()
    if missing or unsupported:
        raise CoverageError(missing, unsupported, ledger["points"])
    if not reviews_section2:
        from question_prompts import _emphasis_minimum

        eligible = {point["id"] for point in ledger["points"] if point["category"] in GENERATED_CATEGORIES}
        found = sum(bool(eligible.intersection(mapping.get(key, []))) for key in generated_keys)
        if found < _emphasis_minimum(len(eligible)):
            raise CoverageError(set(), [], ledger["points"], generated=(found, _emphasis_minimum(len(eligible))))
    keys = section_coverage_keys(draft)
    return {**ledger, "question_points": mapping, "section_points": sorted(section_ids), "generated_questions": sorted(generated_keys), "coverage_key": coverage_key(draft),
            "section_coverage_keys": {**ledger.get("section_coverage_keys", {}),
                                      **{str(index): keys[str(index)] for index in reviewed}}}


def assessment_sections(draft: str) -> list[str]:
    """Locate assessment bodies by section icon, excluding guide quiz headings."""
    matches = list(re.finditer(r"(?m)^## ([^\n]+)$", draft))
    sections = [""] * 4
    icons = [heading.split()[1] for heading in SECTION_HEADINGS[1:]]
    for offset, match in enumerate(matches):
        icon = match[1].split()[0] if match[1].split() else ""
        if icon in icons:
            end = matches[offset + 1].start() if offset + 1 < len(matches) else len(draft)
            sections[icons.index(icon)] += draft[match.end():end]
    return sections


def section_coverage_keys(draft: str) -> dict[str, str]:
    """Bind Section 2 text and each section's question identities independently."""
    sections = assessment_sections(draft)
    section = re.sub(r"(?m)^\s*---+\s*$", "", sections[0])
    identities = [re.sub(r"\s+", " ", section).strip()]
    identities.extend(json.dumps(sorted({retained_question_fingerprint(block, kind)
                      for block in _section_blocks(sections[index], kind)}))
                      for index, kind in enumerate(("MCQ", "Question", "Clinical Case"), 1))
    return {str(index): hashlib.sha256(identity.encode()).hexdigest() for index, identity in enumerate(identities)}


def coverage_key(draft: str) -> str:
    """Bind coverage to assessment content, excluding provenance, numbering and guide quizzes."""
    return hashlib.sha256(json.dumps(section_coverage_keys(draft), sort_keys=True).encode()).hexdigest()


def legacy_coverage_key(draft: str) -> str:
    """Return the whole-draft key that ledgers saved before per-section keys recorded."""
    section = draft.split("## 🌟 IMP Points", 1)[-1].split("## ❓ MCQs", 1)[0]
    section = re.sub(r"(?m)^\s*---+\s*$", "", section)
    section = re.sub(r"\s+", " ", section).strip()
    questions = sorted(retained_question_fingerprint(block, kind)
                       for kind in ("MCQ", "Question", "Clinical Case") for block in _section_blocks(draft, kind))
    return hashlib.sha256(json.dumps([section, questions], ensure_ascii=False).encode()).hexdigest()


def stale_sections(draft: str, ledger: dict[str, Any]) -> list[int]:
    """Return only sections whose reviewed text or question identities changed.

    A ledger without per-section keys is current when its whole-draft key
    matches ``legacy_coverage_key``.
    """
    if ledger.get("coverage_key") == coverage_key(draft):
        return []
    saved = ledger.get("section_coverage_keys", {})
    if not saved and ledger.get("coverage_key") == legacy_coverage_key(draft):
        return []
    return [int(index) for index, key in section_coverage_keys(draft).items() if saved.get(index) != key]


def refresh_coverage(draft: str, ledger: dict[str, Any], config: dict[str, Any],
                     *, model: str, timeout: int, save: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
    """Review changed sections concurrently and retain evidence for unchanged sections.

    At most ``lecture_writer_workers`` agy requests run at once. ``save``
    receives the ledger after each reviewed section, so a failed section leaves
    the other sections' reviews saved; the first failure is raised after every
    section settles. Unchanged sections record their current keys.
    """
    sections = assessment_sections(draft)
    stale = stale_sections(draft, ledger)
    current = section_coverage_keys(draft)
    ledger = {**ledger, "section_coverage_keys": {**ledger.get("section_coverage_keys", {}),
                                                  **{index: key for index, key in current.items() if int(index) not in stale}}}
    total = agy_writer.writer_workers(config)
    lock = Lock()

    def review(index: int) -> None:
        nonlocal ledger
        checked = check_questions(SECTION_HEADINGS[index + 1] + "\n" + sections[index], ledger, config, model=model,
                                  timeout=timeout, review_section=index, workers=max(1, total // max(1, len(stale))))
        with lock:
            ledger = {**ledger, "question_points": {**ledger.get("question_points", {}), **checked["question_points"]},
                      "section_coverage_keys": {**ledger["section_coverage_keys"], str(index): current[str(index)]},
                      **({"section_points": checked["section_points"]} if index == 0 else {})}
            if save is not None:
                save(ledger)

    if stale:
        with ThreadPoolExecutor(max_workers=min(total, len(stale))) as pool:
            futures = [pool.submit(copy_context().run, review, index) for index in stale]
        errors = [future.exception() for future in futures if future.exception() is not None]
        if errors:
            raise errors[0]
    generated = sorted({retained_question_fingerprint(block, kind)
                        for index, kind in enumerate(("MCQ", "Question", "Clinical Case"), 1)
                        for block in _section_blocks(sections[index], kind) if not sourced_question(block)})
    return {**ledger, "coverage_key": coverage_key(draft), "generated_questions": generated}


def inherit_coverage(reviewed: str, derived: str, ledger: dict[str, Any]) -> dict[str, Any]:
    """Extend current coverage of ``reviewed`` to ``derived``.

    ``derived`` must come from ``reviewed`` only by removing duplicate questions
    and renumbering; each kept question retains its reviewed fingerprint.
    """
    current = set(range(4)) - set(stale_sections(reviewed, ledger))
    keys = section_coverage_keys(derived)
    ledger = {**ledger, "section_coverage_keys": {**ledger.get("section_coverage_keys", {}),
                                                  **{str(index): keys[str(index)] for index in current}}}
    return {**ledger, "coverage_key": coverage_key(derived)} if len(current) == 4 else ledger


def validation_errors(draft: str, ledger: dict[str, Any], *, reviewed_draft: str | None = None) -> list[str]:
    """Refuse stale coverage receipts or importance unsupported by reviewed speech.

    ``reviewed_draft`` is the saved draft that ``draft`` was derived from only by
    removing duplicate questions and renumbering; its coverage covers ``draft``.
    """
    if not ledger:
        return []
    if not ledger.get("complete"):
        return ["[stale_emphasis_coverage]: regenerate questions from current spoken evidence"]
    errors = []
    if stale_sections(draft if reviewed_draft is None else reviewed_draft, ledger):
        errors.append("[stale_emphasis_coverage]: Section 2/questions require spoken-evidence review")
    sections = assessment_sections(draft)
    for index, kind in enumerate(("MCQ", "Question", "Clinical Case"), 1):
        for block in _section_blocks(sections[index], kind):
            important = "**[IMP]**" in block or "/ IMP]**" in block
            if important != question_is_emphasized(block, kind, ledger):
                errors.append(f"{block.splitlines()[0]} [unsupported_imp]: IMP must agree with spoken evidence")
    return errors


def saved_ledger(transcript: Path) -> dict[str, Any]:
    """Distinguish a legacy draft from an invalidated evidence cache."""
    path = ledger_path(transcript)
    return read_ledger(path) or ({"stale": True} if path.is_file() else {})


def sourced_question(block: str) -> bool:
    """Keep generated and sourced copies distinct even when both earn IMP."""
    heading = block.splitlines()[0] if block else ""
    return any(badge in heading for badge in ("Past Exams", "Question Bank")) or bool(re.search(r"(?m)^\s*\*\*Source:\*\*", block))


def refresh_saved_coverage(draft: str, transcript: Path, config: dict[str, Any],
                           *, model: str = agy_writer.DEFAULT_MODEL, timeout: int = agy_writer.DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Recheck repaired question content before publishing, preserving required emphasis."""
    ledger = saved_ledger(transcript)
    if ledger.get("complete") and ledger.get("coverage_key") != coverage_key(draft):
        ledger = refresh_coverage(draft, ledger, config, model=model, timeout=timeout,
                                  save=lambda reviewed: _atomic_write_json(ledger_path(transcript), reviewed))
        _atomic_write_json(ledger_path(transcript), ledger)
    return ledger
