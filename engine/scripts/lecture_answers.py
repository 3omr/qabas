"""Select lecture passages and preserve printed keys at transcription time."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

from lecture_questions import STOP_WORDS
from phase_validation import (
    _field_content,
    _option_entries,
    _question_content,
    _section_blocks,
)
from provenance_audit import ocr_stem_matches
from transcript_contract import repair_answer_sources
from transcript_parser import FIELD_NAME_PATTERN


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold())


def evidence_limit(config: dict[str, Any]) -> int:
    """Resolve the validated per-question passage character cap."""
    value = config.get("answer_evidence_chars", 2000)
    if type(value) is not int or value <= 0:
        raise ValueError("answer_evidence_chars must be a positive integer")
    return value


def needs_lecture_answer(entry: dict[str, Any]) -> bool:
    """Uncertain or absent paper keys require lecture evidence, never an index edit."""
    return entry.get("answer_status") != "printed"


def select_evidence(questions: dict[str, Any], sources: list[tuple[str, str]], config: dict[str, Any],
                    budget: int) -> dict[str, Any]:
    """Rank complete bounded passages by stem/options overlap; report all omissions.

    Keys are the one-based FIND_QUESTIONS entry numbers, independent of output
    section numbering. JSON metadata and quotes both count toward the budget.
    """
    cap = evidence_limit(config)
    entries = [(number, entry) for number, entry in enumerate(questions.get("entries", []), 1) if needs_lecture_answer(entry)]
    passages: list[dict[str, Any]] = []
    for source, text in sources:
        for paragraph in re.finditer(r"\S[\s\S]*?(?=\n\s*\n|\Z)", text):
            overhead = len(json.dumps({"source": source, "start": len(text), "end": len(text), "text": ""}, ensure_ascii=False)) + 2
            width = cap - overhead if cap > overhead else paragraph.end() - paragraph.start()
            for offset in range(paragraph.start(), paragraph.end(), width):
                end = min(offset + width, paragraph.end())
                passages.append({"source": source, "start": offset, "end": end, "text": text[offset:end]})
    result: dict[str, Any] = {}
    for number, entry in entries:
        words = set(_tokens(" ".join([entry["stem"], *entry.get("options", {}).values()]))) - STOP_WORDS
        ranked = sorted(enumerate(passages), key=lambda item: (-len(words.intersection(_tokens(item[1]["text"]))), item[0]))
        relevant = [passage for _, passage in ranked if words.intersection(_tokens(passage["text"]))]
        result[str(number)] = {"question_id": entry.get("id"), "passages": [], "omitted_passages": len(relevant)}
    if len(json.dumps(result, ensure_ascii=False)) > budget:
        raise ValueError("ANSWER EVIDENCE metadata exceeds emphasis_prompt_chars; increase the configured budget. No evidence was truncated.")
    # Fair allocation includes serialized field overhead; unused allocation is not
    # reassigned, keeping selection independent of preceding question lengths.
    allocation = max(0, (budget - len(json.dumps(result, ensure_ascii=False))) // max(1, len(entries)))
    for number, entry in entries:
        words = set(_tokens(" ".join([entry["stem"], *entry.get("options", {}).values()]))) - STOP_WORDS
        ranked = sorted(enumerate(passages), key=lambda item: (-len(words.intersection(_tokens(item[1]["text"]))), item[0]))
        selected, used = [], 0
        for _, passage in ranked:
            size = len(json.dumps(passage, ensure_ascii=False)) + 2
            if words.intersection(_tokens(passage["text"])) and used + size <= min(cap, allocation):
                selected.append(passage)
                used += size
        result[str(number)]["passages"] = selected
        result[str(number)]["omitted_passages"] -= len(selected)
    return result


def _set_field(block: str, field: str, value: str) -> str:
    pattern = rf"(?ms)^(?P<prefix>[ \t]*(?:>[ \t]*)?)\*\*{re.escape(field)}:\*\*[^\S\n]*.*?(?=^\s*(?:>[ \t]*)?\*\*(?:{FIELD_NAME_PATTERN}):\*\*|^###? |^---|\Z)"
    replacement = f"**{field}:** {value}\n"
    return re.sub(pattern, lambda match: match["prefix"] + replacement, block, count=1) if re.search(pattern, block) else block.rstrip() + "\n" + replacement


def prepare_answers(text: str, entries: list[dict[str, Any]], evidence: list[str]) -> str:
    """Restore printed answers and require explicit sourcing for remaining answers."""
    for kind in ("MCQ", "Question", "Clinical Case"):
        for block in _section_blocks(text, kind):
            if not ("Past Exams" in block.splitlines()[0] or "Question Bank" in block.splitlines()[0] or "**Source:**" in block):
                continue
            stem = _field_content(block, "Scenario") if kind == "Clinical Case" else _question_content(block)
            entry = next((entry for entry in entries if (_tokens(stem) and _tokens(entry["stem"]) == _tokens(stem)) or ocr_stem_matches(stem, entry["stem"])), None)
            if entry is None:
                continue
            revised = block
            if not needs_lecture_answer(entry):
                answer = entry.get("answer") or entry.get("source_answer")
                if kind != "MCQ" and entry.get("model_answer"):
                    answer = "\n" + "\n".join("- " + item for item in entry["model_answer"])
                if answer:
                    if kind == "MCQ":
                        options = _option_entries(_field_content(block, "Options"))
                        answer = f"{answer}. {options[answer]}" if answer in options else answer
                    revised = _set_field(revised, "Correct Answer" if kind == "MCQ" else "Model Answer", answer)
                revised = re.sub(rf"(?ms)^[ \t]*(?:>[ \t]*)?\*\*Answer (?:source|quote):\*\*.*?(?=^\s*(?:>[ \t]*)?\*\*(?:{FIELD_NAME_PATTERN}):\*\*|^###? |^---|\Z)", "", revised)
            elif not _field_content(block, "Answer source"):
                revised = _set_field(revised, "Answer source", "not stated in the lecture")
            text = text.replace(block, revised, 1)
    return repair_answer_sources(text, evidence)
