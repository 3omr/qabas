# Agent Note: Qabas whole-library snapshots and engine organization

Status: implemented

English | [中文](2026-10-02-library-single-call-and-organization.zh.md)

## Problem

A library containing many modules pays for a Python process and notebook inventory per module before showing progress. Reloading the browser repeats that wait. Reviewed lecture organization and exam indexing need student-triggered engine calls without a chat Session.

## Decision

The [engine Remote](../../../../packages/api/transcriber-engine/README.md) reads the entire library once, validates each module inventory or isolated error, and preserves question-index status and notebook inventory timestamps. The [library](../../../../packages/client/ui-library/README.md) restores its last connected workspace from versioned browser storage, keyed by the engine workspace path, and marks it refreshing until the fresh cached-inventory answer arrives. Opening loaded contents performs no additional read; explicit refresh requests fresh remote inventories. Invalid or denied storage cannot block the engine. Module reads started during a whole-library refresh retain their newer contents.

Proposal, organization application, and exam indexing are optional editing callbacks, each enabled by its own mounted Remote method. Proposal ids become existing ids for review and write ids when the student applies definitions. Organization application passes explicit confirmation. Configurable operation deadlines terminate slow MCP calls; exam indexing preserves launcher text. Uploads invalidate only the affected module's notebook presence, and a completed index build updates that module's index status.

The Agy index retains filename-identified question banks even when they contain one exam year. It keeps an occurrence only when the original bytes and cited units still support the question, and keeps a year only when the source section or evidence supports it. A four-digit year returned as text is converted to an integer before the source-year check. An aggregate stem must match a verified occurrence unless a recorded hand repair cites that occurrence; text before the first page marker retains line locators. Large workbooks use small requests with adjacent row context so Agy can return a complete question list. Structured Agy responses may be fenced and followed by completion metadata; the parser keeps only the schema result. If Agy writes a source-unit id as a literal string replacement expression, the indexer applies that single replacement to the id and validates the result against source units. If the response remains invalid after that repair, the indexer retries once with the original source evidence; an invalid retry fails the batch and prevents publication. Agy explanations are kept only when their text appears verbatim in cited source units.

Starting a lecture authorizes the engine's automatic upload. The preset stops with one sentence naming a failed file and its reason if `begin_lecture` returns `needs_upload`; it offers no substitute transcription route. An agy writer response retains the single writer-tool instruction. Job progress reports uploaded recordings only from completed engine JSON containing a nonempty string array. Doctor preserves the optional agy entry and treats its null install command as manual, never executable.

This extends the [session-free workspace](2026-10-01-transcriber-library-workspace.md) and [lecture-manager](2026-10-02-lecture-manager-wiring.md) decisions; their path containment, intake, transcript-write, and cancellation obligations remain active. Neither note is fully superseded. Their directory is read-only in this workspace, so this pair uses the authorized temporary location.

The [exam-original preparation decision](2026-10-06-exam-file-preparation.md) extends index building with per-paper extraction and original-byte invalidation; the inventory and organization decisions remain active.

The [managed-library decision](2026-10-07-managed-library-workspace.md) fixes the library root and adds chat storage and immutable workspace presentation; inventory and organization remain owned here.

## Alternatives considered

**Per-module startup calls.** They multiply process startup and notebook inventory costs. That path remains available when the mounted Remote lacks the whole-library method.

**Fresh inventories on every navigation.** Cached inventories supply immediate progress; explicit refresh and notebook-changing operations request fresh presence.

**Parsing exam-index output as JSON.** The engine launcher prints a human-readable summary and target path. Preserving text avoids inventing result fields and lets engine failure remain a typed refusal.

## Consequences

The browser can briefly show the last connected workspace before the engine identifies its current workspace; a fresh answer replaces all module membership and contents. The cache contains metadata and file paths, not transcript text or credentials, and does not become engine authority. Module reloads use current exam status and counts; older Remotes without these fields preserve the last whole-library counts. Fake-MCP tests cover validation, confirmed writes, deadlines, and launcher text; service and adapter tests cover one-call loading, fallback, cached paint, storage failures, and module invalidation. Recorded Session events pin uploaded job progress. Real agy, NotebookLM, and exam OCR remain external integration checks.
