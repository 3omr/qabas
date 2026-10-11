# Agent Note: Automatic paper review and owner exam years

Status: implemented

English | [中文](2026-10-11-exam-question-review.zh.md)

## Problem

OCR can attach student marks to options, corrupt option labels, and duplicate printed question numbers. An absent official key or ambiguous student mark does not require a student to check the question. File names and scan dates can also misidentify a paper's exam year.

## Decision

Extraction remains OCR-first: prepared source units feed the existing grounded extractor. Each paper receives an automatic agy review after extraction validation and before publication. The review receives extracted questions and source text; image papers, unreadable PDFs and scanned PDFs (an image on most pages) also supply rendered pages through agy's file reader, because a scan's text layer is OCR; digital PDFs are reviewed from their text. Validated configuration bounds request text, question counts, page counts, image dimensions, and time. Capacity failures split question batches, retaining completed review responses for retry.

Cleanup cannot add content words unsupported by the extracted field or cited source units. A page-image reading may correct OCR misreadings in place when the correction keeps at least 75% character similarity; the OCR text stays on the occurrence as `source_stem` or `source_options`, and provenance accepts the correction only when that OCR text is grounded in the source units. Original source quotes and unit ids remain verbatim so cleanup does not replace the provenance receipt. Answers require an existing option and source evidence; page-image evidence retains its page and matching cached review decision. Unresolved answers use `uncertain` or `no_key` without requesting student review. Only illegible or truncated source defects retain `needs_review` and a concrete reason. Review failures publish validated extraction with `review_status: failed`; successful review responses are cached by source-unit hash, extracted-question hash, review prompt version, and resolved settings. The next unchanged build retries failed review without repeating extraction.

A model may skip questions in a batch; the review asks once more for only those, and any still missing keep their validated extraction. Paper reviews run on the extraction worker pool, and every state-file write holds one lock.

Owner years live in `Questions/.exam-year-overrides.json`, independently of generated extraction and review caches. `set_exam_year` accepts an original paper path and an integer from 1900 through 2100, `"bank"` for an undated question bank, or null to clear. A bank choice removes every occurrence year and records the source as a question bank, so transcripts badge its questions as bank questions. Index post-processing preserves extracted years and projects the override into every occurrence. Provenance verifies `year_source: owner` against the store, rather than claiming that the paper printed the year. Renaming moves the owner entry; trash retains it for restoration. Saving or clearing a year refreshes the existing index without an agy call.

Structured per-paper progress carries the phase, original filename, known question count, and extraction part counts alongside existing progress fields. API and editing adapters expose year changes and paper metadata; presentation remains owned by the views. The [engine reference](../../../../engine/README.md) owns configuration and storage details; [bounded extraction](2026-10-10-exam-index-bounded-extraction.md) owns extraction scheduling and publication.

## Alternatives considered

- Replacing OCR-first extraction with direct image extraction changes the source-unit authority and discards reusable validated extraction batches.
- Asking students to resolve missing keys confuses absent evidence with a damaged question and makes indexing depend on manual work.
- Saving owner years only in the generated index loses them on rebuild and cannot verify the owner's authority independently.
- Failing the paper when agy review is unavailable discards validated extraction that remains usable.

## Consequences

Automatic review adds model work on the first unchanged paper build. A model can misread a visible mark; text cleanup checks and recorded page evidence limit unsupported changes but do not prove visual interpretation. Durable owner metadata must remain separate from cache invalidation, and clearing must restore the extracted year rather than infer another owner value. Review failure is visible in file metadata and retryable independently of extraction.
