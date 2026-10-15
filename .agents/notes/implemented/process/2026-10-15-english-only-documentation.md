# Agent Note: English-only documentation

Status: implemented

## Problem

Qabas ships its product in Arabic and English only ([product locales](../architecture/2026-10-10-arabic-english-product-locales.md)), yet every in-scope document still had to merge as an English and Simplified Chinese pair: 1,522 `.zh.md` files, 1,519 `.i18n.yaml` consistency records, a Chinese-root documentation site, a pairing merge driver, and translation tooling. Every documentation edit paid for a Chinese counterpart that no Qabas maintainer or user reads, and the owner asked for Chinese to be removed from the repository entirely.

## Decision

Documentation is English-only. No document, README, Agent Note, or generated reference has a translated counterpart.

- The `.zh.md` documents, `.i18n.yaml` records, Chinese screenshots, `docs/i18n/`, the `dsh-translate-docs` skill, and the translation scripts (`verify-translation-pairing`, `verify-translation-prompt`, `gen-translation-brief`, the pairing merge driver and its record, link, and derivative helpers) are deleted. English documents no longer carry the `English | [中文](…)` line.
- Generators write English only: `gen-module-graph` emits `docs/module-graph.md`, and `gen-cordis-catalog` injects each Cordis region into the English subsystem page with no pair re-record.
- The documentation website has one English route tree at the site root. `website/docs.ts` maps each source to one route, sidebar collections are `guide`, `develop`, and `reference`, and `llms.txt` lists one page group.
- The Lefthook install no longer registers the `dsh-translation-pairing` merge driver, and the pre-commit and pre-merge-commit hooks no longer verify pairing records.
- The frozen archive holds English notes only. Its manifest moves to format version 2; [`verify-archived-agent-notes`](../../../../scripts/verify-archived-agent-notes.ts) lets a baseline with an older format version be re-sealed by the change that bumps the version, and constrains seals only against same-version baselines. This change removes the sealed Chinese counterparts, sidecars, and language-switcher header lines once.
- Product locales are unaffected: Client UI copy stays in typed English and Arabic dictionaries, and Chinese user content, filenames, and model responses still render verbatim. CJK rendering fixtures, recorded sessions, and archived notes that quote historical Chinese UI strings keep that text as data.

This decision fully supersedes the [bilingual pairing gate](../../archived/process/2026-07-02-bilingual-docs-and-pairing-gate.md) and [automatic pairing merges](../../archived/process/2026-08-08-automatic-translation-pairing-merges.md), which are archived, and partially supersedes the [frozen archive policy](2026-07-26-frozen-agent-note-archive.md), whose append-only seals now carry a format version.

## Alternatives considered

**Keep the existing Chinese files but stop requiring new pairs.** Stale translations would contradict the English sources they once matched, and every gate, generator, and website path would keep its bilingual code for documents nobody maintains.

**Replace Chinese with Arabic documentation pairs.** The repository's contributors and agents work in English; the Arabic product copy is owned by locale dictionaries, not documentation, so a second documentation language would recreate the pairing cost without a reader.

**Leave the archive untouched and exempt it from the change.** Sealed archive triplets would keep Chinese files and dead `中文` links in the repository. A format-version re-seal removes them once while keeping every later archive change append-only.

## Consequences

Documentation edits touch one file. Translation quality, pairing hashes, and line alignment no longer exist as review concerns. The website serves English pages at the root; former `/en/…` URLs no longer exist. Developers whose worktrees already registered the pairing merge driver keep a harmless unused Git config entry until they remove it. The archive verifier rejects any reintroduced `.zh.md` or `.i18n.yaml` file under `archived/`, and the manifest-version rule is pinned by `scripts/archived-agent-notes.spec.ts`. Specs for the site projection, catalog splicing, the module graph, documentation standards, and the Lefthook installer pin the English-only behavior.
