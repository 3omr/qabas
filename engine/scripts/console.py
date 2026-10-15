#!/usr/bin/env python3
"""Console stream setup, shared by every entry point.

Essentially everything this tool prints is Egyptian Arabic, and every
transcript filename carries an emoji. On Windows ``sys.stdout`` defaults to the
ANSI code page (cp1252), which can encode neither, so the first progress line
raises ``UnicodeEncodeError`` and takes the run down before it has done
anything. ``sys.stdin`` has the same default, so a UTF-8 MCP request read from
a pipe decodes as cp1252 and an Arabic module name is saved as mojibake. POSIX
is already UTF-8 and is unaffected.

This lives in its own module because the launcher deliberately does not import
the engine at module scope -- it loads it dynamically -- so there was nowhere
cheap for both of them to share it.
"""

from __future__ import annotations

import sys
from typing import Any


def configure_console_streams() -> None:
    """Make stdin UTF-8, and stdout/stderr UTF-8 and line-buffered, before any I/O.

    Line buffering keeps progress visible while a long phase runs. Output uses
    ``errors="replace"``: a console that cannot render one glyph should cost
    that glyph, not the transcript. Input stays ``strict``: a replaced
    character in a request would be persisted into module data.
    """
    output: dict[str, Any] = {"encoding": "utf-8", "errors": "replace", "line_buffering": True}
    streams: tuple[tuple[object, dict[str, Any]], ...] = (
        (sys.stdin, {"encoding": "utf-8", "errors": "strict"}),
        (sys.stdout, output),
        (sys.stderr, output),
    )
    for stream, settings in streams:
        reconfigure = getattr(stream, "reconfigure", None)
        if not reconfigure:
            continue
        try:
            reconfigure(**settings)
        except (ValueError, OSError):
            # A redirected or already-detached stream may refuse
            # reconfiguration. Keeping its default settings is survivable;
            # crashing on startup is not.
            pass


__all__ = ["configure_console_streams"]
