#!/usr/bin/env python3
"""Build and dispatch the engine's checkout and frozen entry points."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class EntryPoint:
    script_name: str
    module_name: str


# The first three are invoked by the MCP boundary or the desktop app. The
# pipeline worker is internal, but it must use the same executable in a frozen
# build because the launcher starts it once per audit/transcription.
ENTRYPOINTS = {
    "mcp-server": EntryPoint("mcp_server.py", "mcp_server"),
    "run-transcription": EntryPoint("run_transcription.py", "run_transcription"),
    "manage-modules": EntryPoint("manage_modules.py", "manage_modules"),
    "universal-transcribe": EntryPoint(
        "universal_transcribe.py", "universal_transcribe"
    ),
}


def _unknown_entrypoint_message(name: str) -> str:
    valid = ", ".join(ENTRYPOINTS)
    return f"Unknown engine subcommand {name!r}. Valid subcommands: {valid}"


def build_entrypoint_command(
    entrypoint: str,
    arguments: Sequence[str] = (),
    *,
    interpreter_options: Sequence[str] = (),
    script_path: Path | None = None,
) -> list[str]:
    """Build a command for an engine entry point in either runtime shape."""
    target = ENTRYPOINTS.get(entrypoint)
    if target is None:
        raise ValueError(_unknown_entrypoint_message(entrypoint))
    if getattr(sys, "frozen", False):
        # interpreter_options and script_path are both dropped, and both on
        # purpose. A frozen executable takes no interpreter argv, so `-u` is
        # said to the bootloader in transcriber-engine.spec instead; and the
        # script it would name is inside the executable, where a caller's path
        # could not point at anything else anyway.
        return [sys.executable, entrypoint, *arguments]
    checkout_path = script_path or Path(__file__).resolve().parent / target.script_name
    return [sys.executable, *interpreter_options, str(checkout_path), *arguments]


def _split_subcommand(
    arguments: Sequence[str], default_entrypoint: str
) -> tuple[str, list[str]]:
    forwarded = list(arguments)
    if not forwarded or forwarded[0].startswith("-"):
        return default_entrypoint, forwarded
    return forwarded[0], forwarded[1:]


def _invoke(handler: Callable[[], int], arguments: Sequence[str]) -> int:
    original_argv = sys.argv
    sys.argv = [original_argv[0], *arguments]
    try:
        return handler()
    finally:
        sys.argv = original_argv


def dispatch_entrypoint(
    arguments: Sequence[str],
    default_entrypoint: str,
    default_handler: Callable[[], int],
) -> int:
    """Run the selected entry point, preserving direct-script invocation."""
    if default_entrypoint not in ENTRYPOINTS:
        raise ValueError(_unknown_entrypoint_message(default_entrypoint))
    entrypoint, forwarded = _split_subcommand(arguments, default_entrypoint)
    target = ENTRYPOINTS.get(entrypoint)
    if target is None:
        print(_unknown_entrypoint_message(entrypoint), file=sys.stderr)
        return 2
    if entrypoint == default_entrypoint:
        return _invoke(default_handler, forwarded)
    module = importlib.import_module(target.module_name)
    return _invoke(module.main, forwarded)
