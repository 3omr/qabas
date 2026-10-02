# Agent Note: Qabas whole-library snapshots and engine organization

Status: implemented

English | [中文](2026-10-02-library-single-call-and-organization.zh.md)

## Problem

A library containing many modules pays for a Python process and notebook inventory per module before showing progress. Reloading the browser repeats that wait. Reviewed lecture organization and exam indexing need student-triggered engine calls without a chat Session.

## Decision

The [engine Remote](../../../../packages/api/transcriber-engine/README.md) reads the entire library once, validates each module inventory or isolated error, and preserves question-index status and notebook inventory timestamps. The [library](../../../../packages/client/ui-library/README.md) restores its last connected workspace from versioned browser storage, keyed by the engine workspace path, and marks it refreshing until the fresh cached-inventory answer arrives. Opening loaded contents performs no additional read; explicit refresh requests fresh remote inventories. Invalid or denied storage cannot block the engine. Module reads started during a whole-library refresh retain their newer contents.

Proposal, organization application, and exam indexing are optional editing callbacks, each enabled by its own mounted Remote method. Proposal ids become existing ids for review and write ids when the student applies definitions. Organization application passes explicit confirmation. Configurable operation deadlines terminate slow MCP calls; exam indexing preserves launcher text. Uploads invalidate only the affected module's notebook presence, and a completed index build updates that module's index status.

Starting a lecture authorizes the engine's automatic upload. The preset stops with one sentence naming a failed file and its reason if `begin_lecture` returns `needs_upload`; it offers no substitute transcription route. An agy writer response retains the single writer-tool instruction. Job progress reports uploaded recordings only from completed engine JSON containing a nonempty string array. Doctor preserves the optional agy entry and treats its null install command as manual, never executable.

This extends the [session-free workspace](2026-10-01-transcriber-library-workspace.md) and [lecture-manager](2026-10-02-lecture-manager-wiring.md) decisions; their path containment, intake, transcript-write, and cancellation obligations remain active. Neither note is fully superseded. Their directory is read-only in this workspace, so this pair uses the authorized temporary location.

## Alternatives considered

**Per-module startup calls.** They multiply process startup and notebook inventory costs. That path remains available when the mounted Remote lacks the whole-library method.

**Fresh inventories on every navigation.** Cached inventories supply immediate progress; explicit refresh and notebook-changing operations request fresh presence.

**Parsing exam-index output as JSON.** The engine launcher prints a human-readable summary and target path. Preserving text avoids inventing result fields and lets engine failure remain a typed refusal.

## Consequences

The browser can briefly show the last connected workspace before the engine identifies its current workspace; a fresh answer replaces all module membership and contents. The cache contains metadata and file paths, not transcript text or credentials, and does not become engine authority. Module reloads preserve question counts until a whole-library read supplies current counts. Fake-MCP tests cover validation, confirmed writes, deadlines, and launcher text; service and adapter tests cover one-call loading, fallback, cached paint, storage failures, and module invalidation. Recorded Session events pin uploaded job progress. Real agy, NotebookLM, and exam OCR remain external integration checks.
