"""Student-owned lecture definitions and reversible module file operations."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from atomic_io import _atomic_write_json
from file_lock import exclusive_file_lock
from module_activity import module_activity, module_removal_guard
from module_registry import (
    MODULE_ID_PATTERN,
    LectureDefinition,
    ModuleConfig,
    ModuleConfigError,
    general_materials,
    hidden_recordings,
    hidden_transcripts,
    lecture_definitions,
    load_module,
    validated_materials,
)
from recording_grouping import _group_recordings
from source_naming import normalize_source_stem
from transcript_matching import (
    RECORDING_EXTENSIONS,
    matching_transcripts,
    module_final_transcripts,
    recording_filename_key,
)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lock_path(module: ModuleConfig) -> Path:
    return module.paths.root / ".transcriber-cache" / "lecture-registry.lock"


def _payload(module: ModuleConfig) -> dict[str, Any]:
    return json.loads((module.paths.root / "module.json").read_text(encoding="utf-8"))


def _write_definitions(module: ModuleConfig, payload: dict[str, Any]) -> None:
    lecture_definitions(payload)
    hidden_recordings(payload)
    hidden_transcripts(payload)
    general_materials(payload, module.paths.root)
    _atomic_write_json(module.paths.root / "module.json", payload)


def _relative_name(name: str) -> str:
    if not isinstance(name, str) or not name.strip() or "\\" in name or ":" in name or "\x00" in name:
        raise ModuleConfigError("File name must be a safe relative path")
    path = Path(name)
    if path.is_absolute() or any(part in {"..", ".", ""} for part in name.split("/")):
        raise ModuleConfigError("File name must not contain path traversal")
    return path.as_posix()


def lecture_file(module: ModuleConfig, name: str) -> Path:
    relative = _relative_name(name)
    path = module.paths.lecture / relative
    if not path.resolve().is_relative_to(module.paths.lecture.resolve()):
        raise ModuleConfigError("File escapes Lecture/")
    if not path.resolve().is_relative_to(module.paths.root.resolve()):
        raise ModuleConfigError("Lecture/ escapes the module root")
    return path


def notebook_sources(module: ModuleConfig) -> list[Any]:
    from remote_inventory import module_inventory

    inventory = module_inventory(module)
    if not inventory.available:
        raise ModuleConfigError(inventory.warning or "NotebookLM inventory is unavailable")
    return inventory.sources


def _validated_files(module: ModuleConfig, names: Any, kind: str) -> list[str]:
    if kind == "materials":
        return list(validated_materials(module.paths.root, names))
    if not isinstance(names, list):
        raise ModuleConfigError(f"{kind} must be an array of file names")
    validated = [_relative_name(name) for name in names]
    if len(set(validated)) != len(validated):
        raise ModuleConfigError(f"Duplicate {kind} file")
    hidden = {recording_filename_key(name) for name in module.hidden_recordings}
    for name in validated:
        if recording_filename_key(name) in hidden:
            raise ModuleConfigError(f"Recording {name!r} is hidden; call restore_recordings before defining it")
    missing = [name for name in validated if not lecture_file(module, name).is_file()]
    if missing:
        if kind != "recordings":
            raise ModuleConfigError(
                f"Material does not exist under Lecture/: {missing[0]}"
            )
        remote_names = {
            source.title
            for source in notebook_sources(module)
            if source.source_type.casefold() in {"audio", "video"}
        }
        if any(name not in remote_names for name in missing):
            raise ModuleConfigError(
                "Recording must exist under Lecture/ or in NotebookLM"
            )
    for name in validated:
        if lecture_file(module, name).is_file() and (
            (Path(name).suffix.casefold() in RECORDING_EXTENSIONS)
            != (kind == "recordings")
        ):
            raise ModuleConfigError(f"Wrong file kind for {kind}: {name}")
    return validated


# These arguments mirror the desktop tool contract, including the explicit update id.
def define_lecture(
    module: ModuleConfig,
    title: str,
    recordings: list[str],
    materials: list[str],
    id: str | None = None,
) -> dict[str, Any]:
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        current = load_module(module.paths.root)
        payload = _payload(current)
        definitions = payload.get("lectures", [])
        definition = _organization_definition(current, {
            "title": title, "recordings": recordings, "materials": materials, "id": id,
        }, definitions, definitions)
        payload["lectures"] = [definition if entry["id"] == definition["id"] else entry for entry in definitions]
        if not any(entry["id"] == definition["id"] for entry in definitions):
            payload["lectures"].append(definition)
        _remove_claimed_general(current, payload, definition["materials"])
        _write_definitions(current, payload)
        return definition


def apply_organization(
    module: ModuleConfig, lectures: list[dict[str, Any]], replace_existing: bool = False,
    general: list[str] | None = None,
) -> dict[str, Any]:
    if not isinstance(replace_existing, bool) or not isinstance(lectures, list):
        raise ModuleConfigError("lectures must be an array and replace_existing a boolean")
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        current = load_module(module.paths.root)
        payload = _payload(current)
        originals = payload.get("lectures", [])
        definitions = [] if replace_existing else list(originals)
        requested_ids: set[str] = set()
        for request in lectures:
            definition = _organization_definition(current, request, definitions, originals)
            identifier = definition["id"]
            if identifier in requested_ids:
                raise ModuleConfigError("Duplicate lecture id in organization")
            requested_ids.add(identifier)
            definitions = [entry for entry in definitions if entry["id"] != identifier]
            definitions.append(definition)
        payload["lectures"] = definitions
        _remove_claimed_general(current, payload, [name for definition in definitions for name in definition["materials"]])
        if general is not None:
            _set_general_in_payload(current, payload, general)
        _write_definitions(current, payload)
        return {"module": module.module_id, "lectures": payload["lectures"], "general": payload.get("general_materials", [])}


def _remove_claimed_general(module: ModuleConfig, payload: dict[str, Any], materials: list[str]) -> None:
    claimed = {lecture_file(module, name).resolve() for name in materials}
    if "general_materials" in payload:
        payload["general_materials"] = [name for name in payload["general_materials"]
                                        if lecture_file(module, name).resolve() not in claimed]


def _set_general_in_payload(module: ModuleConfig, payload: dict[str, Any], materials: list[str]) -> None:
    names = list(validated_materials(module.paths.root, materials))
    identities = {lecture_file(module, name).resolve() for name in names}
    for definition in payload.get("lectures", []):
        remaining = [name for name in definition["materials"] if lecture_file(module, name).resolve() not in identities]
        if remaining != definition["materials"]:
            definition.update(materials=remaining, updated=_timestamp())
    payload["general_materials"] = names


def set_general_materials(module: ModuleConfig, materials: list[str]) -> dict[str, Any]:
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        current = load_module(module.paths.root)
        payload = _payload(current)
        _set_general_in_payload(current, payload, materials)
        _write_definitions(current, payload)
        return {"module": module.module_id, "general_materials": payload["general_materials"]}


def _organization_definition(
    module: ModuleConfig, request: dict[str, Any], definitions: list[dict[str, Any]], originals: list[dict[str, Any]]
) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ModuleConfigError("Each lecture must be an object")
    title, identifier = request.get("title"), request.get("id")
    if not isinstance(title, str) or not title.strip():
        raise ModuleConfigError("Lecture title must be non-empty")
    if identifier is not None and (not isinstance(identifier, str) or not MODULE_ID_PATTERN.fullmatch(identifier)):
        raise ModuleConfigError("Lecture id must be a stable slug")
    if identifier is None:
        base = re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-") or "lecture"
        identifier, suffix = base, 2
        while any(entry["id"] == identifier for entry in definitions):
            identifier, suffix = f"{base}-{suffix}", suffix + 1
    existing = next((entry for entry in originals if entry["id"] == identifier), None)
    stamp = _timestamp()
    return {"id": identifier, "title": title.strip(),
            "recordings": _validated_files(module, request.get("recordings"), "recordings"),
            "materials": _validated_files(module, request.get("materials"), "materials"),
            "created": existing["created"] if existing else stamp, "updated": stamp}


def delete_lecture(module: ModuleConfig, id: str) -> None:
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        payload = _payload(module)
        definitions = payload.get("lectures", [])
        if not any(definition["id"] == id for definition in definitions):
            raise ModuleConfigError(f"Unknown lecture id: {id}")
        payload["lectures"] = [
            definition for definition in definitions if definition["id"] != id
        ]
        _write_definitions(module, payload)


def lecture_units(
    module: ModuleConfig, recordings: list[Path], *, include_hidden: bool = False
) -> list[dict[str, Any]]:
    consumed: set[str] = set()
    units: list[dict[str, Any]] = []
    for definition in module.lectures:
        consumed.update(recording_filename_key(name) for name in definition.recordings)
        units.append(
            {
                "id": definition.id,
                "origin": "manual",
                "title": definition.title,
                "recording_sources": list(definition.recordings),
                "materials": list(definition.materials),
                "parts": len(definition.recordings),
                "paths": [
                    str(lecture_file(module, name))
                    for name in definition.recordings
                    if lecture_file(module, name).is_file()
                ],
            }
        )
    units += _group_recordings(
        [path for path in recordings if recording_filename_key(path.name) not in consumed]
    )
    if include_hidden:
        return units
    hidden = {recording_filename_key(name) for name in module.hidden_recordings}
    return [{**unit,
             "recording_sources": [name for name in unit["recording_sources"] if recording_filename_key(name) not in hidden],
             "paths": [path for path in unit["paths"] if recording_filename_key(path) not in hidden],
             "parts": sum(recording_filename_key(name) not in hidden for name in unit["recording_sources"])}
            for unit in units if not unit_hidden(module, unit)]


def unit_hidden(module: ModuleConfig, unit: dict[str, Any]) -> bool:
    """A partially hidden multipart lecture remains visible until all recordings are hidden."""
    sources = unit["recording_sources"]
    hidden = {recording_filename_key(name) for name in module.hidden_recordings}
    return bool(sources) and all(recording_filename_key(name) in hidden for name in sources)


def hide_lecture(module: ModuleConfig, title: str) -> dict[str, Any]:
    """Hide a visible recording unit and remove its definition without changing student files."""
    if not isinstance(title, str) or not title.strip():
        raise ModuleConfigError("Lecture title must be non-empty")
    with module_removal_guard(module), exclusive_file_lock(_lock_path(module)):
        current = load_module(module.paths.root)
        from remote_inventory import module_inventory

        local = [path for path in sorted(current.paths.lecture.rglob("*"))
                 if path.is_file() and path.suffix.casefold() in RECORDING_EXTENSIONS]
        inventory = module_inventory(current, "skip")
        local_stems = {normalize_source_stem(path.name) for path in local}
        remote = [Path(source.title) for source in inventory.sources
                  if source.source_type.casefold() in {"audio", "video"}
                  and normalize_source_stem(source.title) not in local_stems]
        units = lecture_units(current, local + remote, include_hidden=True)
        matches = [unit for unit in units if unit.get("id") == title.strip()]
        matches = matches or [unit for unit in units if unit["title"].casefold() == title.strip().casefold()]
        if len(matches) != 1:
            raise ModuleConfigError("Ambiguous lecture title; use its manual id" if matches else f"Unknown lecture: {title}")
        unit = matches[0]
        if not unit["recording_sources"]:
            raise ModuleConfigError("Lecture has no recordings to hide")
        names = list(unit["recording_sources"])
        if unit["origin"] == "auto":
            names = [Path(path).relative_to(current.paths.lecture).as_posix() if Path(path).is_absolute() else path
                     for path in unit["paths"]]
        for name in names:
            lecture_file(current, name)
        payload = _payload(current)
        hidden = list(current.hidden_recordings)
        identities = {recording_filename_key(name) for name in hidden}
        hidden.extend(name for name in names if recording_filename_key(name) not in identities)
        payload["hidden_recordings"] = hidden
        payload["lectures"] = [definition for definition in payload.get("lectures", []) if definition["id"] != unit.get("id")]
        references = payload.setdefault("hidden_transcripts", {})
        for transcript in matching_transcripts(module_final_transcripts(current.paths.transcripts), unit["title"], names):
            references[transcript.name] = names
        from library_trash import record_hidden_lecture

        record_hidden_lecture(current, unit["title"], names, lambda: _write_definitions(current, payload))
        return {"module": current.module_id, "recordings": names}


def restore_recordings(module: ModuleConfig, recordings: list[str]) -> dict[str, Any]:
    """Restore selected recording names; lecture definitions and transcripts are not rewritten."""
    names = hidden_recordings({"hidden_recordings": recordings})
    if not names:
        raise ModuleConfigError("recordings must be a non-empty list")
    for name in names:
        lecture_file(module, name)
    identities = {recording_filename_key(name) for name in names}
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        current = load_module(module.paths.root)
        payload = _payload(current)
        restored = [name for name in current.hidden_recordings if recording_filename_key(name) in identities]
        payload["hidden_recordings"] = [name for name in current.hidden_recordings if recording_filename_key(name) not in identities]
        payload["hidden_transcripts"] = {name: list(sources) for name, sources in current.hidden_transcripts.items()
                                         if not any(recording_filename_key(source) in identities for source in sources)}
        _write_definitions(current, payload)
        return {"module": current.module_id, "recordings": restored}


def manual_definition(
    module: ModuleConfig,
    title: str,
    recordings: tuple[str, ...] | None = None,
) -> LectureDefinition | None:
    exact = [definition for definition in module.lectures if definition.id == title]
    matches = exact or [
        definition
        for definition in module.lectures
        if definition.title.casefold() == title.casefold()
    ]
    if recordings is not None:
        matches = [
            definition for definition in matches if definition.recordings == recordings
        ]
    if len(matches) > 1:
        raise ModuleConfigError("Ambiguous lecture title; use its manual id")
    return matches[0] if matches else None


def _module_file(module: ModuleConfig, path: str) -> Path:
    relative = _relative_name(path)
    supplied = module.paths.root / relative
    if Path(relative).parts[0] not in {"Lecture", "Questions"}:
        raise ModuleConfigError("File must be under Lecture/ or Questions/")
    folder = module.paths.root / Path(relative).parts[0]
    if (
        not supplied.resolve().is_relative_to(folder.resolve())
        or not supplied.resolve().is_relative_to(module.paths.root.resolve())
        or not supplied.is_file()
    ):
        raise ModuleConfigError(f"Not an existing module file: {path}")
    return supplied


def _new_filename(name: str) -> str:
    relative = _relative_name(name)
    if len(Path(relative).parts) != 1:
        raise ModuleConfigError("New file name must not contain directories")
    return relative


def _change_references(payload: dict[str, Any], old: str, new: str | None) -> None:
    if "hidden_recordings" in payload:
        payload["hidden_recordings"] = [new if name == old else name for name in payload["hidden_recordings"]
                                        if name != old or new is not None]
    for name, recordings in list(payload.get("hidden_transcripts", {}).items()):
        changed = [new if source == old else source for source in recordings if source != old or new is not None]
        if changed:
            payload["hidden_transcripts"][name] = changed
        else:
            del payload["hidden_transcripts"][name]
    if "general_materials" in payload:
        payload["general_materials"] = [new if name == old else name for name in payload["general_materials"]
                                        if name != old or new is not None]
    for definition in payload.get("lectures", []):
        for field in ("recordings", "materials"):
            if old in definition[field]:
                definition[field] = [
                    new if name == old else name
                    for name in definition[field]
                    if name != old or new is not None
                ]
                definition["updated"] = _timestamp()
    mappings = payload.get("lecture_slides", {})
    for key, path in list(mappings.items()):
        if path == f"Lecture/{old}":
            if new is None:
                del mappings[key]
            else:
                mappings[key] = f"Lecture/{new}"
        if recording_filename_key(key) == recording_filename_key(old):
            mapped = mappings.pop(key, None)
            if new is not None and mapped is not None:
                mappings[new] = mapped


def rename_file(module: ModuleConfig, path: str, new_name: str) -> dict[str, Any]:
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        source = _module_file(module, path)
        destination = source.with_name(_new_filename(new_name))
        if destination.exists():
            raise ModuleConfigError(f"File already exists: {destination.name}")
        if (source.suffix.casefold() in RECORDING_EXTENSIONS) != (
            destination.suffix.casefold() in RECORDING_EXTENSIONS
        ):
            raise ModuleConfigError("Rename must preserve recording/material kind")
        payload = _payload(module)
        if source.is_relative_to(module.paths.lecture):
            _change_references(
                payload,
                source.relative_to(module.paths.lecture).as_posix(),
                destination.relative_to(module.paths.lecture).as_posix(),
            )
        lecture_definitions(payload)
        source.rename(destination)
        try:
            _write_definitions(module, payload)
        except (OSError, ModuleConfigError):
            destination.rename(source)
            raise
        if source.parent == module.paths.questions:
            from exam_preparation import invalidate_exam
            invalidate_exam(module, source.name)
        return {"path": str(destination)}


def remove_file(module: ModuleConfig, path: str) -> dict[str, Any]:
    from library_trash import trash_file

    return trash_file(module, path)


# replace is an explicit desktop action, never an implicit overwrite.
def import_file(
    module: ModuleConfig,
    source_path: str,
    kind: str,
    name: str | None = None,
    *,
    replace: bool = False,
) -> dict[str, Any]:
    if not isinstance(replace, bool):
        raise ModuleConfigError("replace must be a boolean")
    if kind not in {"recording", "material", "question"}:
        raise ModuleConfigError("kind must be recording, material or question")
    source = Path(source_path).expanduser()
    if not source.is_file():
        raise ModuleConfigError(f"Import source not found: {source_path}")
    filename = _new_filename(name if name is not None else source.name)
    if (source.suffix.casefold() in RECORDING_EXTENSIONS) != (kind == "recording"):
        raise ModuleConfigError("Import source does not match the file kind")
    if (Path(filename).suffix.casefold() in RECORDING_EXTENSIONS) != (
        kind == "recording"
    ):
        raise ModuleConfigError("Import name does not match the file kind")
    from source_preparation import (
        MEDIA_CONVERSION_EXTENSIONS,
        SUPPORTED_UPLOAD_EXTENSIONS,
    )

    convert_media = (
        kind == "recording"
        and source.suffix.casefold()
        in MEDIA_CONVERSION_EXTENSIONS - SUPPORTED_UPLOAD_EXTENSIONS
    )
    if convert_media:
        filename = str(Path(filename).with_suffix(".m4a"))
    folder = module.paths.questions if kind == "question" else module.paths.lecture
    with module_activity(module), exclusive_file_lock(_lock_path(module)):
        destination = folder / filename
        if destination.exists() and not replace:
            raise ModuleConfigError(f"File already exists: {filename}; pass replace=true")
        if not destination.resolve().is_relative_to(
            folder.resolve()
        ) or not destination.resolve().is_relative_to(module.paths.root.resolve()):
            raise ModuleConfigError("Import destination escapes the module")
        descriptor, temporary = tempfile.mkstemp(dir=folder, suffix=destination.suffix)
        os.close(descriptor)
        try:
            if convert_media:
                from source_preparation import _convert_media

                _convert_media(source, Path(temporary))
            else:
                shutil.copyfile(source, temporary)
            os.replace(temporary, destination)
            if kind == "question":
                from exam_preparation import invalidate_exam
                invalidate_exam(module, filename)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {
            "path": str(destination),
            "kind": kind,
            "size_bytes": destination.stat().st_size,
        }


def list_module_files(module: ModuleConfig, refresh: bool = False) -> dict[str, Any]:
    from desktop_library import question_index_status
    from exam_index import load_index
    from exam_preparation import derived_exam_names, exam_file_status
    from remote_inventory import module_inventory
    indexed = {source["file"]: source["questions"] for source in load_index(module.paths.questions)["sources"]} \
        if question_index_status(module)["exam_index"] == "built" else {}
    derived = derived_exam_names(module)
    if not isinstance(refresh, bool):
        raise ModuleConfigError("refresh must be a boolean")
    inventory = module_inventory(module, "refresh" if refresh else "fresh")
    remote, warning = inventory.sources, inventory.warning
    remote_stems = {normalize_source_stem(source.title) for source in remote}
    recordings = [
        path
        for path in module.paths.lecture.rglob("*")
        if path.is_file() and path.suffix.casefold() in RECORDING_EXTENSIONS
    ]
    units = lecture_units(module, recordings)
    general = {lecture_file(module, name).resolve() for name in module.general_materials}
    files = []
    for folder in (module.paths.lecture, module.paths.questions):
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or (folder == module.paths.questions and ((path.parent == folder and path.name in derived) or path == folder / "exam-index.json" or path.name.startswith("."))):
                continue
            relative = path.relative_to(folder).as_posix()
            kind = (
                "question"
                if folder == module.paths.questions
                else (
                    "recording"
                    if path.suffix.casefold() in RECORDING_EXTENSIONS
                    else "material"
                )
            )
            owners = [
                {"id": unit.get("id"), "title": unit["title"], "origin": unit["origin"]}
                for unit in units
                if folder == module.paths.lecture
                and relative in unit["recording_sources"] + unit["materials"]
            ]
            exam = {}
            if kind == "question":
                exam = exam_file_status(module, path)
                index_name = path.name if path.suffix.casefold() in {".txt", ".md"} else path.name + ".txt"
                exam["indexed"] = index_name in indexed
                if index_name in indexed:
                    exam["question_count"] = indexed[index_name]
            files.append(
                {
                    "path": path.relative_to(module.paths.root).as_posix(),
                    "name": path.name,
                    "size_bytes": path.stat().st_size,
                    "kind": kind,
                    **exam,
                    **({"hidden": True} if kind == "recording" and folder == module.paths.lecture
                       and recording_filename_key(relative) in {recording_filename_key(name) for name in module.hidden_recordings} else {}),
                    "lectures": [] if path.resolve() in general else owners,
                    **({"general": True} if folder == module.paths.lecture and path.resolve() in general else {}),
                    "in_notebook": normalize_source_stem(path.name) in remote_stems
                    if inventory.available
                    else None,
                }
            )
    return {
        "module": module.module_id,
        "files": files,
        "remote_as_of": inventory.remote_as_of,
        **({"warning": warning} if warning else {}),
    }


def definition_signature(definition: LectureDefinition) -> dict[str, Any]:
    return {
        "id": definition.id,
        "title": definition.title,
        "recordings": list(definition.recordings),
        "materials": list(definition.materials),
        "created": definition.created,
        "updated": definition.updated,
    }
