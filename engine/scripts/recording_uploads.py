"""Upload the selected lecture recordings and wait for bounded NotebookLM readiness."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import nlm_client
import universal_transcribe as engine
from file_lock import exclusive_file_lock
from module_registry import ModuleConfig
from remote_inventory import invalidate, notebook_inventory
from source_naming import normalize_source_stem
from transcriber_models import LocalSource, NotebookTarget, RemoteSource, TranscriberError
from transcript_matching import RECORDING_EXTENSIONS

READY_TIMEOUT_SECONDS = 120
READY_POLL_SECONDS = 5


def recording_paths(module: ModuleConfig, files: Any) -> tuple[Path, ...]:
    if not isinstance(files, list) or not files:
        raise ValueError("files must be a non-empty list of recording paths.")
    paths: list[Path] = []
    for filename in files:
        if not isinstance(filename, str) or not filename.strip():
            raise ValueError("Every file must name an existing recording under Lecture/.")
        supplied = Path(filename.strip().replace("\\", "/"))
        path = supplied if supplied.is_absolute() else module.paths.root / supplied
        if not supplied.is_absolute() and supplied.parts[:1] != ("Lecture",):
            path = module.paths.lecture / supplied
        path = path.resolve()
        if not path.is_relative_to(module.paths.lecture.resolve()) or not path.is_file():
            raise ValueError(f"Recording must be an existing file under Lecture/: {filename}")
        if path.suffix.casefold() not in RECORDING_EXTENSIONS:
            raise ValueError(f"Not a recording: {filename}")
        if path not in paths:
            paths.append(path)
    return tuple(paths)


def notebook_connection(module: ModuleConfig) -> tuple[dict[str, Any], NotebookTarget]:
    config = nlm_client.load_config()
    if module.notebook.profile:
        config["nlm_profile"] = module.notebook.profile
    reference = module.notebook.notebooks[0]
    if not reference.notebook_id:
        return config, nlm_client.resolve_notebook(
            config, reference.title, module.display_name
        )
    return config, NotebookTarget(
        reference.notebook_id, reference.notebook_id,
        f"https://notebooklm.google.com/notebook/{reference.notebook_id}",
        reference.title or module.display_name,
    )


def matching_recordings(path: Path, sources: list[RemoteSource]) -> list[RemoteSource]:
    wanted = normalize_source_stem(path.name)
    return [
        source for source in sources
        if normalize_source_stem(source.title) == wanted
        and (source.source_type.casefold() in {"audio", "video"}
             or Path(source.title).suffix.casefold() in RECORDING_EXTENSIONS)
    ]


def file_details(path: Path) -> dict[str, Any]:
    size = path.stat().st_size
    return {"path": str(path), "name": path.name, "size_bytes": size,
            "size_mb": round(size / 1_000_000, 1)}


def fresh_sources(
    notebook: NotebookTarget, config: dict[str, Any], module: ModuleConfig
) -> list[RemoteSource]:
    inventory = notebook_inventory(module, notebook.notebook_uuid, config, "refresh")
    if inventory.warning:
        raise TranscriberError(inventory.warning)
    return inventory.sources


def wait_for_recording(
    source: LocalSource, notebook: NotebookTarget, config: dict[str, Any], module: ModuleConfig
) -> RemoteSource | None:
    deadline = min(time.monotonic() + READY_TIMEOUT_SECONDS, config.get("_recording_ready_deadline", float("inf")))
    while True:
        matches = matching_recordings(Path(source.path), fresh_sources(notebook, config, module))
        ready = next((remote for remote in matches if engine._remote_source_is_ready(remote)), None)
        if ready is not None:
            return ready
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(READY_POLL_SECONDS, remaining))


def upload_recording(
    path: Path, module: ModuleConfig, notebook: NotebookTarget, config: dict[str, Any]
) -> dict[str, Any]:
    inventory = notebook_inventory(module, notebook.notebook_uuid, config)
    if not inventory.available or inventory.warning:
        raise TranscriberError(inventory.warning or "NotebookLM inventory unavailable")
    matches = matching_recordings(path, inventory.sources)
    ready = next((remote for remote in matches if engine._remote_source_is_ready(remote)), None)
    if ready is not None:
        return {**file_details(path), "status": "already-uploaded", "source_id": ready.source_id, "ready": True}
    source = engine._local_source(str(path), str(module.paths.root), "Lecture")
    uploaded = not matches
    upload_error = ""
    if uploaded:
        try:
            engine._send_source_upload(config, notebook, source)
        except TranscriberError as error:
            # A CLI timeout can follow a successful add. Recheck instead of adding again.
            upload_error = str(error)
        finally:
            invalidate(module, notebook.notebook_uuid)
    try:
        ready = wait_for_recording(source, notebook, config, module)
    except TranscriberError as error:
        upload_error = str(error)
    if ready is None:
        return {
            **file_details(path), "status": "processing" if not upload_error else "not-ready",
            "message": "NotebookLM has not reported this recording ready within the timeout. "
            "Retry the same files to check readiness.",
            **({"error": upload_error} if upload_error else {}),
        }
    return {**file_details(path), "status": "uploaded" if uploaded else "already-uploaded",
            "source_id": ready.source_id, "ready": True}


def upload_recordings(module: ModuleConfig, files: Any) -> dict[str, Any]:
    paths = recording_paths(module, files)
    config, notebook = notebook_connection(module)
    reports = []
    lock = module.paths.root / ".transcriber-cache" / "recording-upload.lock"
    with exclusive_file_lock(lock):
        deadline = time.monotonic() + READY_TIMEOUT_SECONDS
        config["_recording_ready_deadline"] = deadline
        for path in paths:
            remaining = deadline - time.monotonic()
            if remaining <= 0 and READY_TIMEOUT_SECONDS > 0:
                reports.append({**file_details(path), "status": "processing", "message": "Recording upload readiness timeout; retry the same files."})
                continue
            config["_source_upload_wait_timeout"] = max(1, min(30, int(remaining)))
            try:
                reports.append(upload_recording(path, module, notebook, config))
            except (OSError, TranscriberError) as error:
                reports.append({**file_details(path), "status": "not-ready", "error": str(error)})
    return {"module": module.module_id, "notebook": {"id": notebook.notebook_uuid, "title": notebook.name},
            "status": "ready" if all(report.get("ready") for report in reports) else "processing", "files": reports}
