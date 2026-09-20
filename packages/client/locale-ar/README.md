---
description: "Qabas Egyptian Arabic language pack for the medical-study Web GUI, with English fallback and right-to-left document direction."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-locale-ar

English | [中文](README.zh.md)

## Summary

This package registers `ar` as the Qabas Web GUI's Egyptian Arabic language pack. It supplies the shell, conversation, settings, transcriber, and lecture-helper namespaces a medical student meets during an ordinary session. The pack declares `fallback: 'en'`, so an untranslated key remains usable English copy rather than exposing a key name. It also declares `direction: 'rtl'` and selects Arabic only when the user has not already chosen a locale.

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

Mount the browser entry after `dsh-client-locale`. The entry owns one Cordis effect: it registers the `ar` definition, registers each single-locale dictionary, and chooses Arabic as the product default only when no durable preference exists. Unloading the entry removes the definition and every dictionary it owns.

The copy is written for Egyptian medical students rather than translated word-for-word from the generic harness. It covers `common`, `settings`, `settings.locale`, `settings.theme`, `settings.permission`, `settings.models`, `settings.transcriberEngine`, `sidebar`, `sidebarRight`, `conversation`, `chat`, `transcriber`, `transcriberComposer`, `workspace`, and `access`.

## Missing keys

The locale runtime walks the active language's fallback chain. A key missing from the Arabic dictionary resolves from English when English owns it; a key missing from both languages still exposes its key so an incomplete dictionary cannot become silent empty UI. The pack intentionally uses this extension point instead of changing the built-in locale ids or metadata.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The node half is an empty bundle seat. The browser half injects `locale`, registers the language and dictionaries through owned effects, and calls `setLocaleIfUnset('ar')`. The locale runtime publishes the direction in its snapshot; the renderer applies that direction once at the application root, while code and path presentations keep their own `dir="ltr"` declarations.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Locale runtime](../locale/README.md) — language registration, fallback lookup, persistence, and the document direction snapshot.
- [Client group map](../README.md) — the browser package family and composition roster.
- [ui-transcriber-composer](../ui-transcriber-composer/README.md) — the lecture-helper controls whose product copy this pack owns.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package changes browser copy and locale state without registering prompts, tools, or model-request fields.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The pack is intentionally partial** — namespaces and keys outside the medical-study session remain English through the declared fallback. Adding a key here does not change the built-in English or Chinese dictionaries.
- **Locale-specific grammar stays simple** — the runtime performs key lookup and `{name}` interpolation; it does not provide Arabic plural rules, gender agreement, or formatting.

<a id="dev-note"></a>
### Dev Note

The Arabic UI face is Noto Sans Arabic, bundled by `ui-theme`; Reem Kufi remains reserved for the settled Qabas wordmark.

**Runtime invariant:** No companion is published. Registration disposal, fallback lookup, and the Arabic direction are asserted by the language-pack behavior spec.
