---
description: "Qabas study library: the app's main panel and sidebar tree for a medical student's modules, lectures and their transcription progress, with extensible actions and file openers."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-library

English | [中文](README.zh.md)

## Summary

The library is where Qabas opens: a main panel showing every module in the study workspace, each module's lectures with how far each one has come, and the actions that move a lecture forward. A tree in the sidebar leads into the same pages. The conversation stays one click away, but it is no longer the first screen, and nothing on these pages needs a chat to be read.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it in the browser roster after ui-layout and ui-sidebar. It registers the `library` key in the layout's `main` slot, the matching `sidebar.panellist` row, and the module tree in `sidebar.library`. `startupPanel` (default `library`) chooses the panel the app opens on; `conversation` restores the previous behaviour.

`jobConcurrency` is a positive integer (default `2`). Starting and waiting jobs occupy a slot; extra jobs start in FIFO order. `ctx.libraryJobs.jobs` exposes newest-first jobs, while `answer`, `open`, `cancel`, and `dismiss` operate on stable job ids. Job records persist in localStorage under `dsh.library.jobs`; chat questions are re-observed after reload. Interrupted session-free runs restore as stopped; Continue resumes their engine stages. Session jobs retain their conversation feed through `sessions.watch` without selecting their session, releasing the retention at completion or runner disposal. Jobs submit and cancel before their session is selected, observe transcriber tool progress, and answer the same pending questions as the conversation composer.

Four pages: a front page with module progress and search, a module page with lecture actions, exam management and reference material, a lecture page with verbatim, draft and final transcript files, and a separate exam page with navigation back to its module.

The lecture manager appears when the mounted transcriber Remote exposes all seven registry methods. Its adapter is registered with `library.provideEditing` as a Cordis effect and removed on disposal. The student can define ordered recordings and materials, import picked browser files, rename files, move them to trash, and upload selected recordings. Inventory paths stay module-relative; only `in_notebook: true` counts as present in NotebookLM, and shared files display their first owning lecture. Engine and transport failures become page errors; processing uploads count as sent while the engine retains their readiness state. Manual ids, origins, and material names survive lecture loading.

Organization review, applying a reviewed proposal, and local exam indexing appear when their individual Remote methods are present. The job tray reports uploaded recordings only when a completed `begin_lecture` result names them in `uploaded`.

The editing data API offers optional `hideLecture(module, title)` and `restoreRecordings(module, names)` callbacks when their Remote methods exist. Each returns an `EditOutcome<readonly string[]>`; success carries the hidden or actually restored recording names. `ModuleFile.hidden` identifies retained hidden recordings. [Engine visibility semantics](../../api/transcriber-engine/README.md#student-owned-lectures-and-files) define listing and ownership behavior. Consumers reload the affected module after a successful edit.

The setup data API resolves the fixed home `Qabas Library` directory through `workspace()` and creates it on first use. No library folder selection is sent to the Host. `LibrarySetup` optionally exposes `removeModule(module)`, `restoreModule(trashId)`, and `listRemovedModules()`. Their `EditOutcome` values retain `module`, `trashId`, `displayName`, `removedAt`, and `notebookUntouched` where supplied. NotebookLM notebooks survive removal. Successful module changes require a whole-library reload.

`LectureEditing` optionally exposes `removeTranscript(module, title, kinds)`, `listTrash(module)`, and `restoreTrash(module, id)` when the corresponding Remotes exist. All return `EditOutcome`; removal and restoration carry `{ id, paths }`, and listing carries `{ id, removedAt, kind, label, paths }[]`. `kinds` selects `final`, `draft`, or `verbatim`. [Engine trash semantics](../../api/transcriber-engine/README.md#student-owned-lectures-and-files) define preservation, lock refusals and restoration conflicts. Consumers reload the module after a successful edit; the adapter adds no controls.

Pipeline messages identify the current step with a `<step>:` prefix. The tray uses step sentences for preparation, review and validation; only explicit writer-part checkpoints display part counts. The same mapping applies to deterministic pipeline frames and MCP chat progress. Fixed engine notes are localized, including an explicit notice when slide pictures could not be prepared and the transcript has none.

`jobFailureKind(message)` classifies daily-reset and exhausted-model diagnostics before busy or unavailable messages. `nextQuotaReset(now)` returns the next midnight in `America/Los_Angeles` as a `Date`, including daylight-saving changes; consumers format that instant in the student’s local timezone.

### Extending it

`ctx.library` is the seam for other plugins:

- `registerAction(action)` adds a button to module or lecture pages. Registering an existing id replaces it; this package's own actions queue background work through `ctx.libraryJobs`.
- `registerOpener(open)` decides where a workspace file opens. Until one is registered, file buttons are disabled.
- `state` is a snapshot store of the route and the workspace contents, so other surfaces can follow what the student is looking at.

The library contributes titles for its nineteen transcriber MCP tools through `ctx.toolTitles` when ui-tool is composed. Conversation rows reuse the job-step dictionary and show a lecture argument or a valid part/parts pair; manifest paths and draft content stay in the expandable generic details. Contributions follow the service dependency lifetime and use the active language, including the Arabic pack.

Lecture actions (`transcribe`, `redo`, `continue`) call the streamed `runLecturePipeline` Remote. Progress and repair steps keep the tray running. A finalized result marks the goal reached and finishes with repair/omission notes; exhausting a repair budget does not mark a job done. Network, spent quota, expired sign-in and missing-recording interruptions stop with a resumable reason; quota reset instants use the student's local time. Unexpected engine errors trigger at most `pipelineRetryLimit` automatic retained-content retries (integer 0–10, default 3), with exponential delays starting at `chatRepairCancelGraceMs` (default 30000): 30, 60 and 120 seconds by default. Retry counts and limits persist across reloads. Progress names the current step and retry attempt. Exhausting retries ends the job as stopped with `stop.kind: retry-limit` and the fixed note `Automatic retries stopped after repeated engine errors; your retained work is available through Continue.` The tray translates the note through `job.noteLine.retryLimit` and preserves the unexpected error's raw text in `job.error` details. Redo starts fresh; automatic retries use Continue to retain the new run's work. Reloaded sessionless lecture jobs resume with Continue. An absent or unavailable Remote uses the `transcriber` conversation; validation findings from an available engine stay in engine recovery. Legacy conversation recovery cancels the session and waits for its writes to stop before engine salvage; `chatRepairTimeoutMs` defaults to 300000. Cancellation aborts the owning request and disposal waits for teardown. Questions and audits use sessions. Restored lecture failures resume automatically unless finalized or interrupted by a student-owned stop.

`LibraryJob.progress` exposes the running transcriber call’s `{ done, total?, message? }` and updates for every projected progress checkpoint; a result or following call clears it. Successful transcriber results carrying `[SOURCE-WARNING]` lines persist those warnings in `note`, including nested calls; completion and cropped history retain them. A successful finalize in a lecture job’s session persists `goalReached: true`; a later model failure leaves `status: done` and appends its diagnostic to `note`, with no `error`. `jobFailureKind` returns `blocked` for prohibited-content, safety, and blocked-prompt diagnostics; the localized copy is available as `job.error.blocked`.

The module page always offers Manage exam papers. Each original card distinguishes extracted text from membership in the current completed index and shows its parsed question count when indexed. The exam board supports file drops, search, duplicate choices, rename, reversible removal and per-file preparation with retry. Successful imports survive another paper’s failure. Preparation reads papers before indexing; scanned documents can use OCR or agy reading. Generated text stays out of the original-file inventory. The library home filters modules by name or id.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The engine is the authority on what a lecture is and how far along it is. The service reads the whole workspace with one session-free `listLibrary({ remote: 'cached' })` call, falling back to `listModules` and per-module `listLectures` when that method is absent; each read cancels an earlier read of the same thing, and an answer that arrives after it was superseded or after disposal is dropped. A lecture's state comes from the engine's `state` field; engines that predate it report only `transcribed`, which reads as finished or not started.

The browser restores its last library snapshot immediately, marked refreshing, from versioned workspace-keyed storage. Invalid or unavailable storage does not block engine reads; a fresh answer replaces the cached workspace. Opening loaded modules makes no further read. The refresh button requests `remote: 'refresh'`. Student edits reload only their module, and notebook uploads force fresh presence. Question-index status and file counts come from the whole-library response.

Colours come from the theme: each lecture state has a `--qabas-state-*` token supplied by ui-brand-qabas, with a fallback to the base theme's state tokens.

</details>

**Runtime invariant:** No companion is published. The library store mirrors engine replies and owns no second runtime source to compare against; store and job transitions are asserted by behavior specs.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-brand-qabas](../ui-brand-qabas/README.md) — the palette, including the lecture-state tokens these pages draw with.
- [ui-sidebar](../ui-sidebar/README.md) — the `sidebar.library` seat the tree occupies.
- [ui-layout](../ui-layout/README.md) — the `main` slot and panel selection.

-----

<a id="model-experience"></a>
## Model Experience

### Job instructions

#### What the model sees

Lecture pipelines make no chat-model requests. Session fallback, questions and audits create a hidden session on the `transcriber` preset and send an Egyptian Arabic instruction naming the module and lecture. Available-engine validation findings do not create a chat session.

#### Token effect

Only session jobs add a user instruction. Deterministic runs spend writer calls through agy and add no chat tokens.

#### KV Cache effect

Session instructions are recorded once at submission. Pipeline progress adds no chat history or KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Job records and concurrency accounting are local to the current browser client.
- Files open nowhere until a panel registers an opener.

-----

<a id="dev-note"></a>
### Dev Note

Every page is a pure function of the service's state; the panel only routes. Tests drive the pages with fixed workspaces and the service with a scripted engine.
