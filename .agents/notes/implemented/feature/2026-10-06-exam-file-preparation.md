# Agent Note: Exam originals and per-file preparation

Status: implemented

English | [中文](2026-10-06-exam-file-preparation.zh.md)

## Problem

Exam uploads reach a text-only index before PDF extraction or OCR. An existing filename stops the batch, and a module with papers loses its addition control. Stale extracted text can survive original replacement or removal and supply incorrect exam evidence.

## Decision

The [library](../../../../packages/client/ui-library/README.md) opens exam management on a separate route with navigation back to the module. Original cards distinguish extraction readiness from current-index membership and display extracted occurrence and review counts. Indexed cards open a searchable, paginated viewer for that file, with original wording, options, printed answers and explanations, year and source location. Uploads retain originals, resolve duplicate names explicitly, and prepare each paper before indexing. Identical original hashes skip redundant imports; the other choices are replacement, a distinct copy, and skipping. Individual failures retain their diagnostics and do not stop later imports. Cancellation stops queued work; completed file writes and model-validated batches remain available for retry.

The [engine](../../../../engine/README.md) records the original hash and generated text filename outside the source folders. Derived text retains the complete original filename before its `.txt` suffix, preventing collisions between papers of different formats. Preparation reuses the existing conversion and OCR implementation, which can use agy image reading after local OCR fails. Index extraction asks agy to structure each original's questions and validates unit coverage, source wording, answer evidence and source years. XLSX rows and DOCX paragraphs or table rows retain direct locators; other supported formats use prepared page or line text. Each original's hash-keyed batches are saved in `.exam-index-state.json` and reused after cancellation or failure. The schema-versioned index deduplicates across papers but keeps each file's complete occurrence count, wording and locators. Provenance checks re-read source units and verify the original and prepared-content hashes before using a question. Generated text appears in provenance checks but stays out of the student's original-file inventory. File replacement, rename and trash invalidate owned text and the index. External deletion removes only recorded derived text. Invalidated indices remain stale until every current source is indexed. Schema-1 manual repairs are not carried because their index has no source fingerprints; later repairs carry only while the original and prepared-content fingerprints remain unchanged. Index publication holds the module edit lock and checks original readiness and hashes again. Original-byte comparison refuses cached readiness for a changed paper.

The whole-library, session-free workspace and reversible-removal decisions remain active. This extends the [whole-library note](2026-10-02-library-single-call-and-organization.md), without superseding its inventory, organization or cache ownership. Arabic dictionaries include the exam controls and the remaining feature namespaces; English fallback remains available for external additions. Product text preserves the same interpolation fields in each language.

## Alternatives considered

**Build immediately after copying PDFs.** The index reads text files and cannot infer the missing preparation step.

**Keep the regular-expression parser as the only extractor.** It loses workbook columns and misses questions that do not follow its line patterns; agy instead returns structured questions tied to the original file's units and source locators.

**Return every question in the lecture lookup response.** That lookup ranks for one lecture and is capped at 50; file review needs all occurrences, so it has a separate search and pagination request.

**Overwrite repeated filenames implicitly.** The new selection can be a different paper or an accidental repeat; original hashes and explicit choices preserve that distinction.

**Name every extraction after only the filename stem.** PDF and DOCX papers with the same stem collide with each other and with student-authored text.

**Run module-wide source synchronization.** Exam preparation does not authorize uploading unrelated lecture recordings or references to NotebookLM.

## Consequences

An unreadable or incompletely indexed required paper prevents a completed index, while successful imports, preparations and agy batches remain reusable. Schema-1 parser indexes are stale until agy rebuilds them. Existing local files appear without re-import. Cache metadata is validated before owned files are removed; malformed state fails explicitly. Conversion and OCR remain dependent on installed tools, and agy extraction can consume model quota. Native Windows installation and live authenticated reading need target-machine acceptance. Host and component tests cover duplicate choices, per-file question paging, partial failure, cancellation and retry; Python tests verify source-grounded extraction, resumable batches, original preservation, DOCX order, real PDF reading and removal invalidation. English and Arabic presentation and dictionary-field checks cover product copy.
