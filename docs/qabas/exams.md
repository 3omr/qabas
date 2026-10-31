---
description: "Qabas exams and question index: current Qabas controls, saved data, recovery and limitations."
---

# Qabas exams and question index

## Summary

Exam management stores original papers and builds a searchable question index for the module. Paper preparation, question extraction and answer review are separate operations. A readable paper or a nonzero question count does not establish that every paper and answer has completed review.

## Table of Contents

- [Entry points and papers](#entry-points-and-papers)
- [Years and question view](#years-and-question-view)
- [Build update and retry](#build-update-and-retry)
- [Failures and limitations](#failures-and-limitations)
- [Dev Note](#dev-note)

## Entry points and papers

Open a module, then exam management. Add exam files with the picker or drag-and-drop; the page accepts PDF, text, Office and common image formats. Conflicting names offer skip, replace or save a copy. Paper menus provide rename, year selection and removal; multiple selection supports batch actions. Removal currently sends papers to [Trash](trash.md), a limitation tracked in [#59](https://github.com/3omr/qabas/issues/59).

Originals live at any depth under `Questions/`; hidden files, hidden directories and engine-derived files are excluded. Each paper keeps its path relative to `Questions/` as its identity, so `ENDS/Final 25.pdf` and `Finals/Final 25.pdf` remain separate. Top-level papers keep their bare names. Folder names do not supply exam years.

Automatic preparation extracts searchable text and can use conversion, OCR and bounded model-assisted reading; it does not rewrite the original document. Owned derived files use the original full name plus `.txt`, with fingerprints and preparation results in `.transcriber-cache/exam-texts.json`.

A sibling named exactly `<existing paper name>.txt` is derived text and is excluded as a separate paper. Without an ownership receipt, preparation moves its bytes into `.transcriber-cache/exam-text-backups/` and records the module-relative backup path as `preserved_text` in the preparation receipt before generating fresh text. Each backup has a `receipt.json` recording its original paper and retained path; rename and trash also preserve unowned derived siblings there, so they cannot become separate papers after the original moves. Same-stem legacy text can supply fallback evidence after reading fails; it is excluded as a duplicate source, but is not automatically deleted. See [exam preparation](../../engine/scripts/exam_preparation.py) and the [exam view](../../packages/client/ui-library/src/client/views/Exams.tsx).

## Years and question view

A paper can have an owner-selected year from 1900 through 2100, be marked as a question bank without a year, or return to automatic year detection. `Questions/.exam-year-overrides.json` stores the selection; the engine updates a published index when setting it. [Year handling](../../engine/scripts/exam_year_overrides.py) distinguishes owner selection from inferred evidence.

A single filename year names the paper: `End 2021.pdf`, `Final 25.pdf` and `فاينال توكسو ٢٠٢٤.pdf` give 2021, 2025 and 2024 with occurrence `year_source: file_name`, even when the paper prints another exam date; the printed date only adds a review reason. A compiled file with labelled year sections such as `--- Final 2023 ---` keeps each section's year. Without a filename year, a year printed in the paper applies. Scanner timestamps, dates with day/month parts and pagination do not supply exam years. Undated question banks keep no year; duplicate questions retain the years of their source occurrences.

The paper's question action opens paginated indexed questions. MCQs show options and the marked answer; written questions show a saved answer when available, and explanations expand separately. Questions without an answer key retain a null answer and `answer_status: no_key`; indexing does not invent answers or link questions to lectures. This screen reads indexed output rather than running OCR on demand; a paper without published questions needs preparation/indexing or retry. [Question presentation](../../packages/client/ui-library/src/client/views/ExamQuestions.tsx) owns the display.

The paper header can disagree with an owner-selected year even though overrides already exist in the engine ([#55](https://github.com/3omr/qabas/issues/55)). The exact stale-read cause is not established by source inspection alone; do not treat the displayed year as proof that the override was discarded.

## Build update and retry

The module index prompt or exam-page build/update control starts a background question-bank job; the page can stop it or retry named failed papers. Preparation errors that identify missing local reading tools can trigger the existing installer and a bounded paper retry. Authentication failures offer Accounts and tools. The [preparation helper](../../packages/client/ui-library/src/client/prepare-exam.ts) and [job controller](../../packages/client/ui-library/src/client/jobs.ts) define this behavior.

Extraction sizes batches by both source characters and detectable question starts; extraction and review default to 20 questions per request. Numbered stems, including Arabic-Indic digits, and spreadsheet data rows supply the count; unnumbered text keeps character batching. Batches from the same paper run concurrently in the shared worker pool. Answer review follows extraction and may inspect paper images. Extraction, malformed-response repair and review requests default to a 240-second timeout; capacity failures retain splitting and the per-paper timeout budget. The engine’s [batch and request settings](../../engine/README.md) configure these limits. Cached extraction is reused only for the same source units and batch layout; older records without layout metadata are re-extracted. Successful source results can be published incrementally. Fingerprints allow unchanged successful work to be reused, while failed-paper retries retain failures for papers not selected. `Questions/exam-index.json` stores questions, source occurrences, review information and failures; `Questions/.exam-index-build.lock` coordinates builds. Extraction/review checkpoints use `Questions/.exam-index-state.json`. See [extraction and scheduling](../../engine/scripts/agy_exam_index.py), [answer review](../../engine/scripts/exam_question_review.py) and [index publication](../../engine/scripts/run_transcription.py).

Transient extraction and review errors retry the same batch automatically with cancellable backoff. Unknown model selection tries the next configured model. After all papers settle, one separate `repairing` phase reruns failed transient or capacity work while reusing completed batches. The engine’s [retry settings](../../engine/README.md) define model order, retry limits and delays. Sign-in and account quota stop model work without retry, retaining a reported quota reset time.

A failed review publishes validated extraction as `review_status: pending`, with `review_pending` and the review error. Pending questions remain searchable and source-verified without being labelled reviewed; the next build retries review without re-extraction. Unusable PDF text gets one stronger Arabic/English OCR attempt. Hidden engine-owned repaired text sits beside the retained original text; missing OCR tools yield `source_ocr_unavailable`.

Inventory distinguishes missing, stale, partial, built and legacy indexes. Matching originals receive per-paper indexed counts or failure details. A built inventory status concerns source fingerprints and must not be read as a guarantee that no answer review failed. [Inventory status](../../engine/scripts/desktop_library.py) owns these distinctions.

## Failures and limitations

Papers are reported failed after automatic repair is exhausted or an account/source interruption prevents it. `failed_sources` includes each paper’s stable cause, attempt count and last error; causes distinguish sign-in, quota, unreadable sources, missing OCR tools, unavailable models, timeouts and invalid output. Retained work remains available for a later retry after the underlying account or source problem is resolved. Inspect failed-paper and review information as well as totals. Browser reload can cancel an index request, and extraction checkpoints do not imply the paper was published before review returned ([#52](https://github.com/3omr/qabas/issues/52)). The tray can call a partial result done and can misclassify provider quota failures ([#61](https://github.com/3omr/qabas/issues/61)).

The scheduler submits extraction ahead of review work in the shared pool, and progress can remain unchanged during long model calls. CLI invocation does not establish isolation from unrelated global MCP services. Faster complete builds and more useful progress are tracked in [#60](https://github.com/3omr/qabas/issues/60); the proposal's timing targets are not current guarantees. Cache refresh can retain stale counts after index removal ([#53](https://github.com/3omr/qabas/issues/53)).

Legacy and owned text artifacts can coexist; preserved derived siblings remain recoverable through their backup receipts. A persistent lock file can retain dead-holder diagnostics: its presence alone does not prove an active OS lock and is not a reason to delete it. Sidecar reconciliation is tracked in [#68](https://github.com/3omr/qabas/issues/68) and lock diagnostics in [#69](https://github.com/3omr/qabas/issues/69). [Sidecar ownership](../../engine/scripts/exam_preparation.py) and [locking](../../engine/scripts/file_lock.py) define the existing safeguards.

## Dev Note

None.
