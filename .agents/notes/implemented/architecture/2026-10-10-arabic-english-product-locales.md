# Agent Note: Arabic and English product locales

Status: implemented

English | [中文](2026-10-10-arabic-english-product-locales.zh.md)

## Problem

Qabas serves Egyptian medical students in Arabic and English. Shipped Chinese dictionaries, selectable language metadata, desktop copy, and Chinese-only UI tests add an unsupported product language and make dictionary ownership depend on a translation that Qabas does not ship.

## Decision

Qabas ships Arabic and English product copy. English defines dictionary keys and supplies the terminal translation fallback. The Arabic language pack registers right-to-left Arabic and preserves its product default. Desktop startup and native chrome use English outside the browser locale registry.

The locale registry contains no built-in Chinese definition. Durable preferences remain BCP 47-style strings so existing settings documents remain readable. An unavailable saved preference resolves to the registered pack default, then the browser-derived supported locale or English. Loading settings before or after the Arabic pack produces the same Arabic default without rewriting the saved preference. Explicit supported preferences retain priority.

The UI copy check discovers English namespaces across workspace packages and compares each with the Arabic pack. Missing and extra keys, blank Arabic text, and changed interpolation fields fail. Marketplace review guidance requires English and Arabic records. Catalog publishers regenerate records with both languages.

The locale-owned UI-copy decision remains authoritative for authored copy and verbatim external data. This decision supersedes its Chinese/English parity assertion and Chinese key-set ownership; it preserves copy ownership, typed translation seats, and external-data exclusions. Developer documentation translations and their pairing records remain independent of product locales. CJK rendering, Unicode paths, byte limits, and recorded model/user content retain multilingual fixtures.

## Alternatives considered

**Hide Chinese in the picker while retaining its dictionaries.** The owner requires Chinese to be absent from the product, including its implementation and UI-only tests. Hidden dictionaries continue to carry unsupported copy and parity obligations.

**Reject stored Chinese preferences during settings parsing.** Rejected because an unsupported locale is a recoverable preference, not a corrupt settings document. Catalog resolution supplies a supported language without losing unrelated settings or rewriting user choices.

## Consequences

English is the dictionary source of truth, and every shipped namespace has matching Arabic keys and interpolation fields. Adding product wording requires both dictionaries. External Chinese data still renders verbatim; removing a UI locale does not restrict user content, model responses, filenames, or source text. Existing Chinese preferences remain stored until the user explicitly chooses a supported language.
