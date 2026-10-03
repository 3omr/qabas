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
from module_registry import (
    MODULE_ID_PATTERN,
    LectureDefinition,
    ModuleConfig,
    ModuleConfigError,
    general_materials,
    lecture_definitions,
    load_module,
    validated_materials,
)
from recording_grouping import _group_recordings
from source_naming import normalize_source_stem
from transcript_matching import RECORDING_EXTENSIONS, recording_filename_key


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _lock_path(module: ModuleConfig) -> Path:
    return module.paths.root / ".transcriber-cache" / "lecture-registry.lock"


def _payload(module: ModuleConfig) -> dict[str, Any]:
    return json.loads((module.paths.root / "module.json").read_text(encoding="utf-8"))


def _write_definitions(module: ModuleConfig, payload: dict[str, Any]) -> None:
    lecture_definitions(payload)
    general_materials(payload, module.paths.root)
    _atomic_write_json(module.paths.root / "module.json", payload)


def _relative_name(name: str) -> str:
    if not isinstance(name, str) or not name.strip() or "\\" in name or ":" in name:
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
    with exclusive_file_lock(_lock_path(module)):
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
    with exclusive_file_lock(_lock_path(module)):
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
    with exclusive_file_lock(_lock_path(module)):
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
    with exclusive_file_lock(_lock_path(module)):
        payload = _payload(module)
        definitions = payload.get("lectures", [])
        if not any(definition["id"] == id for definition in definitions):
            raise ModuleConfigError(f"Unknown lecture id: {id}")
        payload["lectures"] = [
            definition for definition in definitions if definition["id"] != id
        ]
        _write_definitions(module, payload)


def lecture_units(module: ModuleConfig, recordings: list[Path]) -> list[dict[str, Any]]:
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
    return units + _group_recordings(
        [path for path in recordings if recording_filename_key(path.name) not in consumed]
    )


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
    with exclusive_file_lock(_lock_path(module)):
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
        return {"path": str(destination)}


def remove_file(module: ModuleConfig, path: str) -> dict[str, Any]:
    with exclusive_file_lock(_lock_path(module)):
        source = _module_file(module, path)
        destination = (
            module.paths.root
            / ".transcriber-cache"
            / "trash"
            / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            / path
        )
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = _payload(module)
        if source.is_relative_to(module.paths.lecture):
            _change_references(
                payload, source.relative_to(module.paths.lecture).as_posix(), None
            )
        source.rename(destination)
        try:
            _write_definitions(module, payload)
        except (OSError, ModuleConfigError):
            destination.rename(source)
            raise
        return {"trash_path": str(destination)}


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
    with exclusive_file_lock(_lock_path(module)):
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
        finally:
            Path(temporary).unlink(missing_ok=True)
        return {
            "path": str(destination),
            "kind": kind,
            "size_bytes": destination.stat().st_size,
        }


def list_module_files(module: ModuleConfig, refresh: bool = False) -> dict[str, Any]:
    from remote_inventory import module_inventory

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
            if not path.is_file():
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
            files.append(
                {
                    "path": path.relative_to(module.paths.root).as_posix(),
                    "name": path.name,
                    "size_bytes": path.stat().st_size,
                    "kind": kind,
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
