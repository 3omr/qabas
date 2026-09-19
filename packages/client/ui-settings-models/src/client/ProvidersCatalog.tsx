/**
 * The provider list as a catalog: every route on the left, the open one on
 * the right, under Authentication and Models.
 *
 * The shape comes from `ui-settings-catalog`, which owns no domain; this file
 * is the whole of what "a provider" means to it -- which row is ready, what
 * its second line says, and what its two tabs contain.
 *
 * Selection carries the first-run posture the card list used to carry
 * differently. With nothing configured, a page of forty grey rows and no
 * starting point is worse than the old open setup card, so one entry opens by
 * itself: the first ready route if there is one, otherwise the first row.
 * A reader who then picks another is never overridden -- the default applies
 * only while nothing has been chosen.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CatalogPage, DetailPane } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type {
  CatalogEntry, CatalogFilter, CatalogPageCopy, CatalogStatus, DetailTab,
} from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type { AuthorizationEntryView } from '@deepseek-ai/dsh-api-remotes/client'
import { providerStanding } from './store.ts'
import type { ProviderRow } from './store.ts'
import type { en } from './locales.ts'

/** How one route is authenticated, as the row's second line. */
function hintFor(flow: AuthorizationEntryView | undefined, t: Translate): string {
  const methods = flow?.methods ?? []
  const oauth = methods.some(method => method.id === 'oauth')
  const key = methods.some(method => method.id !== 'oauth')
  if (oauth && key) return t('catalog.hintBoth')
  if (oauth) return t('catalog.hintSignIn')
  return t('catalog.hintKey')
}

/** Namespace-bound translate, as the section passes it down. */
type Translate = (key: keyof typeof en, params?: Record<string, string>) => string

/** Props of {@link ProvidersCatalog}. */
export interface ProvidersCatalogProps {
  /** The configured routes, in the page's own order. */
  rows: readonly ProviderRow[]
  /** The sign-in flows, keyed by credential key; empty when no seam is mounted. */
  flows: readonly AuthorizationEntryView[]
  /** Credential keys with a stored sign-in. */
  signedIn: ReadonlySet<string>
  /** Which route is open; `undefined` until the reader or the default picks one. */
  selected: string | undefined
  onSelect: (provider: string) => void
  /** Drawn at the top right: the add controls. */
  action?: ReactNode
  /** The open route's authentication half. */
  renderAuthentication: (row: ProviderRow) => ReactNode
  /** The open route's models half. */
  renderModels: (row: ProviderRow) => ReactNode
  t: Translate
}

/**
 * Render the provider catalog.
 * @param props - the routes, the flows, and the two halves of an open one.
 * @returns the page.
 */
export function ProvidersCatalog({
  rows, flows, signedIn, selected, onSelect, action, renderAuthentication, renderModels, t,
}: ProvidersCatalogProps): ReactNode {
  const [tab, setTab] = useState('authentication')

  const flowFor = useMemo(() => {
    const byKey = new Map(flows.map(flow => [flow.key, flow]))
    return (row: ProviderRow) => byKey.get(`${row.entry.settingsNs}/${row.entry.provider}`)
  }, [flows])

  const entries: CatalogEntry[] = useMemo(() => rows.map((row) => {
    const key = `${row.entry.settingsNs}/${row.entry.provider}`
    return {
      id: row.entry.provider,
      label: row.entry.displayName,
      hint: hintFor(flowFor(row), t),
      status: providerStanding(row, signedIn.has(key)) satisfies CatalogStatus,
      // The credential key is not on the row, but a reader who knows a route
      // by it should still find the route by typing it.
      keywords: [key, row.entry.provider],
    }
  }), [rows, flowFor, signedIn, t])

  // First-run guidance: open something rather than showing a wall of rows.
  // Only while nothing is selected, so a reader's own pick always wins.
  const fallback = entries.find(entry => entry.status === 'ready')?.id ?? entries[0]?.id
  useEffect(() => {
    if (selected === undefined && fallback !== undefined) onSelect(fallback)
  }, [selected, fallback, onSelect])

  const open = rows.find(row => row.entry.provider === selected)

  const copy: CatalogPageCopy = {
    search: t('catalog.search'),
    groupReady: t('catalog.groupReady'),
    groupRest: t('catalog.groupRest'),
    noMatches: t('catalog.noMatches'),
    noSelection: t('catalog.noSelection'),
    status: {
      ready: t('catalog.statusReady'),
      attention: t('catalog.statusAttention'),
      unset: t('catalog.statusUnset'),
    },
  }

  const filters: CatalogFilter[] = [
    { id: 'all', label: t('catalog.filterAll') },
    { id: 'ready', label: t('catalog.statusReady'), statuses: ['ready'] },
    { id: 'attention', label: t('catalog.statusAttention'), statuses: ['attention'] },
    { id: 'unset', label: t('catalog.statusUnset'), statuses: ['unset'] },
  ]

  const tabs: DetailTab[] = open === undefined ? [] : [
    { id: 'authentication', label: t('catalog.tabAuthentication'), content: renderAuthentication(open) },
    { id: 'models', label: t('catalog.tabModels'), content: renderModels(open) },
  ]

  return (
    <CatalogPage
      action={action}
      entries={entries}
      filters={filters}
      copy={copy}
      selectedId={selected}
      onSelect={onSelect}
    >
      {open !== undefined && (
        <DetailPane
          title={open.entry.displayName}
          subtitle={`${open.entry.settingsNs}/${open.entry.provider}`}
          status={providerStanding(open, signedIn.has(`${open.entry.settingsNs}/${open.entry.provider}`))}
          statusLabel={copy.status[providerStanding(
            open, signedIn.has(`${open.entry.settingsNs}/${open.entry.provider}`),
          )]}
          tabs={tabs}
          activeTabId={tab}
          onSelectTab={setTab}
        />
      )}
    </CatalogPage>
  )
}
