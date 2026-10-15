# Agent Note: UTF-8 engine standard input

Status: implemented

## Problem

On Windows, a Unicode module name entered in the desktop library was saved as mojibake (`CVS ØªØ¬Ø±Ø¨Ø©` for `CVS تجربة`) in `module.json`, the notebook title, and every UI surface. The Host writes MCP JSON-RPC requests to the engine as UTF-8. Python opens a piped `sys.stdin` with the ANSI code page (cp1252), and `configure_console_streams` reconfigured only stdout and stderr, so `mcp_server.py` decoded each request's UTF-8 bytes as cp1252 before `create_module` ran.

## Decision

`configure_console_streams` reconfigures `sys.stdin` to UTF-8 with `errors="strict"` before any I/O, next to the existing UTF-8, `errors="replace"`, line-buffered stdout and stderr. Input uses strict decoding because a replaced character in a request is persisted into module data; output keeps replacement because a lost glyph costs only display text. A stream that refuses reconfiguration keeps its defaults, as for the output streams.

## Alternatives considered

**Escape non-ASCII characters in the Host's JSON requests.** This fixes one client while every other stdio MCP client still sends UTF-8 that the engine misreads.

**Set `PYTHONUTF8=1` in the Host's engine environment.** The engine is also launched by other MCP clients and by the packaged executable, which do not share that environment.

## Consequences

Every engine entry point that calls `configure_console_streams` reads UTF-8 from a pipe on every platform. A client that sends non-UTF-8 bytes now fails the read instead of storing replaced characters. Unit tests pin the stdin settings and read an Arabic request through a cp1252 pipe. Module names saved as mojibake before this fix stay corrupted until the student renames them.
