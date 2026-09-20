---
description: "Shared browser reader for transcriber workspace modules and lecture classification, consumed by the Sidebar panel and composer choices."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-transcriber-workspace

English | [中文](README.zh.md)

## Summary

Browser consumers can read the transcriber workspace through one implementation of module discovery, lecture grouping, transcript matching, cached run folding, and NotebookLM merging. The Sidebar panel and composer-choice strip use this library so they offer the same lectures. It publishes the disk half first, adds the one-shot engine listing when requested, and never starts a run or writes a file.

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

### When to use it

Use this library when a browser surface needs the transcriber workspace's modules or lectures. Use the owning UI plugin for rendering and user actions; this package supplies the shared read and classification functions.

### Entry point

The root entry exports `createReadModules`, `lecturesOf`, `groupRecordings`, transcript matching, run folding, and their related types. Pass the session's `workspaceFiles` face and optional `transcriberEngine.listLectures` face to `createReadModules`. Its `onDisk` callback receives the immediate disk view, while the returned result contains the NotebookLM merge. Set `includeNotebook: false` for the run-progress tick and pass `previous` to retain remote-only rows; a warning becomes a failed NotebookLM status on the otherwise usable module view.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The reader recognizes the engine's `modules/<id>/module.json`, `Lecture/`, `Transcripts/`, `Questions/exam-index.json`, and run-cache layout. `lectures.ts` groups multipart recordings and marks transcript matches; `runs.ts` folds the newest append-only run; `workspace.ts` reads the disk view through the bounded Remote file service, then merges the engine's local and NotebookLM listing. A lecture with no local source has an empty `sources` array and cannot be offered as a file-based action.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-transcriber](../ui-transcriber/README.md) — renders modules, lecture status, and run progress in the Sidebar.
- [ui-transcriber-composer](../ui-transcriber-composer/README.md) — renders choices above the composer and writes Arabic requests into the draft.
- [Workspace file Remote](../../api/workspace-files/README.md) — supplies the read-only file face consumed here.

-----

<a id="model-experience"></a>
## Model Experience

None, as this library only reads browser workspace data and does not assemble or send model requests.

#### KV Cache effect

None; the library performs no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Workspace convention** — the reader follows the engine's fixed directory names and does not accept a configurable layout.
- **NotebookLM freshness** — the remote inventory is a one-shot request on initial load or explicit refresh; run-progress polling reads disk only, and a slow or failed inventory leaves the disk view visible with a status message.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
