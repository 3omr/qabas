"""Exam-index batch payloads read directly from row-per-question spreadsheet banks.

A worksheet qualifies when its first row names a question column, at least two option
columns (``A``-``F``, ``Option A``, ``Choice A``) and an answer column. Each later row maps
to one question in the same payload the agy extractor returns, so ``_validate_batch``
grounds every field against that row exactly as it grounds model output. A batch that
touches any other worksheet or source format returns ``None`` and keeps model extraction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from exam_years import extract_claimed_exam_years

if TYPE_CHECKING:
    from agy_exam_index import SourceCell, SourceUnit

EXTRACTOR = "columns"
"""Payload and source-record marker for questions mapped from worksheet columns."""

_FIELDS = {
    "stem": frozenset({"text", "question", "question text", "stem"}),
    "answer": frozenset({"correct", "answer", "correct answer", "correct option", "key"}),
    "year": frozenset({"year", "exam year"}),
    "topic": frozenset({"category", "topic", "subject"}),
    "explanation": frozenset({"explanation", "rationale"}),
    "number": frozenset({"no", "no.", "number", "#", "question number"}),
}
_OPTION_HEADING = re.compile(r"(?:option|choice)?\s*([a-f])")
_OPTION_ANSWER = re.compile(r"\(?([a-f])\)?[.)]?")
_UNMATCHED_ANSWER = "The answer cell is unreadable: it names none of this row's options."
_UNREAD_YEAR = "The year cell does not hold exactly one exam year."


@dataclass(frozen=True)
class SheetColumns:
    """Column letters of the recognised fields in one worksheet's first row."""

    fields: dict[str, str]
    options: dict[str, str]


def _column(coordinate: str) -> str:
    return coordinate.rstrip("0123456789")


def _words(value: str) -> str:
    return " ".join(value.casefold().split())


def sheet_columns(header: SourceUnit) -> SheetColumns | None:
    """Recognise a question-per-row schema from a worksheet's row-1 unit; ``None`` lacks a required column."""
    fields: dict[str, str] = {}
    options: dict[str, str] = {}
    for cell in header.cells:
        name = _words(cell.value)
        option = _OPTION_HEADING.fullmatch(name)
        if option is not None:
            options.setdefault(option.group(1).upper(), _column(cell.coordinate))
            continue
        for field, names in _FIELDS.items():
            if name in names:
                fields.setdefault(field, _column(cell.coordinate))
    if "stem" not in fields or "answer" not in fields or len(options) < 2:
        return None
    return SheetColumns(fields, dict(sorted(options.items())))


def _chosen_option(value: str, options: list[tuple[str, SourceCell]]) -> str | None:
    labels = dict(options)
    letter = _OPTION_ANSWER.fullmatch(_words(value))
    if letter is not None and letter.group(1).upper() in labels:
        return letter.group(1).upper()
    return next((label for label, cell in options if _words(cell.value) == _words(value)), None)


def row_question(unit: SourceUnit, columns: SheetColumns) -> dict[str, Any] | None:
    """Map one data row to an extractor question, flagging only defective source cells.

    A row without question text yields ``None``. An empty answer cell is an absent key, not a defect.
    """
    cells = {_column(cell.coordinate): cell for cell in unit.cells}
    stem = cells.get(columns.fields["stem"])
    if stem is None:
        return None
    options = [(label, cells[column]) for label, column in columns.options.items() if column in cells]
    kind = "mcq" if len(options) >= 2 else "written"
    question: dict[str, Any] = {
        "unit_ids": [unit.id], "number": None, "kind": kind, "stem": stem.value,
        "options": [{"label": label, "text": cell.value} for label, cell in options] if kind == "mcq" else [],
        "correct_option": None, "answer_text": None, "answer_evidence": None, "answer_unit_ids": [],
        "explanation": None, "explanation_unit_ids": [], "section": None, "year": None, "year_evidence": None,
        "topic": None, "needs_review": False, "review_reason": None,
    }
    reasons = []
    answer = cells.get(columns.fields["answer"])
    if answer is not None:
        chosen = _chosen_option(answer.value, options) if kind == "mcq" else None
        if kind == "written":
            question.update(answer_text=answer.value, answer_evidence=answer.text(), answer_unit_ids=[unit.id])
        elif chosen is not None:
            question.update(correct_option=chosen, answer_text=dict(options)[chosen].value,
                            answer_evidence=answer.text(), answer_unit_ids=[unit.id])
        else:
            reasons.append(_UNMATCHED_ANSWER)
    year = cells.get(columns.fields.get("year", ""))
    if year is not None:
        years = extract_claimed_exam_years(year.value)
        if len(years) == 1:
            question.update(year=years[0], year_evidence=year.text())
        else:
            reasons.append(_UNREAD_YEAR)
    for field in ("topic", "explanation"):
        cell = cells.get(columns.fields.get(field, ""))
        if cell is not None:
            question[field] = cell.value
    if question["explanation"] is not None:
        question["explanation_unit_ids"] = [unit.id]
    number = cells.get(columns.fields.get("number", ""))
    if number is not None and number.value.isdecimal():
        question["number"] = int(number.value)
    if reasons:
        question.update(needs_review=True, review_reason=" ".join(reasons))
    return question


def column_payload(core: list[SourceUnit], headers: dict[str, SourceUnit]) -> dict[str, Any] | None:
    """Build a batch payload when every required unit is a row of a recognised worksheet.

    ``headers`` maps each sheet title to its row-1 unit. ``None`` leaves the batch to agy.
    """
    columns: dict[str, SheetColumns | None] = {}
    questions = []
    for unit in core:
        if unit.locator.get("type") != "spreadsheet_row":
            return None
        sheet = unit.locator["sheet"]
        if sheet not in columns:
            header = headers.get(sheet)
            columns[sheet] = sheet_columns(header) if header is not None else None
        recognised = columns[sheet]
        if recognised is None:
            return None
        if unit.id == headers[sheet].id:
            continue
        question = row_question(unit, recognised)
        if question is not None:
            questions.append(question)
    return {"covered_unit_ids": [unit.id for unit in core], "questions": questions, "extractor": EXTRACTOR}


__all__ = ["EXTRACTOR", "SheetColumns", "column_payload", "row_question", "sheet_columns"]
