# Agent Note: Student-facing names and library presentation

Status: implemented

## Problem

Arabic students encounter several names for the same writer, technical tool titles, reordered mixed-language filenames, duplicate unassigned materials and concatenated chat failure text. Background refreshes reset library scroll. Credential-only readiness omits the installed Google-sign-in chat adapter, while the composer does not identify the answering provider.

## Decision

English UI uses Omar and Arabic UI uses عومر in chat, jobs and the library; the engine settings name the installed tool Antigravity, which the student signs in to and tests. CLI identifiers remain in installation, sign-in and diagnostic instructions. Both shipped dictionaries own human tool titles and descriptions; technical identifiers occupy a secondary line. Arabic authored copy uses Latin digits, and the writer probe carries no precise duration estimate.

Library renderers isolate user names and preserve number/unit order. Scroll resets depend on route values rather than object identity. Chat places its jobs pill in the top content corner, leaving the composer and empty hero clear. The manager excludes files displayed by any lecture card from its unassigned list, including filename-matched materials whose inventory ownership is empty. Engine ownership and writing behavior remain unchanged.

Known fixed engine notes and missing-exam-year warnings map to localized dictionary keys; unknown notes remain verbatim. Terminal chat errors separate title and reason with a DOM line break. The sidebar checks Omar discovery before showing a missing-key warning. The composed `ui-chat` plugin owns the read-only `conversation.input.model` chip and its `chat` dictionary keys. The chip follows the durable last-used provider, with the next selection or Host catalog default before the first request. Gemini fallback changes the indicator without changing the saved selection.

## Alternatives considered

**Change engine ownership for filename matches.** Inventory distinguishes explicitly claimed materials from title-matched writer inputs. Excluding displayed files at the manager preserves that distinction without changing engine behavior.

**Translate arbitrary engine prose.** Exact known-note mapping preserves external diagnostics and allows new engine notes to remain readable without inventing translations.

**Re-enable the model picker.** Students need the answering provider, not another model choice. The read-only seat uses persisted request data and existing Host catalog operations.

**Position jobs using a fixed composer-height estimate.** Empty-chat layout and narrow widths change the composer position. A separate top corner avoids that estimate.

## Consequences

Vitest covers bidi attributes, file-size order, refresh scroll, jobs placement, manual and automatic lecture ownership, failure separators, note localization, missing-key visibility and provider fallback. Owner-local snapshots pin English and Arabic output. Product UI has only en/ar dictionaries; package documentation is English-only. No provider logic or engine behavior changes.

The jobs placement assertions cover the CSS rule and DOM class; narrow and wide browser layouts are checked in the live preview.

## Verification

Focused Vitest covers the changed library, chat and settings packages. The UI copy checker accepts the en/ar dictionaries, the client package checker accepts every client package, and the build, hygiene and documentation gates pass.
