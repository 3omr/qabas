---
description: "Shared browser reader for transcriber workspace modules and lecture classification, consumed by the Sidebar panel and composer choices."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-transcriber-workspace

English | [中文](README.zh.md)

## Summary

Browser consumers can read the transcriber workspace through one implementation of module discovery, lecture grouping, transcript matching, and cached run folding. The Sidebar panel and composer-choice strip use this library so they offer the same lectures. The library only reads through the supplied workspace-files Remote face and never starts a run or writes a file.

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

The root entry exports `createReadModules`, `lecturesOf`, `groupRecordings`, transcript matching, run folding, and their related types. Pass the session's `workspaceFiles.list` and `workspaceFiles.read` face to `createReadModules`; a successful result contains the same module and lecture view used by the Sidebar panel, while a Remote failure remains a failed result for the caller to present.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The reader recognizes the engine's `modules/<id>/module.json`, `Lecture/`, `Transcripts/`, and run-cache layout. `lectures.ts` groups multipart recordings and marks transcript matches; `runs.ts` folds the newest append-only run; `workspace.ts` reads both views through the bounded Remote file service. The lecture-grouping fixture remains shared with the transcriber panel tests and the Python engine cases.

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
