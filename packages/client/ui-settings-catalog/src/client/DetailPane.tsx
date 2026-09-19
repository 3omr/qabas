/**
 * The right-hand half: one entry, open.
 *
 * Tabs live here rather than in the page because what an entry is made of is
 * the caller's business -- Providers splits into how it authenticates and
 * which models it offers, and another page will split differently or not at
 * all. A single tab draws no tab strip: one tab is not a choice.
 */

import { useId } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { StatusBadge } from './StatusBadge.tsx'
import type { CatalogStatus } from './StatusBadge.tsx'
import css from './CatalogPage.module.css'

/** One section of an open entry. */
export interface DetailTab {
  readonly id: string
  readonly label: string
  readonly content: ReactNode
}

/** Props of {@link DetailPane}. */
export interface DetailPaneProps {
  /** The entry's name, as the heading. */
  title: string
  /** A quieter line under it, e.g. the entry's key. */
  subtitle?: string
  /** The standing, drawn beside the heading. */
  status?: CatalogStatus
  /** The word for that standing. */
  statusLabel?: string
  /** A sentence under the heading. */
  description?: ReactNode
  /** The sections. One draws no tab strip. */
  tabs: readonly DetailTab[]
  /** Which section is open. */
  activeTabId: string
  onSelectTab: (id: string) => void
}

/**
 * Render one open entry.
 * @param props - the entry's heading and its sections.
 * @returns the detail pane.
 */
export function DetailPane({
  title, subtitle, status, statusLabel, description, tabs, activeTabId, onSelectTab,
}: DetailPaneProps): ReactNode {
  const base = useId()
  const active = tabs.find(tab => tab.id === activeTabId) ?? tabs[0]

  return (
    <section className={css.detail} data-catalog-detail={title}>
      <header className={css.detailHeader}>
        <div className={css.detailTitleRow}>
          <h3 className={css.detailTitle}>{title}</h3>
          {status !== undefined && statusLabel !== undefined && (
            <StatusBadge status={status} label={statusLabel} />
          )}
        </div>
        {subtitle !== undefined && <p className={css.detailSubtitle}>{subtitle}</p>}
        {description !== undefined && <div className={css.detailDescription}>{description}</div>}
      </header>

      {tabs.length > 1 && (
        <div className={css.tabs} role="tablist">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${base}-tab-${tab.id}`}
              aria-selected={tab.id === active?.id}
              aria-controls={`${base}-panel-${tab.id}`}
              className={clsx(css.tab, tab.id === active?.id && css.tabActive)}
              onClick={() => { onSelectTab(tab.id) }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {active !== undefined && (
        <div
          className={css.detailBody}
          role={tabs.length > 1 ? 'tabpanel' : undefined}
          id={`${base}-panel-${active.id}`}
          aria-labelledby={tabs.length > 1 ? `${base}-tab-${active.id}` : undefined}
        >
          {active.content}
        </div>
      )}
    </section>
  )
}
