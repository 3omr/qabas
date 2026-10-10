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
    """Report published per-paper SHA matches independently of preparation and extractor age."""
    from exam_preparation import (
        derived_exam_names,
        exam_file_status,
        exam_source_files,
        sidecar_exam_names,
    )
    derived = derived_exam_names(module) | sidecar_exam_names(module)
    index = module.paths.questions / "exam-index.json"
    files = [path for path in module.paths.questions.rglob("*")
             if path.is_file() and path != index and (path.parent != module.paths.questions or path.name not in derived) and not path.name.startswith(".")]
    status = "missing"
    current_files = exam_source_files(module)
    prepared = {path: exam_file_status(module, path) for path in current_files}
    counts = {"indexed": 0, "failed": 0, "pending": len(current_files)}
    for item in prepared.values():
        item.update(indexed=False, index_failed=False)
    if index.is_file():
        from exam_index import LEGACY_SCHEMA_VERSION, SCHEMA_VERSION, load_index
        try:
            bank = load_index(module.paths.questions)
            if bank["schema_version"] not in {LEGACY_SCHEMA_VERSION, SCHEMA_VERSION} or bank["module"] != module.module_id:
                status = "stale"
            else:
                sources = {source["file"]: source for source in bank["sources"]}
                failures = {source["file"]: source for source in bank.get("failed_sources", [])}
                for path, item in prepared.items():
                    source = sources.get(path.name)
                    failure = failures.get(path.name)
                    if source is not None and source.get("sha256") == item.get("sha256") and item.get("sha256") is not None:
                        item.update(indexed=True, question_count=source["questions"],
                                    question_review_count=source.get("needs_review", 0),
                                    review_reasons=source.get("review_reasons", []))
                        counts["indexed"] += 1
                    elif source is not None and bank.get("extractor") != "agy" and "sha256" not in source:
                        item.update(index_legacy=True, question_count=source["questions"],
                                    question_review_count=source.get("needs_review", 0),
                                    review_reasons=source.get("review_reasons", []))
                    elif failure is not None and failure.get("sha256") == item.get("sha256") and item.get("sha256") is not None:
                        item.update(index_failed=True, index_error=failure["error"])
                        counts["failed"] += 1
                counts["pending"] -= counts["indexed"] + counts["failed"]
                status = ("legacy" if bank.get("extractor") != "agy" else
                          "built" if counts["indexed"] == len(current_files) else
                          "partial" if counts["indexed"] > 0 else "stale")
        except (ValueError, KeyError, TypeError):
            # A malformed generated index leaves original management available.
            status = "stale"
            counts = {"indexed": 0, "failed": 0, "pending": len(current_files)}
            for item in prepared.values():
                item.update(indexed=False, index_failed=False)
                for key in ("index_error", "index_legacy", "question_count", "question_review_count", "review_reasons"):
                    item.pop(key, None)
    if source_statuses is not None:
        source_statuses.update(prepared)
    return {"exam_index": status, "question_files": len(files), "question_index_counts": counts}


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
