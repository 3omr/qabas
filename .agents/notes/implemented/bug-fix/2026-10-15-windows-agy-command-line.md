# Agent Note: Windows agy command-line limit and failure causes

Status: implemented

English | [中文](2026-10-15-windows-agy-command-line.zh.md)

## Problem

On Windows, exam indexing of ordinary TXT question banks failed with `Could not run agy: [WinError 206] The filename or extension is too long`; one 17-paper import kept 2 indexed sources and 14 failures. [`agy_writer`](../../../../engine/scripts/agy_writer.py) passed the prompt and JSON schema in argv and moved the prompt into `prompt.md` only above 60,000 UTF-8 bytes. That threshold fits the Linux per-argument limit, but `CreateProcess` caps the whole Windows command line at 32,767 UTF-16 code units, and a 12,000-character exam batch rendered as JSON evidence with instructions and schema exceeds it. The Exams page then showed the generic "Couldn't read this paper" for a paper that was readable and whose model process never started.

## Decision

`_command_fits` measures the complete command. On Windows it renders the argv with `subprocess.list2cmdline` and compares its UTF-16 length with 32,766 code units, or 8,191 when the launcher is a `.bat` or `.cmd` file that `cmd.exe` re-reads. POSIX keeps the 60,000-byte prompt threshold. When the command does not fit, the prompt moves into `prompt.md` with the existing file-read instructions; the schema stays in argv. The limits are operating-system constants, not configuration.

Each [`failed_sources`](2026-10-10-exam-index-failure-isolation.md) record and each `failed` progress event carries `cause`: `source` when preparation or reading the file failed or the file changed during extraction or review (`SourceChangedError`, `OSError`), and `model` when the agy run, its output validation or the automatic review did not complete. Desktop inventory exposes the matching record's cause as `index_failure_cause`, and the Exams page shows "The AI model couldn't finish this paper. Check Antigravity, then retry." for `model`. Failures recorded before this change have no cause and keep the generic text.

## Alternatives considered

**Always use `prompt.md` on Windows.** Every small request would gain a file-read step, which the [Omar stdin note](../feature/2026-10-11-omar-stdin-streaming.md) measured at about 5 seconds per call.

**Send the prompt through stdin with `--input-format stream-json`.** This removes argv limits by construction but requires the engine to adopt the NDJSON response decoding that the chat provider owns; the engine's text and JSON response handling would change for every writer call.

**Lower the byte threshold for every platform.** A smaller fixed number would still be wrong for non-ASCII prompts, quoting overhead and batch-file launchers, and would add file reads on Linux without need.

## Consequences

Indexing batches that exceed the Windows limit cost one file-read step instead of failing. A schema that alone exceeds the limit still fails at launch with the operating-system error. Fake-process tests pin the exact argv/file boundary for `.exe` and `.cmd` launchers and the POSIX byte threshold; indexer, inventory, MCP progress, job and Exams view tests pin the recorded cause and its text. Native Windows launch of the installed agy still requires verification on Windows.
