"""Workspace-owned engine preferences shared by MCP and desktop calls."""

from __future__ import annotations

import json
from pathlib import Path

from atomic_io import _atomic_write_json
from file_lock import exclusive_file_lock


def read_settings(workspace: Path) -> dict[str, bool]:
    """Read preferences; an absent file enables external illustrations."""
    path = workspace / ".qabas-engine-settings.json"
    if not path.exists():
        return {"web_figures": True}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or type(payload.get("web_figures")) is not bool:
        raise ValueError("Engine settings require a boolean web_figures")
    return {"web_figures": payload["web_figures"]}


def set_settings(workspace: Path, web_figures: bool) -> dict[str, bool]:
    """Persist the workspace switch atomically without changing other keys."""
    if type(web_figures) is not bool:
        raise ValueError("web_figures must be a boolean")
    path = workspace / ".qabas-engine-settings.json"
    with exclusive_file_lock(workspace / ".qabas-engine-settings.lock"):
        payload = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(payload, dict):
            raise ValueError("Engine settings must be an object")
        payload["web_figures"] = web_figures
        _atomic_write_json(path, payload)
    return {"web_figures": web_figures}
