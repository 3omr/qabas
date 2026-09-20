---
description: "Qabas brand occupants for the sidebar and the blank-session hero, drawn as outlines so no Arabic font is required; for maintainers changing the app's identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-qabas

English | [中文](README.zh.md)

## Summary

This package gives the app its own identity: the قَبَس wordmark in the sidebar, in the collapsed rail, and on the blank-session hero in place of the harness's animated fish. The brand is the whole name rather than an initial, so the mark slot carries the wordmark and the name slot beside it renders nothing. The wordmark is checked-in path geometry rather than text in a font, so it renders identically on a machine with no Arabic font installed. It has no runtime state and does not affect model requests.

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

Mount this plugin in the browser roster. It registers unconditionally, where `ui-brand-official` gates itself behind the `official` client build profile: this is a product rather than a build of the harness, so there is no configuration in which the upstream brand should appear.

Three slots are filled: `sidebar.brand.mark` and `conversation.hero.brand.mark` with the wordmark, and `sidebar.brand.name` with nothing — the mark beside it already is the name, and leaving that slot empty is what keeps its generic "DSH Local Build" fallback from appearing. The hero slot matters more than its size suggests: its fallback is the first thing a new user sees.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### The name

«قَبَس» is a quotation: a borrowing of someone's exact words. That is what the product does with a lecture — it takes back what the doctor actually said and builds the study material from that, rather than from a paraphrase of it. The name is the product's claim about itself, which is why the marks are drawn rather than typed.

### Why outlines and not a font

The letterforms are Reem Kufi, shaped with HarfBuzz and converted to SVG paths, then checked in as geometry.

A desktop application cannot assume a font is installed, and an Arabic wordmark that falls back to a system face is not a degraded wordmark — it is different letters, with the contextual forms and the two fatḥas resolved by whatever face happened to answer. Paths have no such failure mode, and they carry no font file, no license to ship, and no load to wait for.

### Colour

Every path is `fill="currentColor"`, so both marks take the surrounding theme. There is no light copy and no dark copy to keep in step.

### How the geometry was produced

Reem Kufi (SIL OFL) at weight 600, shaped as a single text run so the contextual forms and the mark positioning are the font's own rather than a per-glyph approximation, then emitted as paths. The font file is not a dependency of this package and is not shipped.

-----

<a id="further-exploration"></a>
## Further Exploration

- [`ui-brand-official/`](../ui-brand-official/README.md) — the upstream occupants this replaces, and the profile gate it uses.
- [`ui-sidebar/`](../ui-sidebar/README.md) — declares the two sidebar brand slots and their fallbacks.
- [`ui-conversation/`](../ui-conversation/README.md) — declares the blank-session hero mark slot.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; brand presentation neither assembles nor sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The marks are geometry, so changing them is a rebuild.** Editing the wordmark means re-shaping the text and regenerating the paths, not changing a string. That is the cost of not depending on a font, and it is paid rarely.
- **No monochrome-on-colour variant.** Both marks assume they sit on the page background and take `currentColor`. A surface that needs the mark knocked out of a filled shape has to supply that shape itself.

<a id="dev-note"></a>
### Dev Note

The paths were produced from Reem Kufi (SIL OFL) at weight 600, shaped as a single text run so the contextual forms and mark positioning are the font's own rather than a per-glyph approximation. The font file itself is not a dependency of this package and is not shipped.
