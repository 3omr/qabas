"""Reversible module files, lecture outputs and whole-module removals."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from atomic_io import _atomic_write_json
from file_lock import exclusive_file_lock
from module_activity import module_gate, module_removal_guard
from module_registry import (
    MODULE_ID_PATTERN,
    ModuleConfig,
    ModuleConfigError,
    load_module,
)
from output_assembly import _prepare_temp, _row_links_previous
from transcript_matching import recording_filename_key

META = ".qabas-entry.json"
ENTRY_ID = re.compile(r"^[A-Za-z0-9_-]+$")
KINDS = {"final", "draft", "verbatim"}


def _stamp() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid4().hex[:8], now.isoformat()


def _safe_id(identifier: str) -> str:
    if not isinstance(identifier, str) or not ENTRY_ID.fullmatch(identifier):
        raise ModuleConfigError("Trash id must be a safe entry name")
    return identifier


def _contained(root: Path, path: Path) -> Path:
    if not path.resolve().is_relative_to(root.resolve()) or path.is_symlink():
        raise ModuleConfigError(f"Path escapes the module or is a symbolic link: {path}")
    return path


def _relative(root: Path, name: str) -> Path:
    from lecture_registry import _relative_name

    return _contained(root, root / _relative_name(name))


def _encode(contents: bytes) -> str:
    return base64.b64encode(contents).decode("ascii")


def _decode(contents: str) -> bytes:
    return base64.b64decode(contents, validate=True)


def _atomic_bytes(path: Path, contents: bytes) -> None:
    temporary = Path(_prepare_temp(str(path), contents))
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")


def _new_entry(module: ModuleConfig, kind: str, label: str, paths: list[str]) -> tuple[Path, dict[str, Any]]:
    identifier, removed_at = _stamp()
    directory = module.paths.root / ".transcriber-cache" / "trash" / identifier
    _contained(module.paths.root, directory)
    directory.mkdir(parents=True, exist_ok=False)
    return directory, {"id": identifier, "removed_at": removed_at, "kind": kind, "label": label,
                       "paths": paths, "state": "preparing"}


def _move_entry(module: ModuleConfig, directory: Path, entry: dict[str, Any], edits: dict[Path, bytes]) -> None:
    """Keep originals in the entry and roll back renames and staged edits on a failed commit."""
    root = module.paths.root
    previous = {path: path.read_bytes() if path.exists() else None for path in edits}
    entry["edits"] = [{"path": path.relative_to(root).as_posix(),
                       "before": _encode(contents) if contents is not None else None,
                       "after": _encode(edits[path])} for path, contents in previous.items()]
    _atomic_write_json(directory / META, entry)
    moved: list[tuple[Path, Path]] = []
    written: list[Path] = []
    try:
        for name in entry["paths"]:
            source = _relative(root, name)
            destination = _relative(directory, name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            source.rename(destination)
            moved.append((source, destination))
        for path, contents in edits.items():
            _atomic_bytes(path, contents)
            written.append(path)
        entry["state"] = "removed"
        _atomic_write_json(directory / META, entry)
    except (OSError, ValueError, ModuleConfigError):
        for path in reversed(written):
            original_contents = previous[path]
            if original_contents is None:
                path.unlink(missing_ok=True)
            else:
                _atomic_bytes(path, original_contents)
        for source, destination in reversed(moved):
            source.parent.mkdir(parents=True, exist_ok=True)
            destination.rename(source)
        entry["state"] = "failed"
        _atomic_write_json(directory / META, entry)
        raise


def record_hidden_lecture(module: ModuleConfig, title: str, recordings: list[str], commit: Callable[[], None]) -> None:
    """Retain the label and removal time for the reversible recording visibility operation."""
    directory, entry = _new_entry(module, "lecture", title, ["Lecture/" + name for name in recordings])
    entry["recordings"] = recordings
    original = (module.paths.root / "module.json").read_bytes()
    entry["module_before"] = _encode(original)
    _atomic_write_json(directory / META, entry)
    try:
        commit()
    except (OSError, ValueError, ModuleConfigError):
        entry["state"] = "failed"
        _atomic_write_json(directory / META, entry)
        raise
    entry["state"] = "removed"
    try:
        _atomic_write_json(directory / META, entry)
    except OSError:
        _atomic_bytes(module.paths.root / "module.json", original)
        raise


def trash_file(module: ModuleConfig, name: str) -> dict[str, Any]:
    from lecture_registry import _change_references, _module_file, _payload
    from module_registry import general_materials, lecture_definitions

    with module_removal_guard(module):
        source = _module_file(module, name)
        payload = _payload(module)
        if source.is_relative_to(module.paths.lecture):
            _change_references(payload, source.relative_to(module.paths.lecture).as_posix(), None)
        lecture_definitions(payload)
        general_materials(payload, module.paths.root)
        directory, entry = _new_entry(module, "file", source.name, [name])
        _move_entry(module, directory, entry, {module.paths.root / "module.json": _json_bytes(payload)})
        if source.parent == module.paths.questions:
            from exam_preparation import invalidate_exam
            invalidate_exam(module, source.name)
        return {"trash_path": str(directory / name)}


def _lecture(module: ModuleConfig, title: str) -> dict[str, Any]:
    from mcp_server import _lecture_listing

    if not isinstance(title, str) or not title.strip():
        raise ModuleConfigError("Lecture title must be non-empty")
    units = _lecture_listing(module, {"_remote": "skip"})["lectures"]
    matches = [unit for unit in units if unit.get("id") == title.strip()]
    matches = matches or [unit for unit in units if unit["title"].casefold() == title.strip().casefold()]
    if len(matches) != 1:
        raise ModuleConfigError("Ambiguous lecture title; use its manual id" if matches else f"Unknown lecture: {title}")
    return matches[0]


def _final_extras(module: ModuleConfig, lecture: dict[str, Any]) -> list[Path]:
    from mcp_server import _figure_directories

    paths = [path for path in _figure_directories(module.paths.root, lecture["title"], tuple(lecture["recording_sources"]))
             if path.is_dir()]
    transcript = Path(lecture["transcript"])
    clean_title = transcript.stem.removesuffix(" " + module.emoji).strip()
    clean_filename = clean_title.replace(" ", "_").replace("(", "").replace(")", "")
    paths.extend(module.paths.root / "Anki" / (clean_filename + suffix) for suffix in (".apkg", ".tsv", ".csv"))
    paths.append(module.paths.root / ".transcriber-cache" / "anki_blueprints" / (clean_title + ".blueprint.json"))
    return [path for path in paths if path.exists()]


def _owns_state(payload: dict[str, Any], lecture: dict[str, Any]) -> bool:
    sources = payload.get("recording_sources", [])
    expected = {recording_filename_key(name) for name in lecture["recording_sources"]}
    if isinstance(sources, list) and sources:
        names = {recording_filename_key(name) for name in sources if isinstance(name, str)}
        return bool(names & expected)
    title = payload.get("title", "")
    return isinstance(title, str) and title.strip().casefold() == lecture["title"].casefold()


def _state_removals(module: ModuleConfig, lecture: dict[str, Any]) -> tuple[list[Path], dict[Path, bytes]]:
    cache = module.paths.root / ".transcriber-cache"
    runs: list[Path] = []
    edits: dict[Path, bytes] = {}
    for checkpoint in sorted((cache / "runs").glob("*/checkpoint.json")):
        _contained(module.paths.root, checkpoint)
        payload = json.loads(checkpoint.read_text(encoding="utf-8"))
        if _owns_state(payload, lecture):
            runs.append(checkpoint.parent)
    for ledger in sorted((cache / "batches").glob("*/batch.json")):
        _contained(module.paths.root, ledger)
        payload = json.loads(ledger.read_text(encoding="utf-8"))
        records = payload.get("lectures", {})
        kept = {key: record for key, record in records.items() if not _owns_state(record, lecture)}
        if len(kept) != len(records):
            edits[ledger] = _json_bytes({**payload, "lectures": kept})
    return runs, edits


def _index_removal(module: ModuleConfig, final: Path) -> tuple[dict[Path, bytes], list[dict[str, Any]]]:
    index = module.paths.transcripts / "Index.md"
    if not index.is_file():
        return {}, []
    _contained(module.paths.root, index)
    lines = index.read_bytes().splitlines(keepends=True)
    rows = [{"line": number, "bytes": _encode(line)} for number, line in enumerate(lines)
            if line.lstrip().startswith(b"|") and _row_links_previous(line.decode("utf-8"), {final.name})]
    if not rows:
        return {}, []
    removed = {row["line"] for row in rows}
    return {index: b"".join(line for number, line in enumerate(lines) if number not in removed)}, rows


def remove_transcript(module: ModuleConfig, title: str, kinds: list[str]) -> dict[str, Any]:
    if not isinstance(kinds, list) or not kinds or any(not isinstance(kind, str) or kind not in KINDS for kind in kinds) or len(set(kinds)) != len(kinds):
        raise ModuleConfigError("kinds must be a non-empty subset of final, draft, verbatim without duplicates")
    with module_removal_guard(module):
        module = load_module(module.paths.root)
        lecture = _lecture(module, title)
        paths: list[Path] = []
        edits: dict[Path, bytes] = {}
        rows: list[dict[str, Any]] = []
        for kind in kinds:
            raw_paths = lecture.get("verbatims", []) if kind == "verbatim" else [lecture.get("transcript" if kind == "final" else "draft")]
            selected: list[Path] = [Path(path) for path in raw_paths if path]
            if not selected:
                raise ModuleConfigError(f"Lecture {lecture['title']!r} has no {kind} output to remove")
            paths.extend(selected)
            if kind == "final":
                paths.extend(_final_extras(module, lecture))
                index_edits, rows = _index_removal(module, selected[0])
                edits.update(index_edits)
        if "draft" in kinds:
            draft_name = Path(lecture["draft"]).name
            cache = module.paths.root / ".transcriber-cache"
            paths.extend(path for path in (cache / "staged-drafts" / draft_name,
                         cache / "draft-checks" / (draft_name + ".json")) if path.exists())
        runs, state_edits = _state_removals(module, lecture)
        paths.extend(runs)
        edits.update(state_edits)
        names = list(dict.fromkeys(_contained(module.paths.root, path).relative_to(module.paths.root).as_posix() for path in paths))
        directory, entry = _new_entry(module, "transcript", lecture["title"], names)
        entry["kinds"] = kinds
        entry["index_rows"] = rows
        _move_entry(module, directory, entry, edits)
        return {"module": module.module_id, "id": entry["id"], "paths": names}


def _validate_entry(directory: Path, entry: Any) -> None:
    if not isinstance(entry, dict) or entry.get("id") != directory.name:
        raise ValueError("Trash identity mismatch")
    if entry["kind"] not in {"file", "transcript", "lecture"} or entry["state"] not in {"preparing", "failed", "removed", "restored"}:
        raise ValueError("Invalid trash kind or state")
    if not isinstance(entry["label"], str):
        raise ValueError("Invalid trash label")
    datetime.fromisoformat(entry["removed_at"])
    names = entry["paths"]
    if not isinstance(names, list) or not names or len(set(names)) != len(names):
        raise ValueError("Invalid trash paths")
    for name in names:
        _relative(directory, name)
    if entry["kind"] == "lecture":
        recordings = entry["recordings"]
        if not isinstance(recordings, list) or not recordings or any(not isinstance(name, str) for name in recordings):
            raise ValueError("Invalid hidden recordings")
        if names != ["Lecture/" + name for name in recordings]:
            raise ValueError("Hidden recording paths mismatch")
    edits = entry.get("edits", [])
    if not isinstance(edits, list):
        raise ValueError("Invalid trash edits")
    seen: set[str] = set()
    for edit in edits:
        path = _relative(directory, edit["path"])
        name = edit["path"]
        allowed = name in {"module.json", "Transcripts/Index.md"} or (name.startswith(".transcriber-cache/batches/") and path.name == "batch.json")
        if not allowed or name in seen:
            raise ValueError("Invalid trash edit target")
        seen.add(name)
        if edit["before"] is not None:
            _decode(edit["before"])
        _decode(edit["after"])
    rows = entry.get("index_rows", [])
    if not isinstance(rows, list):
        raise ValueError("Invalid index rows")
    for row in rows:
        if not isinstance(row["line"], int) or row["line"] < 0:
            raise ValueError("Invalid index row position")
        _decode(row["bytes"])


def _read_entry(directory: Path) -> dict[str, Any]:
    metadata = _contained(directory, directory / META)
    if metadata.is_file():
        try:
            entry = json.loads(metadata.read_text(encoding="utf-8"))
        except ValueError as error:
            raise ModuleConfigError(f"Invalid trash metadata: {metadata}") from error
        try:
            _validate_entry(directory, entry)
        except (KeyError, TypeError, ValueError) as error:
            raise ModuleConfigError(f"Invalid trash metadata: {metadata}") from error
        return entry
    paths = [path.relative_to(directory).as_posix() for path in sorted(directory.rglob("*")) if path.is_file()]
    try:
        removed_at = datetime.strptime(directory.name.split("-", 1)[0], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc).isoformat()
    except ValueError as error:
        raise ModuleConfigError(f"Invalid legacy trash timestamp: {directory.name}") from error
    return {"id": directory.name, "kind": "file", "label": Path(paths[0]).name if paths else directory.name,
            "paths": paths, "removed_at": removed_at, "state": "removed"}


def _entry_view(entry: dict[str, Any]) -> dict[str, Any]:
    return {key: entry[key] for key in ("id", "removed_at", "kind", "label", "paths")}


def list_trash(module: ModuleConfig) -> list[dict[str, Any]]:
    from lecture_registry import lecture_units

    module = load_module(module.paths.root)
    entries: list[dict[str, Any]] = []
    hidden = {recording_filename_key(name) for name in module.hidden_recordings}
    covered: set[str] = set()
    root = module.paths.root / ".transcriber-cache" / "trash"
    for directory in sorted(root.iterdir(), reverse=True) if root.is_dir() else []:
        if not directory.is_dir():
            continue
        _contained(module.paths.root, directory)
        entry = _read_entry(directory)
        if entry["state"] != "removed":
            continue
        if entry["kind"] == "lecture":
            names = [name for name in entry["recordings"] if recording_filename_key(name) in hidden and recording_filename_key(name) not in covered]
            if not names:
                continue
            covered.update(recording_filename_key(name) for name in names)
            entry = {**entry, "paths": ["Lecture/" + name for name in names]}
        if entry["paths"]:
            entries.append(_entry_view(entry))
    remaining = [name for name in module.hidden_recordings if recording_filename_key(name) not in covered]
    # Visibility metadata predating trash manifests has no historical removal timestamp.
    for unit in lecture_units(module, [Path(name) for name in remaining], include_hidden=True):
        names = [name for name in remaining if recording_filename_key(name) in {recording_filename_key(source) for source in unit["recording_sources"]}]
        if names:
            identifier = "hidden-" + hashlib.sha256("\n".join(sorted(names)).encode()).hexdigest()[:16]
            stamp = datetime.fromtimestamp((module.paths.root / "module.json").stat().st_mtime, timezone.utc).isoformat()
            entries.append({"id": identifier, "removed_at": stamp, "kind": "lecture", "label": unit["title"],
                            "paths": ["Lecture/" + name for name in names]})
    return sorted(entries, key=lambda entry: (entry["removed_at"], entry["id"]), reverse=True)


def _restored_edit(module: ModuleConfig, edit: dict[str, Any], entry: dict[str, Any]) -> bytes | None:
    path = _relative(module.paths.root, edit["path"])
    before = _decode(edit["before"]) if edit["before"] is not None else None
    after = _decode(edit["after"])
    current = path.read_bytes() if path.exists() else None
    if current == after:
        return before
    if edit["path"] == "module.json":
        return current  # Later definitions remain owned by the student.
    if path.name == "Index.md":
        lines = (current or b"").splitlines(keepends=True)
        restored_names = {Path(name).name for name in entry["paths"] if name.startswith("Transcripts/") and name.endswith(".md")}
        if any(_row_links_previous(line.decode("utf-8"), restored_names) for line in lines if line.lstrip().startswith(b"|")):
            raise ModuleConfigError(f"Destination already contains the transcript row: {edit['path']}")
        for row in entry.get("index_rows", []):
            lines.insert(min(row["line"], len(lines)), _decode(row["bytes"]))
        return b"".join(lines)
    previous = json.loads(before or b"{}")
    removed = {key: record for key, record in previous.get("lectures", {}).items()
               if key not in json.loads(after).get("lectures", {})}
    latest = json.loads(current) if current is not None else previous
    for key in removed:
        if current is not None and key in latest.get("lectures", {}):
            raise ModuleConfigError(f"Batch progress already occupies the restored entry: {edit['path']}")
    latest.setdefault("lectures", {}).update(removed)
    return _json_bytes(latest)


def restore_trash(module: ModuleConfig, identifier: str) -> dict[str, Any]:
    from lecture_registry import restore_recordings

    identifier = _safe_id(identifier)
    view = next((entry for entry in list_trash(module) if entry["id"] == identifier), None)
    if view is None:
        raise ModuleConfigError(f"Unknown trash entry: {identifier}")
    if view["kind"] == "lecture":
        names = [Path(path).relative_to("Lecture").as_posix() for path in view["paths"]]
        restore_recordings(module, names)
        return {"module": module.module_id, "id": identifier, "paths": view["paths"]}
    with module_removal_guard(module):
        root = module.paths.root
        directory = _contained(root, root / ".transcriber-cache" / "trash" / identifier)
        entry = _read_entry(directory)
        if entry["state"] != "removed":
            raise ModuleConfigError(f"Trash entry is already restored: {identifier}")
        destinations = [(_relative(directory, name), _relative(root, name)) for name in entry["paths"]]
        for source, destination in destinations:
            if destination.exists() or destination.is_symlink():
                raise ModuleConfigError(f"Destination already occupied: {destination.relative_to(root).as_posix()}")
            if not source.exists():
                raise ModuleConfigError(f"Missing trash file: {source.relative_to(directory).as_posix()}")
            for parent in destination.parents:
                if parent == root:
                    break
                if parent.exists() and not parent.is_dir():
                    raise ModuleConfigError(f"Destination already occupied: {parent.relative_to(root).as_posix()}")
        edits = {_relative(root, edit["path"]): _restored_edit(module, edit, entry) for edit in entry.get("edits", [])}
        previous = {path: path.read_bytes() if path.exists() else None for path in edits}
        moved: list[tuple[Path, Path]] = []
        written: list[Path] = []
        try:
            for source, destination in destinations:
                destination.parent.mkdir(parents=True, exist_ok=True)
                source.rename(destination)
                moved.append((source, destination))
            for path, contents in edits.items():
                if contents is not None:
                    _atomic_bytes(path, contents)
                    written.append(path)
            entry["state"] = "restored"
            _atomic_write_json(directory / META, entry)
        except (OSError, ValueError, ModuleConfigError):
            for path in reversed(written):
                contents = previous[path]
                if contents is None:
                    path.unlink(missing_ok=True)
                else:
                    _atomic_bytes(path, contents)
            for source, destination in reversed(moved):
                destination.rename(source)
            raise
        return {"module": module.module_id, "id": identifier, "paths": entry["paths"]}


def _module_root(workspace: Path, identifier: str) -> Path:
    if not isinstance(identifier, str) or not MODULE_ID_PATTERN.fullmatch(identifier):
        raise ModuleConfigError("Module id must be a lowercase slug")
    return _contained(workspace.resolve(), workspace.resolve() / "modules" / identifier)


def remove_module(workspace: Path, identifier: str) -> dict[str, Any]:
    source = _module_root(workspace, identifier)
    module = load_module(source)
    with module_removal_guard(module):
        stamp, _removed_at = _stamp()
        trash_id = identifier + "--" + stamp
        destination = _contained(workspace, workspace / ".qabas-trash" / "modules" / trash_id)
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.rename(destination)
        return {"module": identifier, "trash_id": trash_id, "notebook_untouched": True}


def list_removed_modules(workspace: Path) -> list[dict[str, Any]]:
    root = _contained(workspace, workspace / ".qabas-trash" / "modules")
    entries = []
    for directory in sorted(root.iterdir(), reverse=True) if root.is_dir() else []:
        if not directory.is_dir():
            continue
        _contained(workspace, directory)
        identifier, separator, timestamp = directory.name.rpartition("--")
        if not separator or not MODULE_ID_PATTERN.fullmatch(identifier):
            raise ModuleConfigError(f"Invalid removed module entry: {directory.name}")
        config = _contained(workspace, directory / "module.json")
        payload = json.loads(config.read_text(encoding="utf-8"))
        if payload.get("module_id") != identifier or not isinstance(payload.get("display_name"), str) or not payload["display_name"].strip():
            raise ModuleConfigError(f"Removed module metadata mismatch: {directory.name}")
        removed_at = datetime.strptime(timestamp.split("-", 1)[0], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc).isoformat()
        entries.append({"trash_id": directory.name, "module": identifier, "display_name": payload["display_name"], "removed_at": removed_at})
    return sorted(entries, key=lambda entry: (entry["removed_at"], entry["trash_id"]), reverse=True)


def restore_module(workspace: Path, trash_id: str) -> dict[str, Any]:
    trash_id = _safe_id(trash_id)
    entry = next((entry for entry in list_removed_modules(workspace) if entry["trash_id"] == trash_id), None)
    if entry is None:
        raise ModuleConfigError(f"Unknown removed module: {trash_id}")
    destination = _module_root(workspace, entry["module"])
    try:
        with exclusive_file_lock(module_gate(workspace, entry["module"]), blocking=False):
            if destination.exists() or destination.is_symlink():
                raise ModuleConfigError(f"A module already exists at modules/{entry['module']}; restore was refused")
            destination.parent.mkdir(parents=True, exist_ok=True)
            source = _contained(workspace, workspace / ".qabas-trash" / "modules" / trash_id)
            source.rename(destination)
    except BlockingIOError as error:
        raise ModuleConfigError(f"Module {entry['module']!r} is busy with a running job; wait for it to finish") from error
    return {"module": entry["module"], "notebook_untouched": True}
