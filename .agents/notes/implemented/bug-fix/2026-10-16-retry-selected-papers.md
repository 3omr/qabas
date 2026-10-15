# Agent Note: Retry only the selected failed papers

Status: implemented

## Problem

A paper row's Retry question extraction called the module-wide `startIndex`, so retrying one failed paper re-extracted every failed paper in the module (#31). The engine build had no way to name papers: [`build_exam_index`](../../../../engine/scripts/run_transcription.py) prepares every original and re-extracts every paper that is not fully cached, which includes every recorded failure.

## Decision

`build_exam_index` accepts `papers`, the failed file names to retry. `_kept_failures` reads the published `failed_sources` and keeps each record whose file is not named and whose recorded SHA-256 still matches the file; those papers skip preparation and extraction and enter the build as recorded failures, so publication still accounts for every original. New, changed and cached papers are read as in a full build. The `build_exam_index` MCP tool exposes `papers`; omitting it retries every failure.

`streamExamIndex` takes a `TranscriberExamIndexRequest` with optional `papers`. A library target carries `papers`, the question-bank job persists them as `retryPapers`, prepares only unread papers it retries, and streams with them. The Exams row retry passes its paper; selection mode adds Retry failed for the chosen failed papers. The chat action's sentence names the papers when a target carries them.

## Alternatives considered

**Retry in the client by calling `prepare_exam_file` and filtering progress.** Extraction happens only in the engine build, so a client filter could hide other papers' work but not prevent it.

**Keep failures from `.exam-index-state.json`.** The state file is written at the end of a build; the published index is what the desktop inventory compares against file hashes, so keeping its records keeps the visible state unchanged.

## Consequences

Retrying one paper costs one paper's preparation and extraction, plus any new or changed papers. A published failure for an edited file is never kept. Engine tests pin the kept failure, the single extraction request and the changed-file case; MCP tests pin argument validation; job, adapter and Exams tests pin the client path.
