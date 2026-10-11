"""Persist owner-assigned paper years independently of generated extraction caches."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from atomic_io import _atomic_write_json

STORE_NAME = ".exam-year-overrides.json"
#: Owner choice that a paper is an undated question bank rather than one dated exam.
BANK = "bank"
OwnerYear = int | Literal["bank"]


def _valid_choice(value: Any) -> bool:
    return value == BANK or (type(value) is int and 1900 <= value <= 2100)


def load_year_overrides(questions_dir: Path) -> dict[str, OwnerYear]:
    """Read validated paper-name/year entries (a year, or ``"bank"``); malformed owner metadata fails loudly."""
    path = questions_dir / STORE_NAME
    if not path.exists():
        return {}
    values = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(values, dict) or any(
        not isinstance(name, str) or Path(name).name != name or not name or name in {".", ".."} or "\\" in name or name.startswith(".")
        or not _valid_choice(year)
        for name, year in values.items()
    ):
        raise ValueError("Invalid exam year override store")
    return values


def rename_year_override(questions_dir: Path, old: str, new: str) -> None:
    """Move an owner year with its original file; trash leaves this store intact."""
    values = load_year_overrides(questions_dir)
    if old in values:
        values[new] = values.pop(old)
        _atomic_write_json(questions_dir / STORE_NAME, values)


def paper_year_metadata(index: dict[str, Any] | None, name: str, overrides: dict[str, OwnerYear]) -> dict[str, Any]:
    """Return a single effective paper year and its authority when available."""
    year: int | None
    authority: str | None
    source: dict[str, Any] = next((item for item in (index or {}).get("sources", []) if item["file"] == name), {})
    if name in overrides:
        choice = overrides[name]
        year, authority = (None if isinstance(choice, str) else choice), "owner"
    else:
        years = source.get("years", [])
        year = years[0] if len(years) == 1 else None
        authorities = {occurrence.get("year_source") for question in (index or {}).get("questions", {}).values()
                       for occurrence in question.get("occurrences", []) if occurrence.get("source") == name and occurrence.get("year") == year}
        authority = "paper" if authorities & {"paper", "question", "section"} else "filename" if "filename" in authorities else None
        from exam_years import extract_filename_exam_years
        filename_years = extract_filename_exam_years(name)
        if year is not None and authority is None:
            authority = "filename" if year in filename_years else "paper"
        if year is None and len(filename_years) == 1 and not years:
            year, authority = filename_years[0], "filename"
    return {"year": year, "year_source": authority, "review_status": source.get("review_status")}


def apply_year_overrides(index: dict[str, Any], questions_dir: Path) -> None:
    """Project owner years into occurrences while retaining the extracted values for clearing."""
    overrides = load_year_overrides(questions_dir)
    for source in index.get("sources", []):
        name = source["file"]
        if name in overrides:
            choice = overrides[name]
            source.setdefault("extracted_years", source.get("years", []))
            source.setdefault("extracted_kind", source.get("kind"))
            if choice == BANK:
                source.update(years=[], year=None, year_source="owner", kind="question_bank")
            else:
                source.update(years=[choice], year=choice, year_source="owner", kind="past_exam")
        elif "extracted_years" in source:
            source["years"] = source.pop("extracted_years")
            source["kind"] = source.pop("extracted_kind")
            source.pop("year", None)
            source.pop("year_source", None)
    for question in index.get("questions", {}).values():
        for occurrence in question.get("occurrences", []):
            name = occurrence["source"]
            if name in overrides:
                choice = overrides[name]
                occurrence.setdefault("extracted_year", {key: occurrence[key] for key in ("year", "year_source", "year_evidence") if key in occurrence})
                occurrence.update(year=None if choice == BANK else choice, year_source="owner", year_evidence=None)
            elif "extracted_year" in occurrence:
                extracted = occurrence.pop("extracted_year")
                for key in ("year", "year_source", "year_evidence"):
                    occurrence.pop(key, None)
                occurrence.update(extracted)
        question["years"] = sorted({item["year"] for item in question.get("occurrences", []) if item.get("year") is not None})


def set_exam_year(module: Any, path: str, year: OwnerYear | None) -> dict[str, Any]:
    """Set a paper's year, mark it an undated bank (``"bank"``), or clear the choice (None).

    The published index is refreshed without model requests.
    """
    from exam_index import INDEX_NAME, load_index, write_index
    from exam_preparation import exam_source_files
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path, _module_file
    from module_activity import module_activity

    if year is not None and not _valid_choice(year):
        raise ValueError('year must be an integer from 1900 to 2100, "bank", or null')
    with module_activity(module), exclusive_file_lock(module.paths.questions / ".exam-index-build.lock"), exclusive_file_lock(_lock_path(module)):
        source = _module_file(module, path)
        if source.parent != module.paths.questions or source not in exam_source_files(module, lock_held=True):
            raise ValueError("Select an original exam file directly under Questions/.")
        values = load_year_overrides(module.paths.questions)
        if year is None:
            values.pop(source.name, None)
        else:
            values[source.name] = year
        _atomic_write_json(module.paths.questions / STORE_NAME, values)
        index = load_index(module.paths.questions) if (module.paths.questions / INDEX_NAME).exists() else None
        if index is not None:
            write_index(index, module.paths.questions)
        metadata = paper_year_metadata(index, source.name, values)
        return {"module": module.module_id, "path": path, "year": metadata["year"], "year_source": metadata["year_source"]}
