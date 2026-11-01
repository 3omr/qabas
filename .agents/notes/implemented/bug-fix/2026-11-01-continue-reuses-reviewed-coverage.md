# Agent Note: Continue reuses reviewed coverage and runs once

Status: implemented

## Problem

Continue on the retained Addiction lecture never finished by itself. Each chat request waited about 40 minutes behind a hidden tray job: the browser restored a failed Continue job as queued on every page load, and that run held the lecture lease until it failed with an agy timeout, which the tray then showed as a dropped connection. When the chat run reached review, receipts written before review-time slide placement no longer matched the guide bytes, and a ledger saved before per-section coverage keys was not recognized. All four assessment sections were therefore reviewed again one after another, with requests of 65,000–104,000 characters that ran into the 600-second agy timeout. Validation then deduplicated two MCQs that review had saved separately, so it reported stale coverage and an uncertain Question Bank citation that review's badge repair never saw. The pipeline answered the document-wide stale finding, and a missing slide link after a failed placement plan, by rewriting guide parts with agy. Those rewrites dropped the slide links and invalidated Sections 2–5.

## Decision

The [job store](../../../../packages/client/ui-library/src/client/jobs.ts) keeps a failure settled by an engine outcome (`goalReached: false`) failed on restore; only failures without an engine outcome are queued again. A failed or stopped Start or Continue job shows as done once its lecture reads final with no draft. An `agy timed out after` failure has its own resumable tray reason instead of the network line.

[Coverage](../../../../engine/scripts/lecture_emphasis.py) treats a ledger without section keys as current when its whole-draft key matches the key such ledgers recorded, and records the section keys without a review. Stale sections are reviewed concurrently within `lecture_writer_workers`. Each finished section is saved to the ledger, and the first failure is raised after every section settles. A divisible review request that times out is reviewed again as two halves; an indivisible one fails.

[Review](../../../../engine/scripts/mcp_server.py) checks coverage on the assembled text. When the deduplication that validation and finalization apply merges questions, review adopts that merged, renumbered draft; its sections inherit coverage, and badge repair runs on the merged questions. Drafts without merges keep their staged bytes. Validation checks coverage against the saved draft that its own deduplication starts from. An accepted parts review rebinds every `assessment-N.json` receipt to the guide parts it saved. Finalize removes those receipts with the staged parts and keeps the emphasis ledger and topic cache.

[Placement](../../../../engine/scripts/figure_placement.py) raises from a plan request only for an offline, quota or sign-in interruption. Any other plan failure keeps the OCR matches and earlier plans, and review lists the remaining slides. The [pipeline](../../../../engine/scripts/lecture_pipeline.py) answers stale coverage and missing slide links by running review again, never by rewriting parts.

## Alternatives considered

**Raise the agy timeout or lower `emphasis_prompt_chars`.** A longer timeout only delays the same serial reviews. The prompt budget is part of the ledger fingerprint, so changing its default invalidates every saved ledger. Reusing valid reviews removes the requests.

**Exclude guide bytes from the assessment evidence key.** Sections 3–5 are written from the finished guide, so a real guide rewrite still has to invalidate them. Rebinding after an accepted review covers only edits that review made and accepted.

**Make the chat pipeline report into the tray, or drop restored failures entirely.** A shared run registry is a larger cross-process change. Dropping failures would lose recovery for jobs that a reload interrupted. Keeping engine-settled failures and settling them from library state fixes both observed symptoms.

**Deduplicate only during validation and accept stale findings.** The saved draft and the validated draft would keep differing, and a merged question's citation would never reach automatic repair.

## Consequences

On the live test library, Continue from the retained parts went from two failed 40-minute waits followed by repeated reviews to a finalized transcript 24 seconds after the pipeline call. No agy coverage request was made. The guide kept its four slide links (one listed as unmatched), MCQ 8's unconfirmed Question Bank badge was removed automatically, and the tray showed the earlier job as done. Regression tests cover the legacy ledger, concurrent section reviews with partial saves, timeout halving, coverage across deduplication, receipt survival after review edits, the stale-coverage and failed-placement pipeline paths, restore of engine-settled failures and settling from library state. A review that rebinds receipts trusts its own coverage check, so guide edits made outside review still invalidate Sections 2–5.
