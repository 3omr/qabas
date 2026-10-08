"""Deterministic Agy-shaped indexes for MCP tests without model access."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from unittest.mock import patch

from agy_exam_index import build_index
from exam_index import IndexedQuestion, parse_source
from exam_preparation import exam_source_files
from module_registry import load_module


def _source_evidence(prompt: str) -> tuple[str, list[dict[str, Any]], set[str]]:
    source_name = prompt.split("Source file: ", 1)[1].splitlines()[0]
    encoded = prompt.rsplit("Evidence units: ", 1)[1]
    units = json.loads(encoded)
    core_ids = {unit["id"] for unit in units if unit["coverage"] == "required"}
    return source_name, units, core_ids


def _question_range(question: IndexedQuestion, units: list[dict[str, Any]], start: int) -> tuple[int, int] | None:
    for index in range(start, len(units)):
        text = units[index]["text"]
        number = re.match(r"^\s*(\d{1,3})\s*[.)\-]\s*", text)
        if number is not None and int(number.group(1)) == question.number:
            end = next((
                offset for offset in range(index + 1, len(units))
                if re.match(r"^\s*\d{1,3}\s*[.)\-]\s*", units[offset]["text"])
            ), len(units))
            return index, end
    return None


def _answer_evidence(
    answer: str | None, number: int, units: list[dict[str, Any]],
) -> tuple[str | None, list[str]]:
    if answer is None:
        return None, []
    marker = re.compile(rf"^\s*(?:[+<#=*✓✔]\s*|\(\s*{re.escape(answer)}\s*\))", re.IGNORECASE)
    guide = re.compile(rf"\b(?:answer|correct)\b.*\b{re.escape(answer)}\b|\b{number}\s*[|:]\s*{re.escape(answer)}\b", re.IGNORECASE)
    match = next((unit for unit in units if marker.search(unit["text"]) or guide.search(unit["text"])), None)
    return (match["text"], [match["id"]]) if match is not None else (None, [])


def _proposal_question(
    question: IndexedQuestion, units: list[dict[str, Any]], core_ids: set[str], cursor: int,
) -> tuple[dict[str, Any] | None, int]:
    bounds = _question_range(question, units, cursor)
    if bounds is None:
        return None, cursor
    start, end = bounds
    unit_ids = [unit["id"] for unit in units[start:end]]
    if not unit_ids or unit_ids[0] not in core_ids:
        return None, end
    answer_evidence, answer_ids = _answer_evidence(question.answer, question.number, units,)
    answer = question.answer if answer_evidence is not None else None
    section = question.occurrences[0].section if question.occurrences else None
    year = question.occurrences[0].year if question.occurrences else None
    section_unit = next((
        unit for unit in units[:start]
        if section and section.casefold() in unit["text"].casefold()
    ), None)
    year_unit = next((unit for unit in units if year and str(year) in unit["text"]), None)
    for evidence_unit in (section_unit, year_unit):
        if evidence_unit is not None and evidence_unit["id"] not in unit_ids:
            unit_ids.append(evidence_unit["id"])
    year_evidence = year_unit["text"] if year_unit is not None else str(year) if year else None
    return {
        "unit_ids": unit_ids, "number": question.number, "kind": question.kind,
        "stem": question.stem, "options": [{"label": key, "text": value} for key, value in question.options.items()],
        "correct_option": answer, "answer_text": question.options.get(answer) if answer else None,
        "answer_evidence": answer_evidence if answer else None,
        "answer_unit_ids": answer_ids if answer else [],
        "explanation": question.model_answer or None,
        "explanation_unit_ids": unit_ids if question.model_answer else [],
        "section": section or None, "year": year, "year_evidence": year_evidence,
        "topic": None, "needs_review": not question.legible,
        "review_reason": "The source wording is difficult to read." if not question.legible else None,
    }, end


def _proposal(sources: dict[str, Path]):
    def answer(prompt: str, _schema: dict[str, Any], **_options: Any) -> dict[str, Any]:
        source_name, units, core_ids = _source_evidence(prompt)
        source = sources[source_name]
        questions = parse_source(source_name, source.read_text(encoding="utf-8", errors="replace"))
        results = []
        cursor = 0
        for question in questions:
            item, cursor = _proposal_question(question, units, core_ids, cursor)
            if item is not None:
                results.append(item)
        return {"covered_unit_ids": sorted(core_ids), "questions": results}

    return answer


def write_agy_index(questions_dir: Path, module_id: str) -> dict[str, Any]:
    """Build a production-format index from deterministic parser-backed model replies."""
    module = load_module(questions_dir.parent)
    papers = exam_source_files(module)
    source_paths = {path.name: path for path in papers}
    with patch("agy_exam_index.agy_writer.request_json", side_effect=_proposal(source_paths)):
        return build_index(module, papers)
