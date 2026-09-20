---
description: "Shared transcriber recording, slide, and document format facts for the engine Host and browser workspace readers."
kind: "package-reference"
---

# @deepseek-ai/dsh-util-transcriber-formats

English | [中文](README.zh.md)

## Summary

The transcriber Host importer and browser workspace reader use one TypeScript copy of the engine's recording, slide, document, and extension rules. The Python engine remains the authority for runtime processing; this package keeps browser filtering and Host intake aligned with its published file formats.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----


-----

<a id="use-this-package"></a>
## Use this package

Import the format sets and `extensionOf` when a transcriber surface needs to classify a filename. Keep the recording set aligned with the engine's `RECORDING_EXTENSIONS`; do not create a local copy in a panel or Host operation.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; format facts neither assemble nor send a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Two runtimes** — the Python engine still declares its own native sets, so changes to the engine formats require updating this package and its consumers together.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. This package owns immutable format facts and no runtime state.
