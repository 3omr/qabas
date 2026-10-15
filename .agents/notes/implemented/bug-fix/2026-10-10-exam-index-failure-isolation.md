# Agent Note: Exam index failure isolation

Status: implemented

## Problem

Arabic-Indic year evidence and individual ungrounded questions can abort a whole module index. A failed paper must not erase independently grounded papers or validated batches needed for retry.

## Decision

The [agy indexer](../../../../engine/scripts/agy_exam_index.py) normalizes comparisons with NFKC and the shared `exam_years.ARABIC_DIGITS` translation. Unverifiable years, metadata and answers are cleared and flagged for review. Section metadata retains the existing source-locator fallback or empty section. Invalid options are omitted; ungrounded stems, invalid question references or kinds, malformed questions and MCQs with fewer than two grounded options are dropped and counted. Batch coverage and question-list structure remain mandatory.

The [launcher](../../../../engine/scripts/run_transcription.py) prepares and indexes papers independently. Publication checks the complete original-file inventory and revalidates successful sources. Exit status is zero when at least one file is indexed. When none can be indexed the launcher exits one without publishing, so a previously published index keeps its bytes; the failures are still recorded in the state file. Cancellation propagates, and validated batches of failed files remain reusable.

The index adds optional top-level `failed_sources`, an array of `{file, sha256, error, cause}` records; unreadable originals have a null hash, and the [failure-cause note](2026-10-15-windows-agy-command-line.md) owns `cause`. Errors are plain English, whitespace-collapsed and limited to 500 characters. Successful source records add integer `dropped_questions` and `dropped_question_reasons`, a reason-to-count object. The state file adds the same `failed_sources` and counters under `indexed_sources`; raw batch payload records remain unchanged. Schema version 2 and the prompt version remain unchanged because these additions are optional and cached payloads undergo current validation. Loaders supply an empty failure list for older indices.

## Alternatives considered

**Abort on one imperfect question or paper.** A local provenance failure cannot justify losing independently grounded questions.

**Convert a damaged MCQ to a written question.** Dropping preserves its assessment kind and avoids inventing missing options. Raw batch payloads remain available for inspection.

**Discard every batch of a failed file.** Keeping validated batches avoids repeating completed work while retrying the unusable batch.

**Bump schema or prompt versions.** Optional diagnostics preserve existing required fields, and current validation rechecks cached payloads. Invalidating them would discard useful work.

## Consequences

Published indices can cover fewer papers than the module contains. Failures remain visible and retryable; retained questions with invalid fields need human review. Drop counts describe source occurrences before cross-paper merging. Cached omissions remain reproducible until the source changes or the corresponding batch cache is removed. Synthetic fake-agy tests cover digit evidence, unsupported years, question omissions, invalid options and metadata, recovery exhaustion, preparation failures, partial publication, CLI exit status and batch reuse after a later failure. No live model or student data is required.
