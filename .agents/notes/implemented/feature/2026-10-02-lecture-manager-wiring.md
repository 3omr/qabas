# Agent Note: Session-free lecture manager engine edits

Status: implemented

English | [中文](2026-10-02-lecture-manager-wiring.zh.md)

## Problem

The library's lecture manager requires student-owned definitions and local file management without creating a chat Session. Browser-selected recordings are 15–70 MB and must reach the engine as Host paths, while failed imports must not leave staging files.

## Decision

The transcriber engine owns session-free registry Remotes. They validate engine JSON, propagate cancellation, preserve typed refusals, and pass `confirmed: true` for confirmed registry edits. Non-destructive module-wide source selection sends no confirmation flag. Module ids resolve to existing contained module roots; file arguments reject traversal. Manual lecture ids, origins, material names, and module question-bank status survive listing validation. This extends the [session-free workspace decision](./2026-10-01-transcriber-library-workspace.md) without replacing its inventory or transcript-write policy.

`setGeneralMaterials` saves paths relative to `Lecture/` through the engine rather than duplicating registry persistence in the Host. Empty selections are valid and remove selection metadata without deleting files. Optional general-source flags and arrays survive file, lecture, library, and organization validation without changing replies from engines that omit them. `applyOrganization` forwards an optional general-source array unchanged. `generalMaterialsTimeoutMs` bounds the selection call and defaults to five minutes; deadline, cancellation, engine refusal, and malformed-result errors retain the shared registry error codes.

Browser imports use canonical base64 over unary HTTP. Connection's default 300 MiB body cap carries a 70 MiB recording after base64 expansion. A configurable 128 MiB import cap bounds accepted contents; deployments must size the HTTP body cap for base64 and the RPC envelope. Exclusive owner-only OS staging preserves the original extension for engine conversion and is removed after success, engine refusal, or cancellation.

The library registers its editing adapter through a Cordis effect only when the full Remote method set exists. Engine file results become module-relative paths; inventory uses the first lecture owner and treats unknown notebook presence as false. Pending NotebookLM uploads produce page errors instead of completion counts.

## Alternatives considered

**Session-scoped attachment uploads.** These require a chat lifecycle and do not import into the selected engine module or update its lecture registry.

**Chunked registry intake.** The existing HTTP cap carries the supported recording sizes in one message. Upload ids and append/commit/abort state would add a retained Host lifecycle without a transport requirement.

**Direct browser file copies.** The Python registry owns media conversion, collision policy, reference updates, and trash moves; bypassing it would duplicate these rules.

**Attaching the shared selection to every lecture.** That duplicates module-wide metadata and turns one module edit into many lecture-definition edits. The engine owns a separate module-wide selection.

## Consequences

Imports retain the encoded browser file and decoded Host bytes in memory; they are bounded rather than streamed. Raising the import cap requires a compatible Connection body cap and sufficient memory. Engine cancellation cannot undo an already committed registry edit. Fake-MCP tests cover all methods, result validation, traversal refusals, staging cleanup, cancellation, and a 70 MiB import. Source-selection tests cover unchanged argument names, absence of confirmation, empty selections, optional-field preservation and rejection, organization forwarding, engine refusals, and bounded cancellation. A Loader composition pins the result and independently reads the persisted selection and unchanged source file. Client wrappers preserve both success and refusal results. Adapter and plugin tests cover mapping, failure outcomes, readiness, and effect disposal. No model request or Session event is produced; real NotebookLM uploads remain a manual integration check.
