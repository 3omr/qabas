/**
 * A settings page that is a catalog: a searchable, filterable list on the
 * left, and whatever the caller draws for the selected entry on the right.
 *
 * The page owns no copy and no domain. Every word arrives in `copy`, the rows
 * arrive as data, and the right-hand side is the caller's own node -- which is
 * what lets Providers, and the pages that follow it, share one shape without
 * sharing anything else.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusBadge } from './StatusBadge.tsx'
import type { CatalogStatus } from './StatusBadge.tsx'
import { partitionEntries } from './filtering.ts'
import type { CatalogEntry, CatalogFilter, CatalogGroup } from './filtering.ts'
import css from './CatalogPage.module.css'

export type { CatalogEntry, CatalogFilter, CatalogGroup } from './filtering.ts'

/** Every word this page shows. */
export interface CatalogPageCopy {
  /** Placeholder in the search field, and its accessible name. */
  readonly search: string
  /** Heading over the entries that are ready. */
  readonly groupReady: string
  /** Heading over everything else. */
  readonly groupRest: string
  /** Shown in place of the list when a search matches nothing. */
  readonly noMatches: string
  /** Shown in the detail half while nothing is selected. */
  readonly noSelection: string
  /** One word per standing, for the row badges. */
  readonly status: Readonly<Record<CatalogStatus, string>>
}

/** Props of {@link CatalogPage}. */
export interface CatalogPageProps {
  /** A sentence under the page's own heading. */
  description?: ReactNode
  /** Rendered at the top right, e.g. an add control. */
  action?: ReactNode
  entries: readonly CatalogEntry[]
  /** The filters offered above the list. The first is the default. */
  filters?: readonly CatalogFilter[]
  selectedId?: string | undefined
  onSelect: (id: string) => void
  copy: CatalogPageCopy
  /** The open entry, drawn by the caller. */
  children?: ReactNode
}

/**
 * Render the catalog.
 * @param props - the rows, the copy, and the detail node.
 * @returns the two-column page.
 */
export function CatalogPage({
  description, action, entries, filters = [], selectedId, onSelect, copy, children,
}: CatalogPageProps): ReactNode {
  const [query, setQuery] = useState('')
  const [filterId, setFilterId] = useState<string | undefined>(filters[0]?.id)
  const filter = filters.find(candidate => candidate.id === filterId)

  const groups: CatalogGroup[] = useMemo(
    () => partitionEntries(entries, query, filter, { ready: copy.groupReady, rest: copy.groupRest }),
    [entries, query, filter, copy.groupReady, copy.groupRest],
  )

  return (
    <div className={css.page} data-catalog-page="">
      {(description !== undefined || action !== undefined) && (
        <div className={css.pageHeader}>
          {description !== undefined ? <div className={css.pageDescription}>{description}</div> : <span />}
          {action}
        </div>
      )}

      <div className={css.columns}>
        <div className={css.listColumn}>
          <Input
            type="search"
            value={query}
            placeholder={copy.search}
            aria-label={copy.search}
            onChange={(event) => { setQuery(event.target.value) }}
          />

          {filters.length > 1 && (
            <div className={css.filters}>
              {filters.map(candidate => (
                <Pill
                  key={candidate.id}
                  active={candidate.id === filterId}
                  onClick={() => { setFilterId(candidate.id) }}
                  data-catalog-filter={candidate.id}
                >
                  {candidate.label}
                </Pill>
              ))}
            </div>
          )}

          {groups.length === 0
            ? <p className={css.empty} data-catalog-row="no-matches">{copy.noMatches}</p>
            : (
              <div className={css.list}>
                {groups.map(group => (
                  <div key={group.id} className={css.group} data-catalog-group={group.id}>
                    <p className={css.groupTitle}>{group.title}</p>
                    <ul className={css.rows}>
                      {group.entries.map(entry => (
                        <li key={entry.id}>
                          <button
                            type="button"
                            className={clsx(css.row, entry.id === selectedId && css.rowActive)}
                            aria-current={entry.id === selectedId ? 'true' : undefined}
                            data-catalog-entry={entry.id}
                            onClick={() => { onSelect(entry.id) }}
                          >
                            <span className={css.rowText}>
                              <span className={css.rowLabel}>{entry.label}</span>
                              {entry.hint !== undefined && <span className={css.rowHint}>{entry.hint}</span>}
                            </span>
                            <StatusBadge status={entry.status} label={copy.status[entry.status]} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
        </div>

        <div className={css.detailColumn}>
          {children ?? <p className={css.empty} data-catalog-row="no-selection">{copy.noSelection}</p>}
        </div>
      </div>
    </div>
  )
}
