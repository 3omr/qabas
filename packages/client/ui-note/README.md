---
description: "Qabas note panel: transcripts and other workspace markdown opened in tabs and edited in place with an Obsidian-style live preview, callouts, figures and wikilinks, saved without ever overwriting a change made on disk."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-note

English | [中文](README.zh.md)

## Summary

The note panel is where a student reads and corrects a transcript. Files open in tabs; the active one is edited in CodeMirror with a live preview the way Obsidian draws it — the line under the cursor shows its markdown, every other line shows what it means: headings, emphasis, lists, Obsidian callouts, figures, `[[wikilinks]]`. A reading mode renders the whole note, an outline lists its headings, and edits save themselves.

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

Mount it after ui-library. It registers the `note` key in the layout's `main` slot and becomes the library's opener, so "open the transcript" on a lecture page opens the file here. `autosaveMs` (default 1200) is the idle time after an edit before it is saved.

- **Live preview.** Headings are sized, h2 carries a rule (a transcript's five sections are its h2s). Emphasis, code and link marks hide off the active line. Callouts `> [!type] Title` draw as tinted boxes in Obsidian's types (note, tip, important, warning, danger, question, example, quote…). `![alt](relative.png)` and `![[name.png]]` render the figure; `[[Note]]` and relative `.md` links open in a new tab.
- **Mixed direction.** Each line takes the direction of its first strong character, so an Egyptian Arabic explanation and an English drug list sit side by side correctly.
- **Reading mode** (`Ctrl/Cmd+E`), **outline**, **search** (`Ctrl/Cmd+F`, in the student's language), **word count**, **save** (`Ctrl/Cmd+S`, or automatically).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The preview is decoration only: a view plugin walks the markdown syntax tree over the visible ranges and adds line classes, mark classes, hidden ranges and widgets. Nothing rewrites the text, so what is saved is exactly what was typed and the engine reads ordinary markdown afterwards. Wikilinks are not markdown and are found by pattern on the same ranges. Quote decorations style their lines and still let their contents render, because a figure inside a callout is the usual case in a transcript.

Files come through the transcriber engine's session-free calls (`readFile`, `readFileBytes`, `writeFile`), confined to the study workspace. Every save carries the version the editor last read; the host refuses a stale one with a conflict, and the panel then offers "use the version on disk" or "keep my changes". A transcript is also the engine's file — finalize or a figure extraction can rewrite it while it is open — so nothing is ever overwritten silently. An edit typed while a save is in flight stays dirty and saves next.

Figures are fetched once per note relative to the note itself (a bare `![[name.png]]` also looks under `Figures/`) and kept as object URLs, revoked when the note closes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-library](../ui-library/README.md) — the pages that open notes through this panel.
- [transcriber-engine](../../api/transcriber-engine/README.md) — the session-free file calls and their workspace containment.
- [ui-brand-qabas](../ui-brand-qabas/README.md) — the palette the editor's colours come from.

-----

<a id="model-experience"></a>
## Model Experience

The panel makes no model requests; it edits files the transcriber produced.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Tables render as source; callouts do not fold yet; backlinks and a graph view are not drawn.

-----

<a id="dev-note"></a>
### Dev Note

The service owns open notes and saving and is tested against scripted files; the preview is tested in a real CodeMirror view under jsdom.
