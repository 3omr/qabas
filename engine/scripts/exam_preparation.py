"""Prepare individual exam papers and track the text derived from their bytes."""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from atomic_io import _atomic_write_json, _atomic_write_text
from module_registry import ModuleConfig, ModuleConfigError

TEXT_EXTENSIONS = frozenset({".txt", ".md"})
DOCUMENT_EXTENSIONS = frozenset({".pdf", ".docx", ".doc", ".ppt", ".pptx", ".pps", ".ppsx", ".odt", ".rtf", ".xls", ".xlsx", ".jpg", ".jpeg", ".png", ".webp", ".bmp"})


def _state_path(module: ModuleConfig) -> Path:
    return module.paths.root / ".transcriber-cache" / "exam-texts.json"


def _name(value: str) -> str:
    if not value or Path(value).name != value or "\\" in value or value in {".", ".."}:
        raise ModuleConfigError("Invalid exam filename")
    return value


def _state(module: ModuleConfig) -> dict[str, Any]:
    path = _state_path(module)
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ModuleConfigError("Exam preparation state must be an object")
    for name, entry in value.items():
        _name(name)
        if Path(name).suffix.casefold() not in DOCUMENT_EXTENSIONS:
            raise ModuleConfigError("Invalid exam preparation original")
        if not isinstance(entry, dict) or entry.get("text") != name + ".txt" or not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]) or ("error" in entry and not isinstance(entry["error"], str)):
            raise ModuleConfigError("Invalid exam preparation record")
    return value


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _readable_cache(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        return bool(path.read_text(encoding="utf-8").strip())
    except UnicodeError:
        # Invalid cached text is regenerated from the retained original.
        return False


def derived_exam_names(module: ModuleConfig) -> set[str]:
    """Return generated text names excluded from the student's file inventory."""
    return {entry["text"] for entry in _state(module).values()}


def exam_source_files(module: ModuleConfig) -> list[Path]:
    """Return original supported papers directly under Questions/."""
    derived = derived_exam_names(module)
    return sorted(
        path for path in module.paths.questions.iterdir()
        if path.is_file() and not path.name.startswith(".") and path.name not in derived
        and path.suffix.casefold() in DOCUMENT_EXTENSIONS | TEXT_EXTENSIONS
    )


def _pruned_index(path: Path, name: str) -> dict[str, Any]:
    """Read generated index data and remove only occurrences from one changed original."""
    index = json.loads(path.read_text(encoding="utf-8"))
    sources = {name}
    if Path(name).suffix.casefold() in DOCUMENT_EXTENSIONS:
        sources.add(name + ".txt")
    for key, question in list(index["questions"].items()):
        occurrences = [item for item in question["occurrences"] if item["source"] not in sources]
        if not occurrences:
            del index["questions"][key]
            continue
        question["occurrences"] = occurrences
        question["sources"] = sorted({item["source"] for item in occurrences})
        question["years"] = sorted({item["year"] for item in occurrences if item.get("year")})
    return index


def _invalidate_index(module: ModuleConfig, name: str, *, prune: bool = True) -> None:
    """Retain other papers' manual repairs while removing evidence from the changed paper."""
    path = module.paths.questions / "exam-index.json"
    if not path.is_file():
        return
    if prune:
        try:
            index = _pruned_index(path, name)
        except (ValueError, KeyError, TypeError, AttributeError):
            # Retain unreadable generated data for inspection; the stale timestamp requires rebuilding.
            index = None
        if index is not None:
            _atomic_write_json(path, index)
    # Every current paper is newer than this stale index; rebuilding retains unaffected repairs.
    os.utime(path, ns=(0, 0))


def invalidate_exam(module: ModuleConfig, name: str) -> None:
    """Discard owned text and invalidate index evidence after an original changes."""
    state = _state(module)
    entry = state.pop(name, None)
    if entry is not None:
        (module.paths.questions / entry["text"]).unlink(missing_ok=True)
        _state_path(module).parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(_state_path(module), state)
    _invalidate_index(module, name)


def _extract(module: ModuleConfig, source: Path) -> str:
    from question_coverage import pdf_text
    from source_preparation import PreparationError, prepare_manifest_sources

    if source.suffix.casefold() in TEXT_EXTENSIONS:
        return source.read_text(encoding="utf-8")
    if source.suffix.casefold() == ".docx":
        from docx import Document
        from docx.table import Table
        document = Document(str(source))
        return "\n".join(
            "\n".join("\t".join(cell.text for cell in row.cells) for row in block.rows)
            if isinstance(block, Table) else block.text
            for block in document.iter_inner_content()
        )
    if source.suffix.casefold() == ".xlsx":
        from agy_exam_index import read_source_units

        units = read_source_units(source)
        return "\n".join(
            f"--- Worksheet {unit.locator['sheet']} ---\n{unit.text}"
            for unit in units
        )
    action = "convert" if source.suffix.casefold() in {".pptx"} else "auto"
    prepared = prepare_manifest_sources(module.paths.root, {"sources": [{
        "path": source.relative_to(module.paths.root).as_posix(),
        "role": "past_exam", "action": action,
    }]}, execute=True)
    errors = [*prepared.blocking_errors, *prepared.source_errors.values()]
    if errors or not prepared.entries:
        raise PreparationError("; ".join(errors) or "No prepared exam source")
    return pdf_text(Path(prepared.entries[0].prepared_path))


def prepare_exam_file(module: ModuleConfig, path: str) -> dict[str, Any]:
    """Extract one selected paper, retaining failures for retry and preserving its bytes."""
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path, _module_file
    from module_activity import module_activity

    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        source = _module_file(module, path)
        if source.parent != module.paths.questions or source.suffix.casefold() not in TEXT_EXTENSIONS | DOCUMENT_EXTENSIONS:
            raise ModuleConfigError("Select a supported file directly in Questions/")
        state = _state(module)
        if source.name in derived_exam_names(module):
            raise ModuleConfigError("Select an original exam paper")
        fingerprint = _hash(source)
        text_name = source.name + ".txt"
        destination = module.paths.questions / text_name
        entry = state.get(source.name)
        if entry is not None and entry["sha256"] == fingerprint and _readable_cache(destination) and not entry.get("error"):
            return {"path": path, "status": "ready"}
        if source.suffix.casefold() not in TEXT_EXTENSIONS and destination.exists() and entry is None:
            raise ModuleConfigError(f"Generated text would replace a user file: {text_name}")
        if entry is not None:
            destination.unlink(missing_ok=True)
        if source.suffix.casefold() in DOCUMENT_EXTENSIONS:
            _invalidate_index(module, source.name, prune=entry is None or entry["sha256"] != fingerprint)
        try:
            text = _extract(module, source)
            if not text.strip():
                raise ValueError("No readable text in the exam paper")
            if source.suffix.casefold() not in TEXT_EXTENSIONS:
                _atomic_write_text(destination, text.rstrip() + "\n")
            error = None
        except Exception as failure:  # Each paper retains its diagnostic; other papers can proceed.
            error = str(failure) or type(failure).__name__
        if source.suffix.casefold() not in TEXT_EXTENSIONS:
            state[source.name] = {"sha256": fingerprint, "text": text_name, **({"error": error} if error else {})}
            _state_path(module).parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_json(_state_path(module), state)
        return {"path": path, "status": "failed" if error else "ready", **({"message": error} if error else {})}


def exam_file_status(module: ModuleConfig, path: Path) -> dict[str, Any]:
    """Read persisted preparation status, comparing source bytes before declaring readiness."""
    fingerprint = _hash(path)
    if path.suffix.casefold() in TEXT_EXTENSIONS:
        try:
            readable = bool(path.read_text(encoding="utf-8").strip())
        except UnicodeError as error:
            return {"sha256": fingerprint, "preparation": "failed", "preparation_error": str(error)}
        return {"sha256": fingerprint, "preparation": "ready" if readable else "failed",
                **({"preparation_error": "No readable text in the exam paper"} if not readable else {})}
    entry = _state(module).get(path.name)
    if entry is None or entry["sha256"] != fingerprint:
        return {"sha256": fingerprint, "preparation": "pending"}
    if entry.get("error"):
        return {"sha256": fingerprint, "preparation": "failed", "preparation_error": entry["error"]}
    return {"sha256": fingerprint, "preparation": "ready" if _readable_cache(module.paths.questions / entry["text"]) else "pending"}


def clean_exam_texts(module: ModuleConfig) -> None:
    """Remove only recorded derived text whose original no longer exists."""
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path
    from module_activity import module_activity

    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        for name in list(_state(module)):
            if not (module.paths.questions / name).is_file():
                invalidate_exam(module, name)
