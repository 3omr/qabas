"""Bounded, isolated library discovery for the desktop home page."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from module_registry import ModuleConfig, load_module, modules_root


def question_index_status(module: ModuleConfig) -> dict[str, Any]:
    index = module.paths.questions / "exam-index.json"
    files = [path for path in module.paths.questions.rglob("*")
             if path.is_file() and path != index and not path.name.startswith(".")]
    status = "missing"
    if index.is_file():
        status = "stale" if any(path.stat().st_mtime_ns > index.stat().st_mtime_ns for path in files) else "built"
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
