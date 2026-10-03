"""Module-scoped NotebookLM inventories, shared across short-lived desktop calls."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import nlm_client
from atomic_io import _atomic_write_json
from file_lock import exclusive_file_lock
from module_registry import ModuleConfig
from transcriber_models import RemoteSource

TTL_SECONDS = 600


@dataclass(frozen=True)
class Inventory:
    sources: list[RemoteSource]
    remote_as_of: str | None
    warning: str | None = None
    available: bool = True


def _cache_path(module: ModuleConfig) -> Path:
    return module.paths.root / ".transcriber-cache" / "remote-sources.json"


def _entries(module: ModuleConfig) -> dict[str, Any]:
    try:
        payload = json.loads(_cache_path(module).read_text(encoding="utf-8"))
        entries = payload["notebooks"]
        return {identifier: entry for identifier, entry in entries.items() if isinstance(entry, dict)} if isinstance(entries, dict) else {}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def _cached(entry: Any) -> Inventory | None:
    try:
        stamp = entry["fetched_at"]
        if datetime.fromisoformat(stamp).tzinfo is None:
            return None
        return Inventory([RemoteSource(**source) for source in entry["sources"]], stamp)
    except (ValueError, KeyError, TypeError):
        return None


def notebook_inventory(
    module: ModuleConfig, notebook_id: str, config: dict[str, Any], mode: str = "fresh"
) -> Inventory:
    # Hold the lock through fetch to coalesce concurrent calls from separate processes.
    with exclusive_file_lock(_cache_path(module).with_suffix(".lock")):
        entries = _entries(module)
        entry = entries.get(notebook_id)
        cached = _cached(entry)
        if cached is not None:
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(cached.remote_as_of or "")).total_seconds()
            if mode in {"cached", "skip"} or (mode == "fresh" and not (entry or {}).get("invalidated") and 0 <= age < TTL_SECONDS):
                return cached
        if mode == "skip":
            return Inventory([], None, available=False)
        try:
            sources = nlm_client.list_remote_sources(notebook_id, {
                **config, "_inventory_cache_bypass": True, "_inventory_timeout": 30,
            })
        except (OSError, RuntimeError) as error:
            warning = f"Could not read NotebookLM inventory: {error}"
            if cached is not None:
                return Inventory(cached.sources, cached.remote_as_of, warning + "; using last cached inventory.")
            return Inventory([], None, warning, available=False)
        stamp = datetime.now(timezone.utc).isoformat()
        entries[notebook_id] = {"fetched_at": stamp, "sources": [asdict(source) for source in sources]}
        try:
            _atomic_write_json(_cache_path(module), {"notebooks": entries})
        except OSError as error:
            return Inventory(sources, stamp, f"Could not persist NotebookLM inventory: {error}")
        return Inventory(sources, stamp)


def module_inventory(module: ModuleConfig, mode: str = "fresh", config: dict[str, Any] | None = None) -> Inventory:
    config = {**nlm_client.load_config(), **(config or {})}
    if module.notebook.profile:
        config["nlm_profile"] = module.notebook.profile
    inventories = [
        notebook_inventory(module, reference.notebook_id, config, mode)
        for reference in module.notebook.notebooks if reference.notebook_id
    ]
    warnings = [inventory.warning for inventory in inventories if inventory.warning]
    stamps = [inventory.remote_as_of for inventory in inventories if inventory.remote_as_of]
    available = bool(inventories) and all(inventory.available for inventory in inventories)
    return Inventory(
        [source for inventory in inventories for source in inventory.sources],
        min(stamps) if stamps and available else None,
        " ".join(warnings) or None, available,
    )


def invalidate(module: ModuleConfig, notebook_id: str | None = None) -> None:
    # Keep the last good sources for offline recovery, but expire their freshness.
    with exclusive_file_lock(_cache_path(module).with_suffix(".lock")):
        entries = _entries(module)
        for identifier, entry in entries.items():
            if notebook_id is None or notebook_id == identifier:
                entry["invalidated"] = True
        _atomic_write_json(_cache_path(module), {"notebooks": entries})
