"""The app-owned library location shared by the Python entry points."""

from __future__ import annotations

import os
from pathlib import Path


def workspace_path() -> Path:
    """Developer override or the current user's Qabas Library, independent of cwd."""
    supplied = os.environ.get("TRANSCRIBER_WORKSPACE", "").strip()
    return Path(supplied).expanduser().resolve() if supplied else (Path.home() / "Qabas Library").resolve()


def prepare_workspace(path: Path) -> Path:
    """Create the library and modules directory on first use; reject occupied files."""
    path = path.expanduser().resolve()
    (path / "modules").mkdir(parents=True, exist_ok=True)
    return path
