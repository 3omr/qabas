# Agent Note: Direct indexing of structured question workbooks

Status: implemented

English | [中文](2026-10-15-structured-workbook-index.zh.md)

## Problem

A spreadsheet question bank with one question per row and dedicated columns for the stem, options, answer, type, category and year still went through agy extraction in 12,000-character batches and then a second agy review pass. A 2,117-row CVS workbook needed 92 extraction batches and had produced 590 questions after 24 of them. Every model pass can also misread a value that the workbook already states in its own cell.

## Decision

[`spreadsheet_questions.py`](../../../../engine/scripts/spreadsheet_questions.py) recognises a worksheet from its first row: a question column (`Text`, `Question`, `Question text`, `Stem`), at least two option columns (`A`-`F`, optionally prefixed `Option` or `Choice`) and an answer column (`Correct`, `Answer`, `Correct answer`, `Correct option`, `Key`). Optional `Year`/`Exam year`, `Category`/`Topic`/`Subject`, `Explanation`/`Rationale` and `No`/`Number`/`#` columns fill the matching fields; other columns, including `Type`, are ignored. Headings compare case-insensitively after whitespace folding.

Worksheet row units keep their cells (coordinate, first-row heading, value) in `SourceUnit.cells`, excluded from equality and from the unit fingerprint, so prompts, cached batches and `units_sha256` are unchanged. When every required unit of a batch is a row of a recognised worksheet, `_batch_payload` builds the batch payload locally instead of requesting agy and passes it through the unchanged `_validate_batch`, so every stem, option, answer, year and topic is grounded against its row as model output is. The answer cell may hold a letter, `(b)`, `b.` or an option's exact text; the year cell must hold exactly one 20xx year. A row is flagged for review only when its answer cell names no option or its year cell is unreadable; an empty answer cell records `no_key`. Rows without question text produce no question. A paper whose batches were all mapped this way records `extractor: columns` and `review_status: done` and skips the [automatic review](2026-10-11-exam-question-review.md), which has no model reading to check. Any batch that includes another worksheet or format keeps [bounded agy extraction](2026-10-10-exam-index-bounded-extraction.md).

## Alternatives considered

**Parse the rendered row text back into cells.** A value containing ` | ` or a heading containing parentheses makes the split ambiguous; keeping the cells read from openpyxl removes the parsing.

**Map rows outside the batch pipeline.** A separate path would duplicate source records, progress, caching, publication and validation; producing the extractor payload reuses all of them.

**Keep the automatic review for mapped papers.** The review corrects model readings and OCR; mapped values are copied verbatim from cells, so a review could only add model risk and time.

## Consequences

A recognised workbook indexes without model requests and resumes deterministically; a synthetic 2,117-row, six-option bank (104 batches) was prepared in 0.5 s and indexed in 14 s on Linux. Workbooks with unrecognised headings, merged layouts or questions spread across rows keep model extraction. Multi-answer cells such as `A, C` are flagged rather than represented, because the index records one correct option. Tests pin heading and answer recognition, defect-only review flags, a 300-row multi-batch bank with no model or review call, resumption, and a worksheet that keeps agy extraction.
