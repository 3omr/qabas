---
description: "Egyptian Arabic composer strip for choosing a workspace module, lecture status, and a natural-language transcription or review request."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-transcriber-composer

English | [中文](README.zh.md)

## Summary

The Web GUI adds an Egyptian Arabic strip above the existing composer. A student chooses a module, sees each lecture as transcribed or waiting, and chooses transcription, draft review, source audit, or readiness checking. Each choice writes a natural Arabic sentence into the composer draft; it never sends the sentence or starts a tool operation. The strip reads the same workspace view as the Sidebar panel.

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

Mount this browser plugin beside `ui-transcriber` and `ui-conversation`. The strip reads the current session workspace and stays above the resident composer, so the user keeps the ordinary text box and Send button.

### The choices

The module selector lists workspace modules. The lecture selector includes the selected module's lectures and labels each one `متفرغة` or `مستنية التفريغ`. The action buttons prepare Egyptian Arabic requests such as `فرّغ محاضرة «Corrosives» من موديول «سموم».` and `راجع مصادر موديول «سموم» وقولي لو في حاجة ناقصة.`

### What a click does

A click calls the Conversation input action that replaces the draft text. It does not call `submit`, invoke a Remote operation, bypass confirmation, or start a transcription. The student reads or edits the sentence and presses Send through the existing composer path.

### Empty states and paths

An empty workspace says that no modules exist yet. A module with no recordings says to put them in its `Lecture` folder. Source paths are rendered with `dir="ltr"` inside the right-to-left strip, so Windows and Arabic paths remain readable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers one `conversation.input.dock` entry with a session-scoped store. Its injected read calls `createReadModules` from [dsh-client-transcriber-workspace](../transcriber-workspace/README.md), the static library also consumed by `ui-transcriber`; the two feature plugins do not import each other. The component derives the selected module and lecture from the store, builds one natural-language sentence, and calls `inputActions.setDraft` only.

The plugin registers Egyptian Arabic dictionaries for its strip and the Conversation keys used by the composer, then exposes `العربية (مصر)` as the active language contribution. Its strip root has `dir="rtl"`; every rendered source path has `dir="ltr"`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-transcriber](../ui-transcriber/README.md) — the Sidebar view and the shared lecture status source.
- [dsh-client-transcriber-workspace](../transcriber-workspace/README.md) — module reading and lecture classification.
- [ui-conversation](../ui-conversation/README.md) — the composer and its `conversation.input.dock` slot.

-----

<a id="model-experience"></a>
## Model Experience

None, as the strip changes only the unsent browser draft and does not assemble a model request.

#### KV Cache effect

None; no model request is made until the user sends through the existing composer.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Arabic locale ownership** — the plugin contributes the Egyptian Arabic language and the Conversation keys needed by the composer because the upstream Conversation package is outside this change's scope; other Conversation keys fall back to English.
- **Read-only choices** — the strip cannot start, monitor, or cancel a run; the chat request and its confirmation-gated tool path remain the only operation path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
