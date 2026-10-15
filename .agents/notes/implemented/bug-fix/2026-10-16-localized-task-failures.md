# Agent Note: Failed tasks lead with Arabic and hide model instructions

Status: implemented

## Problem

After a lecture transcription failed with an ambiguous PDF source, the job card's Details panel showed the engine's long English error, including operational instructions written for the engine's model, such as tool names and suggested calls (#34). The lecture pipeline returns the first tool error as its failure `reason`, and engine tool errors combine the diagnostic with orchestrator guidance in one string. The card's summary was the generic "open its conversation" line, although engine pipeline jobs have no conversation.

## Decision

[`job-failure.ts`](../../../../packages/client/ui-library/src/client/job-failure.ts) classifies `Source '…' matches multiple … sources` as `source-ambiguous` and extracts the candidate files that the [same-stem source fix](2026-10-15-same-stem-lecture-sources.md) lists. `failureLine` takes the job's kind and session: an unrecognized failure points to the conversation only when the job has one, to Continue for a sessionless lecture job, and to retrying otherwise. `technicalDetails` keeps the diagnostic sentences of each line and drops sentences that call a snake_case tool, name call arguments or staged parts, or open with an orchestrator imperative; it caps the rest at 1200 characters. The tray and the Exams job strip show only that text under "Technical details" and omit the disclosure when nothing remains.

## Alternatives considered

**Split diagnostics from guidance in the engine.** Every engine tool error would need a structured diagnostic field, and the model-facing text must keep its guidance. Filtering at the display keeps model-visible tool results unchanged.

**Hide the engine text entirely.** Support and developers use the diagnostic to identify the failing file or check.

## Consequences

The filter is pattern-based: a new guidance phrasing that matches none of the patterns reaches Technical details until a pattern is added, and a diagnostic sentence that opens with one of the imperatives is hidden. Tray tests pin the classification, the next-step lines, the filtered text and a rendered card.
