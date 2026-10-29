# Agent Note: Self-repairing exam index

Status: implemented

## Problem

Transient Antigravity failures can stop papers after successful extraction or review splits. Unusable PDF text can yield no supported questions. Character-only batching can ask one request to produce dozens of complete questions, causing long timeouts before capacity splitting begins.

## Decision

Extraction, malformed-response repair and review share validated retry and model settings. Transient failures retry the same batch with cancellable backoff; invalid model selection advances to the next configured model. Authentication and account quota stop uncached model work without retries and retain reported quota reset times. Capacity failures preserve deterministic splitting and per-paper timeout budgets.

Extraction batches observe both exam_index_batch_chars and exam_index_batch_questions, which defaults to 20. Deterministic numbered stems, including Arabic-Indic digits, and spreadsheet data rows estimate question count. Unnumbered papers retain character batching. Source units remain indivisible and neighbouring context retains five units on either side. Batches from one paper can run concurrently within exam_index_workers.

Review divides questions before requesting them, using its character budget and the smaller of exam_review_batch_questions and exam_index_batch_questions. Its effective default is 20 questions. Extraction, malformed-response repair and text or image review requests use exam_index_request_timeout_seconds, a validated positive integer defaulting to 240. The general writer timeout remains unchanged; original-page rendering retains its separate deadline.

Extraction cache records include the question budget and exact required/context unit layout. Changed layouts and records without layout metadata require re-extraction. Matching layouts retain completed payloads and capacity splits. Request timeout changes alone retain extraction payloads. Review cache identity includes its resolved settings.

One repair pass follows settled papers and reuses completed batches. Unusable PDF text receives one stronger Arabic/English OCR attempt in a separate owned text file; original documents and text remain intact. The OCR receipt is bound to unchanged original bytes and reused by later builds. Final failures expose stable causes, cumulative request attempts and the last error; new payloads identify their producing model.

A failed review publishes validated extraction as pending, without claiming reviewed occurrences. A later build retries unfinished review against cached extraction. Single filename years supply missing occurrence years, excluding scanner timestamps; printed years win. Indexing neither invents answers nor creates lecture links.

Host validation retains detailed failures and pending flags. Existing presentation categories remain compatible, while engine_phase exposes repairing and failure_cause retains the detailed progress reason.

## Alternatives considered

Manual retries retain avoidable interruptions. Re-extracting complete papers wastes validated payloads and quota. Dropping papers after review failure loses grounded questions. Unbounded retries delay account and source diagnostics indefinitely. Overwriting prepared text removes provenance evidence. Character-only batching poorly predicts response size, while waiting for timeouts before splitting delays large papers. Changing the general writer timeout would affect unrelated work.

## Consequences

Recovery is bounded and resumable. Pending questions remain searchable and source-verified without claiming completed review. OCR changes the source-unit fingerprint and requires extraction against the new receipt. Missing tools and exhausted accounts still need external action. Smaller batches increase request count while reducing requested output per call. Existing caches without layout metadata require one extraction rebuild.

Fake-writer tests cover fallback, retries, account stops, pending-review reuse, cached repair, OCR, cancellation, filename-year provenance, upfront extraction and review batching, same-paper concurrency, request deadlines and cache-layout invalidation. They do not establish live-provider speed, extraction accuracy or OCR quality on every scan.
