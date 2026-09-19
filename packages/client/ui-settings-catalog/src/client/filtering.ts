/**
 * Which entries a search and a filter leave standing.
 *
 * Split out from the component because this is the part with rules worth
 * stating and testing: what a query matches, and which group an entry falls
 * into. The component only draws the answer.
 */

import type { CatalogStatus } from './StatusBadge.tsx'

/** One row in the catalog list. */
export interface CatalogEntry {
  /** Stable identity; also what selection is carried as. */
  readonly id: string
  /** The row's name. */
  readonly label: string
  /** The line under the name, e.g. how this entry can be authenticated. */
  readonly hint?: string
  readonly status: CatalogStatus
  /**
   * Extra text a search should match but the row does not show -- an entry's
   * key, its aliases. A reader who types what they know should find the row
   * whether or not the row happens to display it.
   */
  readonly keywords?: readonly string[]
}

/** Which standings a filter admits; `undefined` admits every one. */
export interface CatalogFilter {
  readonly id: string
  readonly label: string
  /** Standings this filter keeps. Omitted keeps all. */
  readonly statuses?: readonly CatalogStatus[]
}

/**
 * Whether one entry answers a query.
 *
 * Case-insensitive substring over the name, the hint, and any keywords. Not
 * fuzzy: a reader scanning a list of forty providers is typing a prefix of a
 * name they already know, and fuzzy matching in that situation mostly
 * produces rows they did not ask for.
 * @param entry - the row.
 * @param query - what the reader typed; blank matches everything.
 * @returns whether the row survives.
 */
export function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  if (entry.label.toLowerCase().includes(needle)) return true
  if (entry.hint !== undefined && entry.hint.toLowerCase().includes(needle)) return true
  return (entry.keywords ?? []).some(keyword => keyword.toLowerCase().includes(needle))
}

/** One titled run of rows. */
export interface CatalogGroup {
  readonly id: string
  readonly title: string
  readonly entries: readonly CatalogEntry[]
}

/**
 * Split the surviving entries into the two runs the list draws.
 *
 * Ready first, because a reader opening this page usually wants something
 * they already set up; everything else follows under one heading, since the
 * difference between "never configured" and "configured and broken" is
 * already on each row's own badge.
 * @param entries - every row, in the caller's order.
 * @param query - the search text.
 * @param filter - the active filter, or undefined for all.
 * @param titles - the two headings; the package owns no copy.
 * @returns the non-empty groups, ready first.
 */
export function partitionEntries(
  entries: readonly CatalogEntry[],
  query: string,
  filter: CatalogFilter | undefined,
  titles: { readonly ready: string; readonly rest: string },
): CatalogGroup[] {
  const admitted = entries.filter(entry =>
    matchesQuery(entry, query)
    && (filter?.statuses === undefined || filter.statuses.includes(entry.status)))
  const ready = admitted.filter(entry => entry.status === 'ready')
  const rest = admitted.filter(entry => entry.status !== 'ready')
  return [
    ...ready.length > 0 ? [{ id: 'ready', title: titles.ready, entries: ready }] : [],
    ...rest.length > 0 ? [{ id: 'rest', title: titles.rest, entries: rest }] : [],
  ]
}
