"""Bounded, isolated library discovery for the desktop home page."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from module_registry import ModuleConfig, load_module, modules_root


def question_index_status(
    module: ModuleConfig, source_statuses: dict[Path, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from exam_preparation import derived_exam_names, exam_file_status, exam_source_files
    derived = derived_exam_names(module)
    index = module.paths.questions / "exam-index.json"
    files = [path for path in module.paths.questions.rglob("*")
             if path.is_file() and path != index and (path.parent != module.paths.questions or path.name not in derived) and not path.name.startswith(".")]
    status = "missing"
    current_files = exam_source_files(module)
    prepared = ({path: exam_file_status(module, path) for path in current_files}
                if index.is_file() or source_statuses is not None else {})
    if source_statuses is not None:
        source_statuses.update(prepared)
    if index.is_file():
        from exam_index import SCHEMA_VERSION, load_index
        try:
            bank = load_index(module.paths.questions)
            indexed = {source["file"] for source in bank["sources"]}
            current = {path.name for path in current_files}
            fingerprint_mismatch = any(
                not isinstance(source.get("file"), str)
                or Path(source["file"]).name != source["file"]
                or source.get("sha256") != prepared.get(module.paths.questions / source["file"], {}).get("sha256")
                for source in bank["sources"]
            )
            status = "stale" if bank["schema_version"] != SCHEMA_VERSION or bank.get("extractor") != "agy" or bank["module"] != module.module_id or indexed != current or fingerprint_mismatch or any(
                item["preparation"] != "ready" for item in prepared.values()
            ) else "built"
        except (ValueError, KeyError, TypeError):
            # A malformed generated index is explicitly stale, leaving original management available.
            status = "stale"
    return {"exam_index": status, "question_files": len(files)}


def _library_module(
    root: Path, mode: str, listing: Callable[[Any, dict[str, Any]], dict[str, Any]]
) -> dict[str, Any]:
    payload: dict[str, Any] = {"module": root.name, "display_name": root.name,
                               "notebooks": [], "root": str(root)}
    try:
        module = load_module(root)
        payload.update(module=module.module_id, display_name=module.display_name,
                       notebooks=[reference.notebook_id or reference.title for reference in module.notebook.notebooks])
        payload.update(listing(module, {"_remote": mode}))
        payload.update(question_index_status(module))
    except Exception as error:  # One broken module must not hide the other modules.
        payload["error"] = str(error)
    return payload


def list_library(
    workspace: Path, mode: str, listing: Callable[[Any, dict[str, Any]], dict[str, Any]]
) -> dict[str, Any]:
    if mode not in {"cached", "refresh", "skip"}:
        raise ValueError("remote must be cached, refresh or skip")
    directory = modules_root(workspace, None)
    roots = sorted(path for path in directory.iterdir()
                   if path.is_dir() and not path.name.startswith(".") and (path / "module.json").is_file()) if directory.is_dir() else []
    with ThreadPoolExecutor(max_workers=4) as pool:
        modules = list(pool.map(lambda root: _library_module(root, mode, listing), roots))
    return {"workspace": str(workspace.resolve()), "modules": modules}
