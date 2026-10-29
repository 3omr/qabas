"""Persist quoted spoken emphasis and independently checked assessment coverage.

Only ordered verbatims enter extraction. Question receipts bind semantic review
against that evidence to exact wording/options; Markdown badges grant no receipt.
"""

from __future__ import annotations

import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path
from threading import Lock
from typing import Any

import agy_writer
import cancellation
from atomic_io import _atomic_write_json
from phase_validation import (
    _section_blocks,
    imp_structure_errors,
    retained_question_fingerprint,
)
from question_prompts import IMP_EMPTY_NOTICES

PROMPT_VERSION = "spoken-emphasis-4"
CATEGORIES = ("key_points", "class_questions", "warnings", "course_instructions", "exam_flagged")
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

    return hashlib.sha256(json.dumps([PROMPT_VERSION, limits(config), evidence_limit(config), list(zip(sources, texts))], ensure_ascii=False).encode()).hexdigest()


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
    """Refuse oversized prompts explicitly, preserving all evidence for retry."""
    if len(prompt) > budget:
        raise ValueError(f"Emphasis prompt has {len(prompt)} characters, exceeding emphasis_prompt_chars={budget}; increase that configured budget. No evidence was truncated.")
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
    """A valid semantic audit found assertions or coverage needing one rewrite."""

    def __init__(self, section: set[str], questions: set[str], unsupported: list[str], points: list[dict[str, Any]]):
        message = ("Section 2 contains unsupported emphasis: " + str(unsupported) if unsupported else
                   f"Missing spoken emphasis coverage: Section 2={sorted(section)}, generated questions={sorted(questions)}")
        super().__init__(message)
        self.correction = "\nCORRECTIVE SPOKEN EMPHASIS AUDIT:\n" + json.dumps({
            "missing_section2_ids": sorted(section), "missing_generated_question_ids": sorted(questions),
            "missing_points": [point for point in points if point["id"] in section | questions],
            "unsupported_section2": unsupported,
        }, ensure_ascii=False)


def check_questions(draft: str, ledger: dict[str, Any], config: dict[str, Any],
                    *, model: str = agy_writer.DEFAULT_MODEL, timeout: int = agy_writer.DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Independently match Section 2 and exact questions to quoted spoken points.

    Every point requires Section 2 coverage and a generated, unsourced question;
    a matching past exam earns importance independently and cannot replace it.
    """
    _segment_chars, budget = limits(config)
    if not isinstance(ledger.get("points"), list):
        raise ValueError("Spoken emphasis ledger is missing; regenerate questions evidence")
    entries = [(retained_question_fingerprint(block, kind), block)
               for kind in ("MCQ", "Question", "Clinical Case") for block in _section_blocks(draft, kind)]
    blocks = dict(entries)
    generated_keys = {key for key, block in entries if not sourced_question(block)}
    section = draft.split("## 🌟 IMP Points", 1)[-1].split("## ❓ MCQs", 1)[0]
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
                  + json.dumps(ledger["points"], ensure_ascii=False) + "\nSECTION 2:\n" + section
                  + "\nQUESTIONS BY FINGERPRINT:\n" + json.dumps(blocks, ensure_ascii=False))
        result = agy_writer.request_json(bounded_prompt(prompt, budget), COVERAGE_SCHEMA, timeout=timeout, model=model)
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
    generated_ids = {point for key, matched in mapping.items() for point in matched
                     if key in generated_keys}
    unsupported = result["unsupported_section2"] + imp_structure_errors(section)
    if ids - section_ids or ids - generated_ids or unsupported:
        raise CoverageError(ids - section_ids, ids - generated_ids, unsupported, ledger["points"])
    return {**ledger, "question_points": mapping, "section_points": sorted(section_ids), "generated_questions": sorted(generated_keys), "coverage_key": coverage_key(draft)}


def coverage_key(draft: str) -> str:
    """Bind semantic review to Section 2 text and question identities, excluding badges."""
    section = draft.split("## 🌟 IMP Points", 1)[-1].split("## ❓ MCQs", 1)[0]
    section = re.sub(r"(?m)^\s*---+\s*$", "", section)
    section = re.sub(r"\s+", " ", section).strip()
    questions = sorted(retained_question_fingerprint(block, kind)
                       for kind in ("MCQ", "Question", "Clinical Case") for block in _section_blocks(draft, kind))
    return hashlib.sha256(json.dumps([section, questions], ensure_ascii=False).encode()).hexdigest()


def validation_errors(draft: str, ledger: dict[str, Any]) -> list[str]:
    """Refuse stale coverage receipts or importance unsupported by reviewed speech."""
    if not ledger:
        return []
    if not ledger.get("complete"):
        return ["[stale_emphasis_coverage]: regenerate questions from current spoken evidence"]
    errors = []
    if ledger.get("coverage_key") != coverage_key(draft):
        errors.append("[stale_emphasis_coverage]: Section 2/questions require spoken-evidence review")
    for kind in ("MCQ", "Question", "Clinical Case"):
        for block in _section_blocks(draft, kind):
            important = "**[IMP]**" in block or "/ IMP]**" in block
            if important != question_is_emphasized(block, kind, ledger):
                errors.append(f"{block.splitlines()[0]} [unsupported_imp]: IMP must agree with spoken evidence")
    covered = {point for kind in ("MCQ", "Question", "Clinical Case") for block in _section_blocks(draft, kind)
               if not sourced_question(block) and retained_question_fingerprint(block, kind) in ledger.get("generated_questions", [])
               for point in ledger.get("question_points", {}).get(retained_question_fingerprint(block, kind), [])}
    if {point["id"] for point in ledger["points"]} - covered:
        errors.append("[missing_emphasis_coverage]: every spoken point requires a generated question")
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
        ledger = check_questions(draft, ledger, config, model=model, timeout=timeout)
        _atomic_write_json(ledger_path(transcript), ledger)
    return ledger
