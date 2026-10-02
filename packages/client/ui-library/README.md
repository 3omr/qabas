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

`jobConcurrency` is a positive integer (default `2`). Starting and waiting jobs occupy a slot; extra jobs start in FIFO order. `ctx.libraryJobs.jobs` exposes newest-first jobs, while `answer`, `open`, `cancel`, and `dismiss` operate on stable job ids. Job records persist in localStorage under `dsh.library.jobs`; live pending questions are re-observed after reload. Jobs retain their conversation feed through `sessions.watch` without selecting their session, releasing the retention at completion or runner disposal. Jobs submit and cancel before their session is selected, observe transcriber tool progress, and answer the same pending questions as the conversation composer.

Three pages: the front page (a card per module with its progress, and "waiting on you" — unfinished drafts, modules with lectures nobody started, notebooks that are not answering), a module page (lectures filtered by state, each with its next action, and the module's reference material), and a lecture page (a three-step stepper — the doctor's words, the draft, the transcript — its actions, and the files it has produced).

The lecture manager appears when the mounted transcriber Remote exposes all seven registry methods. Its adapter is registered with `library.provideEditing` as a Cordis effect and removed on disposal. The student can define ordered recordings and materials, import picked browser files, rename files, move them to trash, and upload selected recordings. Inventory paths stay module-relative; only `in_notebook: true` counts as present in NotebookLM, and shared files display their first owning lecture. Engine and transport failures become page errors; processing uploads remain unsuccessful until the engine reports readiness. Manual ids, origins, and material names survive lecture loading.

### Extending it

`ctx.library` is the seam for other plugins:

- `registerAction(action)` adds a button to module or lecture pages. Registering an existing id replaces it; this package's own actions queue background work on the `transcriber` preset through `ctx.libraryJobs`.
- `registerOpener(open)` decides where a workspace file opens. Until one is registered, file buttons are disabled.
- `state` is a snapshot store of the route and the workspace contents, so other surfaces can follow what the student is looking at.

The library contributes titles for its sixteen transcriber MCP tools through `ctx.toolTitles` when ui-tool is composed. Conversation rows reuse the job-step dictionary and show a lecture argument or a valid part/parts pair; manifest paths and draft content stay in the expandable generic details. Contributions follow the service dependency lifetime and use the active language, including the Arabic pack.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The engine is the authority on what a lecture is and how far along it is. The service reads `list_modules` and `list_lectures` through the transcriber-engine Remote, which is session-free; each read cancels an earlier read of the same thing, and an answer that arrives after it was superseded or after disposal is dropped. A lecture's state comes from the engine's `state` field; engines that predate it report only `transcribed`, which reads as finished or not started.

The front page reads every module so its cards can show progress; other pages read a module when it is first opened. A refresh keeps the last answer on screen while the new one is in flight.

Colours come from the theme: each lecture state has a `--qabas-state-*` token supplied by ui-brand-qabas, with a fallback to the base theme's state tokens.

</details>

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

The pages make no model requests. Job actions create a hidden session on the `transcriber` preset and send one Egyptian Arabic sentence naming the module and the lecture exactly as the engine lists them.

#### Token effect

Each job adds one user message containing the action and engine-listed names. Tool titles add no tokens.

#### KV Cache effect

The action message is recorded once at job submission. Tool-title contributions do not change request messages or their order.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Job records and concurrency accounting are local to the current browser client.
- Files open nowhere until a panel registers an opener.

-----

<a id="dev-note"></a>
### Dev Note

Every page is a pure function of the service's state; the panel only routes. Tests drive the pages with fixed workspaces and the service with a scripted engine.
