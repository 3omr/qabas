#!/usr/bin/env python3
"""Prepare the app library before Host inventories and MCP startup."""

from __future__ import annotations

import argparse
from pathlib import Path

from console import configure_console_streams
from library_workspace import prepare_workspace, workspace_path


def main() -> int:
    """Create the selected workspace and adopt idle legacy modules, or fail visibly."""
    configure_console_streams()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=str(workspace_path()))
    arguments = parser.parse_args()
    prepare_workspace(Path(arguments.workspace))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
