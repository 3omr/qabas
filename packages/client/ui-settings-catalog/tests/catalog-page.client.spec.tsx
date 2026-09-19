// @vitest-environment jsdom
/**
 * The page's own behaviour: what it draws, what it selects, and what it says
 * when there is nothing to draw.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CatalogPage } from '../src/client/CatalogPage.tsx'
import type { CatalogEntry, CatalogPageCopy } from '../src/client/CatalogPage.tsx'
import { DetailPane } from '../src/client/DetailPane.tsx'

const COPY: CatalogPageCopy = {
  search: 'Search providers',
  groupReady: 'Connected',
  groupRest: 'Not set up',
  noMatches: 'Nothing matches that.',
  noSelection: 'No provider is selected.',
  status: { ready: 'Ready', attention: 'Attention', unset: 'Setup needed' },
}

const ENTRIES: CatalogEntry[] = [
  { id: 'anthropic', label: 'anthropic', hint: 'Sign in or API key', status: 'ready' },
  { id: 'deepseek', label: 'DeepSeek', hint: 'API key', status: 'unset' },
  { id: 'xai', label: 'xai', hint: 'Sign in or API key', status: 'attention' },
]

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready', statuses: ['ready'] as const },
  { id: 'unset', label: 'Not set up', statuses: ['unset'] as const },
]

afterEach(() => { cleanup() })

function mount(overrides: Partial<Parameters<typeof CatalogPage>[0]> = {}) {
  const onSelect = vi.fn()
  const view = render(
    <CatalogPage entries={ENTRIES} filters={FILTERS} copy={COPY} onSelect={onSelect} {...overrides} />,
  )
  return { view, onSelect }
}

const rows = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-catalog-entry]')].map(node => node.getAttribute('data-catalog-entry'))

describe('CatalogPage', () => {
  it('groups the ready entries above the rest', () => {
    const { view } = mount()
    expect([...view.container.querySelectorAll('[data-catalog-group]')]
      .map(node => node.getAttribute('data-catalog-group'))).toEqual(['ready', 'rest'])
    expect(rows(view.container)).toEqual(['anthropic', 'deepseek', 'xai'])
  })

  it('says each entry\'s standing in words, not only in colour', () => {
    const { view } = mount()
    const badges = [...view.container.querySelectorAll('[data-catalog-status]')]
    expect(badges.map(node => node.textContent)).toEqual(['Ready', 'Setup needed', 'Attention'])
  })

  it('narrows the list as the reader types', () => {
    const { view } = mount()
    fireEvent.change(view.container.querySelector('input')!, { target: { value: 'deep' } })
    expect(rows(view.container)).toEqual(['deepseek'])
  })

  it('says so rather than showing an empty list when nothing matches', () => {
    const { view } = mount()
    fireEvent.change(view.container.querySelector('input')!, { target: { value: 'zzz' } })
    expect(view.container.querySelector('[data-catalog-row="no-matches"]')?.textContent).toBe(COPY.noMatches)
  })

  it('narrows to one standing when a filter is picked', () => {
    const { view } = mount()
    fireEvent.click(view.container.querySelector('[data-catalog-filter="unset"]')!)
    expect(rows(view.container)).toEqual(['deepseek'])
  })

  it('reports a pick by id and marks the current row', () => {
    const { view, onSelect } = mount({ selectedId: 'anthropic' })
    expect(view.container.querySelector('[data-catalog-entry="anthropic"]')?.getAttribute('aria-current'))
      .toBe('true')
    fireEvent.click(view.container.querySelector('[data-catalog-entry="xai"]')!)
    expect(onSelect).toHaveBeenCalledWith('xai')
  })

  it('says nothing is open until the caller gives it something', () => {
    const { view } = mount()
    expect(view.container.querySelector('[data-catalog-row="no-selection"]')?.textContent)
      .toBe(COPY.noSelection)
  })

  it('draws the caller\'s detail node in place of that line', () => {
    const { view } = mount({ children: <p data-testid="detail">anything</p> })
    expect(view.container.querySelector('[data-catalog-row="no-selection"]')).toBeNull()
    expect(view.getByTestId('detail').textContent).toBe('anything')
  })

  it('draws no filter row when there is only one filter', () => {
    const { view } = mount({ filters: [{ id: 'all', label: 'All' }] })
    expect(view.container.querySelector('[data-catalog-filter]')).toBeNull()
  })
})

describe('DetailPane', () => {
  const TABS = [
    { id: 'auth', label: 'Authentication', content: <p data-testid="auth">auth body</p> },
    { id: 'models', label: 'Models', content: <p data-testid="models">models body</p> },
  ]

  it('draws the open tab and lets another be chosen', () => {
    const onSelectTab = vi.fn()
    const view = render(
      <DetailPane title="xai" subtitle="llm-pi-ai/xai" tabs={TABS} activeTabId="auth" onSelectTab={onSelectTab} />,
    )
    expect(view.getByTestId('auth')).not.toBeNull()
    expect(view.queryByTestId('models')).toBeNull()
    fireEvent.click(view.getByRole('tab', { name: 'Models' }))
    expect(onSelectTab).toHaveBeenCalledWith('models')
  })

  it('draws no tab strip for a single tab, because one tab is not a choice', () => {
    const view = render(
      <DetailPane title="x" tabs={[TABS[0]!]} activeTabId="auth" onSelectTab={vi.fn()} />,
    )
    expect(view.queryAllByRole('tab')).toEqual([])
    expect(view.getByTestId('auth')).not.toBeNull()
  })

  it('falls back to the first tab when the active id names none', () => {
    // A caller that switched entries without resetting the tab still gets a body.
    const view = render(
      <DetailPane title="x" tabs={TABS} activeTabId="gone" onSelectTab={vi.fn()} />,
    )
    expect(view.getByTestId('auth')).not.toBeNull()
  })
})
