---
description: "Cordis-free settings-page layout for maintainers building a settings page that lists many entries: a searchable, filterable catalog beside the one entry that is open." kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-catalog

English | [中文](README.zh.md)

## Summary

The shape a settings page takes once it outgrows one column of cards: a searchable, filterable list of entries on the left, and the open entry on the right. It supplies the layout, the search, the filters, the grouping and the standing badges; it knows nothing about what an entry is and owns no words, so every page can share the shape without sharing anything else. Providers is the first page built on it.

## Table of Contents

- [Use this package](#use-this-package)
- [What an entry is](#what-an-entry-is)
- [Standings](#standings)
- [Search and filters](#search-and-filters)
- [The open entry](#the-open-entry)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```tsx
<CatalogPage
  entries={entries}
  filters={filters}
  copy={copy}
  selectedId={selected}
  onSelect={setSelected}
  action={<button type="button">{t('addInstance')}</button>}
  description={t('pageDescription')}
>
  <DetailPane
    title={open.label}
    subtitle={open.key}
    status={open.status}
    statusLabel={copy.status[open.status]}
    tabs={tabs}
    activeTabId={tab}
    onSelectTab={setTab}
  />
</CatalogPage>
```

Nothing is registered and no context is read: this is a component library, like `ui-primitives`, which it is built out of — `Pill` is the filter chip, `Input` the search field, `StateDot` and `Tag` the standing badge. A page keeps its own selection and tab state, because a page that remembers where the reader was across a close and reopen and one that does not are both reasonable and the choice is not this package's.

<a id="what-an-entry-is"></a>
## What an entry is

A row is an `id`, a `label`, a `status`, and optionally a `hint` — the quieter second line, which Providers uses to say how a route can be authenticated — and `keywords`, text a search matches but the row does not show. Keywords exist because a reader who knows a thing by an identifier the row has no room for should still find it by typing that identifier.

<a id="standings"></a>
## Standings

Three, not two. `ready`, `unset`, and `attention` — configured but unhappy, such as a sign-in whose refresh token the issuer has revoked. Folding `attention` into either neighbour loses the one state a reader has to act on: it is neither working nor waiting to be set up.

Colour is never the only carrier. Each badge is a dot *and* a word, so the distinction survives a reader who cannot separate green from amber, and the word is the caller's — `copy.status` names all three.

<a id="search-and-filters"></a>
## Search and filters

Search is a case-insensitive substring over the label, the hint and the keywords. Deliberately not fuzzy: a reader scanning forty providers is typing a prefix of a name they already know, and fuzzy matching there mostly surfaces rows they did not ask for.

Filters narrow by standing. The first is the default, and a single filter draws no filter row — one choice is not a choice. Search and filter compose: both narrow, neither resets the other.

The surviving rows are split in two, ready first, because a reader opening the page usually wants something already set up. A group with nothing in it is not drawn, so a bare heading never appears. Within each group the caller's order is kept, since the caller knows which rows matter.

<a id="the-open-entry"></a>
## The open entry

`DetailPane` draws a heading, an optional subtitle and standing, and tabs. Tabs are the caller's: Providers splits into how it authenticates and which models it offers, and another page will split differently or not at all. A single tab draws no tab strip, and an `activeTabId` naming no tab falls back to the first — a caller that switched entries without resetting the tab still gets a body rather than a blank pane.

Below 720px the two columns become one: side by side, neither half has room to be read.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No keyboard list navigation.** Rows are buttons in document order, so Tab reaches them all, but arrow keys do not move between them the way a listbox's would.
- **No virtualization.** Every surviving row renders. Forty providers is nothing; forty thousand entries would need a windowed list.
- **Grouping is by standing only.** A page wanting its own sections — by vendor, by workspace — has no way to say so yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The rules worth arguing about live in `filtering.ts` rather than in the component, which is why that file is where the tests point. The component only draws what it is handed.

</details>

**Runtime invariant:** No companion is published. The page holds only the search text and the active filter; selection and tab state belong to the caller, so there is no second observation of them to disagree with.
