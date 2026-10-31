"""Prepare individual exam papers and track the text derived from their bytes."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from atomic_io import _atomic_write_json, _atomic_write_text
from exam_paths import question_files, question_name, valid_exam_name
from module_registry import ModuleConfig, ModuleConfigError

TEXT_EXTENSIONS = frozenset({".txt", ".md"})
DOCUMENT_EXTENSIONS = frozenset({".pdf", ".docx", ".doc", ".ppt", ".pptx", ".pps", ".ppsx", ".odt", ".rtf", ".xls", ".xlsx", ".jpg", ".jpeg", ".png", ".webp", ".bmp"})


def _state_path(module: ModuleConfig) -> Path:
    return module.paths.root / ".transcriber-cache" / "exam-texts.json"


def _name(value: str) -> str:
    if not valid_exam_name(value):
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
        if "prepared" in entry and not isinstance(entry["prepared"], bool):
            raise ModuleConfigError("Invalid exam preparation ownership")
        if "fallback" in entry and not isinstance(entry["fallback"], bool):
            raise ModuleConfigError("Invalid exam fallback status")
        if "code" in entry and entry["code"] != "ocr_tool_missing":
            raise ModuleConfigError("Invalid exam preparation failure code")
        if "tools" in entry and (not isinstance(entry["tools"], list) or not all(isinstance(tool, str) for tool in entry["tools"])):
            raise ModuleConfigError("Invalid exam preparation tools")
        if "sidecar" in entry and (not isinstance(entry["sidecar"], str) or _name(entry["sidecar"]).casefold() != Path(name).with_suffix(".txt").as_posix().casefold()):
            raise ModuleConfigError("Invalid legacy exam sidecar")
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
    return {entry["text"] for entry in _state(module).values() if entry.get("prepared", True)}


def sidecar_exam_names(module: ModuleConfig, *, lock_held: bool = False) -> set[str]:
    """Persist legacy pairing; ``lock_held`` requires the module registry lock."""
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path

    if lock_held:
        return _pair_exam_sidecars(module)
    with exclusive_file_lock(_lock_path(module)):
        return _pair_exam_sidecars(module)


def _pair_exam_sidecars(module: ModuleConfig) -> set[str]:
    state = _state(module)
    files = question_files(module.paths.questions)
    texts = {question_name(path).casefold(): question_name(path) for path in files if path.suffix.casefold() == ".txt"}
    sidecars = set()
    changed = False
    for path in files:
        if path.suffix.casefold() not in DOCUMENT_EXTENSIONS:
            continue
        sidecar = texts.get(question_name(path.with_suffix(".txt")).casefold())
        if sidecar is None:
            continue
        sidecars.add(sidecar)
        if question_name(path) not in state:
            state[question_name(path)] = {"sha256": _hash(path), "text": question_name(path) + ".txt", "prepared": False}
        entry = state[question_name(path)]
        if entry.get("sidecar") != sidecar:
            entry["sidecar"] = sidecar
            changed = True
    if changed:
        _atomic_write_json(_state_path(module), state)
    return sidecars


def is_exam_text_sibling(path: Path) -> bool:
    """Recognize a derived text sibling only when its original is a supported paper."""
    if path.suffix.casefold() != ".txt":
        return False
    original = path.with_name(path.name[:-4])
    return original.suffix.casefold() in DOCUMENT_EXTENSIONS | TEXT_EXTENSIONS and original.is_file()


def exam_source_files(module: ModuleConfig, *, lock_held: bool = False) -> list[Path]:
    """Return original papers; ``lock_held`` requires the module registry lock."""
    derived = derived_exam_names(module) | sidecar_exam_names(module, lock_held=lock_held)
    return sorted(
        path for path in question_files(module.paths.questions)
        if question_name(path) not in derived
        and not is_exam_text_sibling(path)
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


def _preserve_unowned_text(module: ModuleConfig, name: str) -> str:
    """Retain an unowned derived sibling and its origin independently of preparation state."""
    text_name = name + ".txt"
    archive_root = module.paths.root / ".transcriber-cache" / "exam-text-backups" / uuid.uuid4().hex
    archive = archive_root / "Questions" / text_name
    archive.parent.mkdir(parents=True, exist_ok=True)
    relative = archive.relative_to(module.paths.root).as_posix()
    _atomic_write_json(archive_root / "receipt.json", {"source": "Questions/" + name, "preserved_text": relative})
    shutil.move(str(module.paths.questions / text_name), archive)
    return relative


def invalidate_exam(module: ModuleConfig, name: str) -> None:
    """Discard owned text and invalidate index evidence after an original changes."""
    state = _state(module)
    entry = state.pop(name, None)
    if Path(name).suffix.casefold() in DOCUMENT_EXTENSIONS and (module.paths.questions / (name + ".txt")).is_file() and (entry is None or not entry.get("prepared", True)):
        _preserve_unowned_text(module, name)
    if entry is not None:
        if entry.get("prepared", True):
            (module.paths.questions / entry["text"]).unlink(missing_ok=True)
        _state_path(module).parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(_state_path(module), state)
    _invalidate_index(module, name)


def _extract(module: ModuleConfig, source: Path) -> str:
    from nlm_client import load_config
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
    config = load_config()
    settings = {key: config[key] for key in ("ocr_language", "ocr_format_control_limit", "ocr_script_noise_limit") if key in config}
    prepared = prepare_manifest_sources(module.paths.root, {"sources": [{
        "path": source.relative_to(module.paths.root).as_posix(),
        "role": "past_exam", "action": action, **settings,
    }]}, execute=True)
    errors = [*prepared.blocking_errors, *prepared.source_errors.values()]
    if errors or not prepared.entries:
        raise PreparationError("; ".join(errors) or "No prepared exam source")
    return pdf_text(Path(prepared.entries[0].prepared_path))


def prepare_exam_file(module: ModuleConfig, path: str) -> dict[str, Any]:
    """Extract outside the registry lock; publish only if source hash and state still match.

    A per-paper lock serializes preparation; module activity excludes removal.
    Failures remain retryable and original bytes are preserved.
    """
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path, _module_file
    from module_activity import module_activity

    preparation_lock = module.paths.root / ".transcriber-cache" / "locks" / ("exam-" + hashlib.sha256(path.encode()).hexdigest() + ".lock")
    with module_activity(module, "an exam paper is being prepared"), exclusive_file_lock(
        preparation_lock, module=module.module_id, operation="an exam paper is being prepared"
    ):
        with exclusive_file_lock(_lock_path(module)):
            source = _module_file(module, path)
            if not source.is_relative_to(module.paths.questions) or not valid_exam_name(question_name(source)) or source.suffix.casefold() not in TEXT_EXTENSIONS | DOCUMENT_EXTENSIONS:
                raise ModuleConfigError("Select a supported file under Questions/")
            sidecars = _pair_exam_sidecars(module)
            state = _state(module)
            if question_name(source) in derived_exam_names(module) | sidecars or is_exam_text_sibling(source):
                raise ModuleConfigError("Select an original exam paper")
            fingerprint = _hash(source)
            text_name = question_name(source) + ".txt"
            destination = module.paths.questions / text_name
            entry = state.get(question_name(source))
            if entry is not None and entry["sha256"] == fingerprint and _readable_cache(destination) and not entry.get("error") and not entry.get("fallback") and entry.get("prepared", True):
                return {"path": path, "status": "ready"}
            if source.suffix.casefold() not in TEXT_EXTENSIONS and destination.exists() and (entry is None or not entry.get("prepared", True)):
                preserved = _preserve_unowned_text(module, question_name(source))
                entry = {**(entry or {}), "sha256": fingerprint, "text": text_name, "prepared": False,
                         "preserved_text": preserved}
                state[question_name(source)] = entry
                _atomic_write_json(_state_path(module), state)
            if entry is not None and entry.get("prepared", True):
                destination.unlink(missing_ok=True)
            if source.suffix.casefold() in DOCUMENT_EXTENSIONS:
                _invalidate_index(module, question_name(source), prune=entry is None or entry["sha256"] != fingerprint)
        diagnostic = {}
        fallback_used = False
        try:
            text = _extract(module, source)
            if not text.strip():
                raise ValueError("No readable text in the exam paper")
            error = None
        except Exception as failure:  # Each paper retains its diagnostic; other papers can proceed.
            error = str(failure) or type(failure).__name__
            if error.startswith("ocr_tool_missing:"):
                diagnostic = {"code": "ocr_tool_missing", "tools": json.loads(error.split(":", 1)[1])}
        with exclusive_file_lock(_lock_path(module)):
            current_state = _state(module)
            if not source.is_file() or _hash(source) != fingerprint or current_state.get(question_name(source)) != entry:
                raise ModuleConfigError(f"Exam source changed during preparation: {path}; retry preparation")
            state = current_state
            if source.suffix.casefold() not in TEXT_EXTENSIONS and destination.exists() and (entry is None or not entry.get("prepared", True)):
                raise ModuleConfigError(f"Generated text would replace a user file: {text_name}")
            if error is None and source.suffix.casefold() not in TEXT_EXTENSIONS:
                _atomic_write_text(destination, text.rstrip() + "\n")
            if error is not None and entry is not None and entry.get("sidecar") in sidecars:
                fallback = module.paths.questions / entry["sidecar"]
                if _readable_cache(fallback):
                    _atomic_write_text(destination, fallback.read_text(encoding="utf-8"))
                    error = None
                    fallback_used = True
                    diagnostic = {}
            if source.suffix.casefold() not in TEXT_EXTENSIONS:
                state[question_name(source)] = {"sha256": fingerprint, "text": text_name, "prepared": error is None, **({"sidecar": entry["sidecar"]} if entry and "sidecar" in entry else {}), **({"fallback": True} if fallback_used else {}), **({"preserved_text": entry["preserved_text"]} if entry and "preserved_text" in entry else {}), **diagnostic, **({"error": error} if error else {})}
                _state_path(module).parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_json(_state_path(module), state)
            return {"path": path, "status": "failed" if error else "ready", **diagnostic, **({"message": error} if error else {})}


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
    entry = _state(module).get(question_name(path))
    if entry is None or entry["sha256"] != fingerprint:
        return {"sha256": fingerprint, "preparation": "pending"}
    if entry.get("error"):
        return {"sha256": fingerprint, "preparation": "failed", "preparation_error": entry["error"]}
    return {"sha256": fingerprint, "preparation": "ready" if entry.get("prepared", True) and _readable_cache(module.paths.questions / entry["text"]) else "pending"}


def clean_exam_texts(module: ModuleConfig) -> None:
    """Remove only recorded derived text whose original no longer exists."""
    from file_lock import exclusive_file_lock
    from lecture_registry import _lock_path
    from module_activity import module_activity

    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        for name in list(_state(module)):
            if not (module.paths.questions / name).is_file():
                invalidate_exam(module, name)
