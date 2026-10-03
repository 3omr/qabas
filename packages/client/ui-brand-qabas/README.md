---
description: "Qabas brand: the palette layer, the flame-quote symbol and the قَبَس wordmark for the sidebar, the blank-session hero and the first-run welcome, drawn as outlines so no Arabic font is required; for maintainers changing the app's identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-qabas

English | [中文](README.zh.md)

## Summary

This package gives the app its own identity. The symbol is two quotation marks that are also two flames on an ember tile: from a whole lecture (the faded mark) the app lifts the part worth keeping (the bright one). It heads the sidebar and the collapsed rail, with the قَبَس wordmark beside it in the open sidebar and under it on the blank-session hero and the first-run welcome, in place of the harness's animated fish. The symbol and the wordmark are checked-in path geometry rather than text in a font, so they render identically on a machine with no Arabic font installed. The package has no runtime state and does not affect model requests.

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

Four slots are filled: `sidebar.brand.mark` with the symbol, `sidebar.brand.name` with the wordmark, and `conversation.hero.brand.mark` and `settings.onboarding.mark` with the symbol over the wordmark. The hero slot matters more than its size suggests: its fallback is the first thing a new user sees. The favicon, the desktop loading page and the desktop app icons carry the same symbol.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

### The name

«قَبَس» is a quotation: a borrowing of someone's exact words. That is what the product does with a lecture — it takes back what the doctor actually said and builds the study material from that, rather than from a paraphrase of it. The name is the product's claim about itself, which is why the marks are drawn rather than typed.

### Why outlines and not a font

The letterforms are Aref Ruqaa Bold, shaped with HarfBuzz and converted to SVG paths, then checked in as geometry. Ruqaa is the hand Arabic is written in day to day — the script of a student's own notes, which is what a transcript taken from a lecture becomes.

A desktop application cannot assume a font is installed, and an Arabic wordmark that falls back to a system face is not a degraded wordmark — it is different letters, with the contextual forms and the two fatḥas resolved by whatever face happened to answer. Paths have no such failure mode, and they carry no font file, no license to ship, and no load to wait for.

### Colour

Every path is `fill="currentColor"`, so both marks take the surrounding theme. There is no light copy and no dark copy to keep in step.

### Palette

The plugin also lays one token layer over the base light and dark themes (`ctx.theme.overrideTokens`): warm paper neutrals, near-black ink, and a single ember accent for primary actions, links and the brand's own text. قَبَس is a firebrand, and a library of lecture notes reads better as paper than as the harness's bluish grey. Because the layer only overrides alias tokens, every existing surface takes it without a stylesheet, and the light / dark / system preference keeps working. Ember on paper and dark ink on ember both clear WCAG AA for body text.

The layer also defines the `--qabas-state-*` tokens — pending, verbatim, draft, final, each with a `-wash` background — that every library surface draws a lecture's progress with, and `--qabas-ember-glow` for the few decorative moments.

### How the geometry was produced

Aref Ruqaa (SIL OFL) at weight 700, shaped as a single text run so the contextual forms and the mark positioning are the font's own rather than a per-glyph approximation, then emitted as paths. The font file is not a dependency of this package and is not shipped.

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

The paths were produced from Aref Ruqaa (SIL OFL) at weight 700, shaped as a single text run so the contextual forms and mark positioning are the font's own rather than a per-glyph approximation. The font file itself is not a dependency of this package and is not shipped.
