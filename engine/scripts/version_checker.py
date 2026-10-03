"""Report the owning application's version without skill update checks."""

import json
from pathlib import Path


def get_current_version() -> str:
    """Read app metadata from the checkout or PyInstaller extraction directory."""
    directory = Path(__file__).resolve().parent
    for candidate in (directory / "package.json", directory.parent.parent / "package.json"):
        if candidate.is_file():
            return str(json.loads(candidate.read_text(encoding="utf-8"))["version"])
    return "0"


__version__ = get_current_version()
