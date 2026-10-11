# Agent Note: Exams page and the question-bank job

Status: implemented

English | [中文](2026-10-11-exams-page-and-question-bank-job.zh.md)

## Problem

The exams page repeated the module header, explained itself in paragraphs, offered a search box, and showed file sizes, review counts, and year-mismatch sentences on every paper. Indexing ran inside the page, so leaving the page stopped it, and the module page ran a second copy of the same flow. A paper's questions showed section headers, line locators, and English review reasons, and nothing marked the answer.

## Decision

Library subpages share one `PageHeader`: the title, one short fact line, and the page actions; the breadcrumb above them is the only way back. The exams page lists one row per paper with its name, a year chip, and either its question count or its live phase. A read paper without a year shows a question-bank chip. The chip edits the paper year: a year, an undated question bank, or the detected year again. Selection for bulk trash is a mode behind the page menu.

Building the question bank is a `questions` library job. `LibraryJobs` reads every unread paper, streams the engine build without a conversation Session, and records each paper's phase (`queued`, `reading`, `extracting`, `reviewing`, `done`, `failed`) on the job. The exams page, the module page, and the jobs tray all read that job, so the work continues when the student leaves the page and Stop cancels the engine request. Engines without per-paper phases are read from their part counts and completion messages.

Lecture management is its own library route with the same header. A lecture row shows its title, recording and material counts as icons, and its state; expanding it lists its files, each removable from the lecture. Moving a file to the trash happens from the module's file list, not inside a lecture, and the lecture menu offers rename, subject moves and removal; the editor dialog opens only for a new lecture. The side panels scroll with the page. The module page has no overflow menu: rebuilding the question bank lives on the exams page, and the chat-based source audit is no longer offered there.

A paper's questions are cards: the number, year, and kind, the question, its options with the answer marked, a quiet note when no answer is known, and a collapsed explanation. Pages of ten are appended by Show more. Loading placeholders keep the shape of the rows and cards they replace.

## Alternatives considered

- Keeping indexing in the page loses the run when the student navigates away and leaves two copies of the flow to keep in step.
- A chat Session for indexing adds a model conversation to work the engine performs directly.

## Consequences

Indexing progress is persisted with the job, so a reload shows the last known paper phases; a job that was running when the page reloaded is ended as stopped and is started again by the student. Review-related counts and paper notes stay in the engine data but are no longer shown.
