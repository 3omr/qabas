# Agent Note: Exam coverage gaps retry

Status: implemented

## Problem

Exam extraction requires agy to list every required source unit in `covered_unit_ids` exactly once. One repeated or omitted id in a batch of hundreds of lines raised an ordinary `AgyExamIndexError`, which failed the whole paper without a retry. The Exams view then showed "The AI model couldn't finish this paper. Check Antigravity, then retry." even though Antigravity worked, and it hid the recorded `index_error`.

## Decision

[Exam extraction](../../../../engine/scripts/agy_exam_index.py) counts a unit as reviewed when `covered_unit_ids` lists it, including repeats, or when an extracted question's `unit_ids` cites it. Batch and whole-paper coverage use the same rule. Required units that remain unreviewed raise `BatchCapacityError`, so the batch is bisected and the skipped units return to agy in smaller groups; after one cached repair pass, a single-unit leaf that is still skipped fails its paper with `cause: invalid_output`.

The Exams view names a model failure without blaming Antigravity and shows the paper's `index_error` behind the existing details disclosure.

## Alternatives considered

**Accept skipped units without a retry.** A skipped unit may contain questions, so publishing the paper would silently drop them.

**Request only the skipped units.** Splitting already exists, saves validated halves, and reuses them on retry; a second partial-request path would duplicate that state handling.

## Consequences

A paper with coverage slips costs extra agy requests instead of failing. A paper that still fails shows the engine's diagnostic. Tests use fake agy responses.
