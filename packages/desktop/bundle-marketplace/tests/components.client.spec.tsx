// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarketplaceTab, type MarketplaceProps } from '../src/client/MarketplaceTab.tsx'
import { en, type MarketplaceLocaleKey } from '../src/client/locales.ts'
import type { MarketplaceSnapshot } from '../src/types.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)
const base = { catalog: { source: 'bundled', remoteConfigured: false, revision: null, expiresAt: null }, entries: [{ id: 'example', reviewToken: 'review', title: 'Example Bundle', packageName: '@test/example', version: '1.0.0',
  publisher: 'Test publisher', source: 'https://example.com/source', details: null, issues: [] }],
selection: { schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null },
profiles: [{ profile: 'web', state: 'read', bundles: [] }] } as unknown as MarketplaceSnapshot
const candidate = { profile: 'desktop-00000000-0000-4000-8000-000000000000', previousProfile: 'web', manifestSha256: 'a'.repeat(64) } as NonNullable<MarketplaceSnapshot['selection']['pending']>
function bench(snapshot: MarketplaceSnapshot = base, arabic = false) {
  const read = vi.fn().mockResolvedValue(snapshot)
  const install = vi.fn().mockResolvedValue('acknowledged')
  const cancel = vi.fn().mockResolvedValue('acknowledged')
  const remove = vi.fn().mockResolvedValue('acknowledged')
  const renderSlot = vi.fn().mockReturnValue(null)
  const close = vi.fn()
  const openLocalAgents = vi.fn().mockResolvedValue('acknowledged')
  const refreshCatalog = vi.fn().mockResolvedValue('acknowledged')
  const history = vi.fn().mockResolvedValue([])
  const props = { snapshot: read, refreshCatalog, history, install, cancel, remove, renderSlot, close, openLocalAgents,
    catalogLanguage: () => arabic ? 'ar' : 'en',
    t: ((key: MarketplaceLocaleKey) => en[key]) as MarketplaceProps['t'],
    useConnectionGeneration: select => select({ id: 1, host: { home: '/test' } }),
  } as MarketplaceProps
  return { props, read, refreshCatalog, history, install, cancel, remove, renderSlot, close, openLocalAgents }
}
async function ready(props: MarketplaceProps) {
  const view = render(<MarketplaceTab {...props} />)
  await screen.findByText('Example Bundle')
  return view
}
async function review() { fireEvent.click(await screen.findByRole('button', { name: en.install })) }

describe('marketplace presentation', () => {
  it.each(['bundled', 'cached', 'online', 'unavailable'] as const)('checks %s catalogs explicitly without installing', async (source) => {
    const b = bench({ ...base, catalog: { ...base.catalog, source, remoteConfigured: true } })
    await ready(b.props)
    expect(b.refreshCatalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.checkCatalog }))
    await waitFor(() =>{  expect(b.refreshCatalog).toHaveBeenCalledOnce() })
    await waitFor(() =>{  expect(b.read).toHaveBeenCalledTimes(2) })
    expect(b.install).not.toHaveBeenCalled()
  })
  it.each([false, true])('filters metadata locally and clears review when the search changes (Arabic=%s)', async (arabic) => {
    const copy = en
    const details = { license: 'MIT', en: { summary: 'Pomodoro timer', accounts: '', access: '', setup: '' }, ar: { summary: 'مؤقت التركيز', accounts: '', access: '', setup: '' } }
    const b = bench({ ...base, entries: [{ ...base.entries[0]!, details }] }, arabic)
    await ready(b.props)
    const search = screen.getByRole('searchbox', { name: copy.search })
    for (const query of [' EXAMPLE ', '@TEST/EXAMPLE', 'publisher', arabic ? 'مؤقت' : 'POMODORO']) {
      fireEvent.change(search, { target: { value: query } })
      expect(screen.getByRole('button', { name: copy.install })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: copy.install }))
    fireEvent.change(search, { target: { value: 'absent' } })
    expect(screen.getByText(copy.noMatches)).toBeTruthy()
    expect(screen.queryByRole('group', { name: copy.review })).toBeNull()
    expect(screen.queryByText('Example Bundle')).toBeNull()
    fireEvent.change(search, { target: { value: '' } })
    expect(screen.getByText('Example Bundle')).toBeTruthy()
    expect(b.read).toHaveBeenCalledOnce()
    expect(b.install).not.toHaveBeenCalled()
  })
  it.each([false, true])('shows only known version differences, including incompatible and older targets (Arabic=%s)', async (arabic) => {
    const copy = en
    const b = bench({ ...base, entries: [base.entries[0]!, { ...base.entries[0]!, id: 'blocked' as never, packageName: 'blocked', title: 'Blocked', issues: ['platform'] }],
      profiles: [{ profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: '2.0.0', removable: true }, { packageName: 'blocked', version: '0.5', removable: true }] }] }, arabic)
    await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: copy.updates }))
    expect(screen.getByText(copy.updatesHint)).toBeTruthy()
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: copy.replace })
    expect(buttons.map(button => button.disabled)).toEqual([false, true])
    fireEvent.click(buttons[0]!)
    expect(screen.getByText('2.0.0 → 1.0.0')).toBeTruthy()
    expect(b.install).not.toHaveBeenCalled()
    b.read.mockResolvedValue({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: '1.0.0', removable: true }] }] })
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
    await screen.findByText(copy.noUpdates)
    b.read.mockResolvedValue({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: null, removable: false }] }] })
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
    await screen.findByText(copy.noUpdates)
    b.read.mockResolvedValue({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'unavailable' }] })
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
    await screen.findByText(copy.inventoryFailed)
    expect(screen.queryByText(copy.noUpdates)).toBeNull()
  })
  it.each([false, true])('reads history on demand and distinguishes prepared, missing and failed records (Arabic=%s)', async (arabic) => {
    const copy = en
    const b = bench(base, arabic)
    b.history.mockResolvedValue([
      { id: 'a', kind: 'composition', state: 'prepared', startedAt: '2026-09-13T00:00:00Z', entry: { title: 'Example', packageName: '@test/example', version: '1' } },
      { id: 'b', kind: 'removal', state: 'failed', removed: { packageName: 'removed', version: '1' } },
      ...['unreadable', 'unavailable', 'preparing', 'unsettled'].map(state => ({ id: state, state })),
    ])
    await ready(b.props)
    expect(b.history).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.history }))
    await screen.findByText(copy['operation-prepared'])
    expect(screen.getByText(copy['operation-failed'])).toBeTruthy()
    expect(screen.getByText(copy['operation-removal'])).toBeTruthy()
    expect(screen.getByText(copy['operation-unsettled'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: copy.confirm })).toBeNull()
    expect(b.history).toHaveBeenCalledOnce()
    b.history.mockRejectedValueOnce(new Error('/private/path'))
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
    await screen.findByText(copy.historyFailed)
    expect(screen.queryByText('/private/path')).toBeNull()
    b.history.mockResolvedValueOnce([])
    fireEvent.click(screen.getByRole('button', { name: copy.refresh }))
    await screen.findByText(copy.historyEmpty)
    expect(b.install).not.toHaveBeenCalled()
  })
  it('discards old history settlements across disconnect and tab changes', async () => {
    const b = bench()
    const old = Promise.withResolvers<[]>()
    b.history.mockReturnValueOnce(old.promise)
    const view = await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: en.history }))
    expect(screen.getByText(en.historyLoading)).toBeTruthy()
    view.rerender(<MarketplaceTab {...b.props} useConnectionGeneration={select => select(undefined)} />)
    expect(screen.getByText(en.offline)).toBeTruthy()
    await act(async () => { old.reject(new Error('old')); await old.promise.catch(() => {}) })
    expect(screen.queryByText(en.historyFailed)).toBeNull()
    expect(b.history).toHaveBeenCalledOnce()
    const leaving = Promise.withResolvers<[]>()
    b.history.mockReturnValueOnce(leaving.promise)
    view.rerender(<MarketplaceTab {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    await act(async () => { leaving.resolve([]); await leaving.promise })
    expect(screen.queryByText(en.historyEmpty)).toBeNull()
  })
  it.each([false, true])('shows inert review guidance before installation (Arabic=%s)', async (arabic) => {
    const copy = en
    const details = { license: 'MIT',
      en: { summary: 'Keep a timer beside your work', accounts: 'No account required', access: '<img src=x onerror=alert(1)>', setup: 'Open the timer after restart' }, ar: { summary: 'خلي مؤقت جنب شغلك', accounts: 'من غير حساب', access: '<img src=x onerror=alert(1)>', setup: 'افتح المؤقت بعد إعادة التشغيل' } }
    const b = bench({ ...base, entries: [{ ...base.entries[0]!, details }] }, arabic)
    const view = await ready(b.props)
    const guide = details[arabic ? 'ar' : 'en']
    expect(screen.getByText(guide.summary)).toBeTruthy()
    expect(screen.getByText(guide.access)).toBeTruthy()
    expect(view.container.querySelector('script, img')).toBeNull()
    fireEvent.click(screen.getByText(copy.details))
    expect(b.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: copy.install }))
    const review = within(screen.getByRole('group', { name: copy.review }))
    expect(review.getByText(guide.accounts)).toBeTruthy()
    expect(review.getByText(guide.access)).toBeTruthy()
    expect(review.getByText(guide.setup)).toBeTruthy()
    expect(review.getByText(copy.accessHint)).toBeTruthy()
    expect(review.getByText('MIT')).toBeTruthy()
    expect(b.install).not.toHaveBeenCalled()
    view.rerender(<MarketplaceTab {...b.props} catalogLanguage={() => arabic ? 'ar' : 'en'} />)
    expect(review.getByText(details[arabic ? 'ar' : 'en'].setup)).toBeTruthy()
    expect(b.read).toHaveBeenCalledOnce()
  })
  it.each([false, true])('opens existing agent settings without installing or checking accounts (Arabic=%s)', async (arabic) => {
    const copy = en
    const b = bench(base, arabic)
    await ready(b.props)
    expect(screen.getByText(copy.localAgentsHint)).toBeTruthy()
    expect(b.openLocalAgents).not.toHaveBeenCalled()
    const pending = Promise.withResolvers<string>()
    b.openLocalAgents.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: copy.configureAgents }))
    const button = screen.getByRole<HTMLButtonElement>('button', { name: copy.openingAgents })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(b.openLocalAgents).toHaveBeenCalledExactlyOnceWith()
    await act(async () => { pending.resolve('acknowledged'); await pending.promise })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: copy.configureAgents }).disabled).toBe(false)
    expect(b.install).not.toHaveBeenCalled()
    expect(b.remove).not.toHaveBeenCalled()
    expect(b.read).toHaveBeenCalledOnce()
    b.openLocalAgents.mockResolvedValueOnce('unconfirmed')
    fireEvent.click(screen.getByRole('button', { name: copy.configureAgents }))
    await screen.findByText(copy.agentsUnconfirmed)
    b.openLocalAgents.mockRejectedValueOnce(new Error('private path'))
    fireEvent.click(screen.getByRole('button', { name: copy.configureAgents }))
    await screen.findByText(copy.agentsUnconfirmed)
    expect(screen.queryByText('private path')).toBeNull()
    expect(b.openLocalAgents).toHaveBeenCalledTimes(3)
  })

  it('disables agent settings offline and ignores settlement from a replaced connection', async () => {
    const b = bench()
    const pending = Promise.withResolvers<string>()
    b.openLocalAgents.mockReturnValueOnce(pending.promise)
    const view = await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: en.configureAgents }))
    view.rerender(<MarketplaceTab {...b.props} useConnectionGeneration={select => select(undefined)} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.configureAgents }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.configureAgents }))
    await act(async () => { pending.resolve('unconfirmed'); await pending.promise })
    expect(screen.queryByText(en.agentsUnconfirmed)).toBeNull()
    expect(b.openLocalAgents).toHaveBeenCalledOnce()
    view.rerender(<MarketplaceTab {...b.props} />)
    await screen.findByText('Example Bundle')
    const leaving = Promise.withResolvers<string>()
    b.openLocalAgents.mockReturnValueOnce(leaving.promise)
    fireEvent.click(screen.getByRole('button', { name: en.configureAgents }))
    view.unmount()
    await act(async () => { leaving.reject(new Error('disconnected')); await leaving.promise.catch(() => {}) })
    expect(b.openLocalAgents).toHaveBeenCalledTimes(2)
  })
  it('renders plugin-owned actions only for confirmed active layers, not pending or trial combinations', async () => {
    const b = bench({ ...base, selection: { ...base.selection, pending: candidate }, profiles: [
      { profile: base.selection.activeProfile, state: 'read', bundles: [
        { packageName: '@test/example', version: '1', removable: true },
        { packageName: 'unknown-version', version: null, removable: false },
      ] },
      { profile: candidate.profile, state: 'read', bundles: [{ packageName: 'pending-only', version: '2', removable: true }] },
    ] })
    await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(b.renderSlot).toHaveBeenCalledWith('settings.bundleMarketplace.action', { close: b.close }, { entryKey: '@test/example' })
    expect(b.renderSlot).not.toHaveBeenCalledWith('settings.bundleMarketplace.action', { close: b.close }, { entryKey: 'pending-only' })
    expect(b.renderSlot).not.toHaveBeenCalledWith('settings.bundleMarketplace.action', { close: b.close }, { entryKey: 'unknown-version' })
    b.renderSlot.mockClear()
    b.read.mockResolvedValue({ ...base, selection: { ...base.selection, trial: candidate }, profiles: [
      { profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: '1', removable: true }] },
    ] })
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await screen.findByText(en.trial)
    expect(b.renderSlot).not.toHaveBeenCalled()
  })
  it('reviews removal of the observed version and refreshes without retrying an uncertain command', async () => {
    const b = bench({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'read',
      bundles: [{ packageName: '@test/example', version: '1.0.0', removable: true }] }] })
    await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    expect(screen.getByRole('group', { name: en.removeReview })).toBeTruthy()
    expect(b.remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(screen.queryByRole('group', { name: en.removeReview })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    b.remove.mockResolvedValueOnce('unconfirmed')
    b.read.mockResolvedValue({ ...base, selection: { ...base.selection, pending: candidate } })
    fireEvent.click(screen.getByRole('button', { name: en.confirmRemove }))
    await screen.findByText(en.unconfirmed)
    expect(await screen.findAllByText(en.pending)).not.toHaveLength(0)
    expect(b.remove).toHaveBeenCalledExactlyOnceWith('web', '@test/example', '1.0.0')
    expect(screen.queryByRole('group', { name: en.removeReview })).toBeNull()
  })
  it('shows selected and pending versions without offering duplicate installation', async () => {
    const b = bench({ ...base, selection: { ...base.selection, pending: candidate }, profiles: [
      { profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: '1.0.0', removable: true }, { packageName: 'missing', version: null, removable: false }] },
      { profile: candidate.profile, state: 'read', bundles: [{ packageName: '@test/example', version: '2.0.0', removable: true }] },
    ] })
    await ready(b.props)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.included }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(screen.getByText(en.inventoryHint)).toBeTruthy()
    expect(screen.getByText('Package version: 1.0.0')).toBeTruthy()
    expect(screen.getByText('Package version: 2.0.0')).toBeTruthy()
    expect(screen.getByText(en.versionUnknown)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.discover }))
    expect(screen.queryByText(en.inventoryHint)).toBeNull()
    expect(b.install).not.toHaveBeenCalled()
  })
  it('disables installation for unreadable current metadata and distinguishes trial and empty Profiles', async () => {
    const b = bench({ ...base, selection: { ...base.selection, trial: candidate }, profiles: [
      { profile: base.selection.activeProfile, state: 'unavailable' },
      { profile: candidate.profile, state: 'read', bundles: [] },
    ] })
    await ready(b.props)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.install }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.installed }))
    expect(screen.getAllByText(en.inventoryFailed).length).toBeGreaterThan(0)
    expect(screen.getByText(en.noInstalled)).toBeTruthy()
  })
  it('does not reinstall a listed package whose installed version cannot be read', async () => {
    const b = bench({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'read', bundles: [{ packageName: '@test/example', version: null, removable: false }] }] })
    await ready(b.props)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.replace }).disabled).toBe(true)
    expect(screen.getByText(en.versionUnknown)).toBeTruthy()
  })
  it.each([false, true])('reviews exact version replacement and fences the original observation (Arabic=%s)', async (arabic) => {
    const copy = en
    const b = bench({ ...base, profiles: [{ profile: base.selection.activeProfile, state: 'read',
      bundles: [{ packageName: '@test/example', version: '2.0.0', removable: true }] }] }, arabic)
    await ready(b.props)
    fireEvent.click(screen.getByRole('button', { name: copy.replace }))
    expect(screen.getByRole('group', { name: copy.replaceReview })).toBeTruthy()
    expect(screen.getByText('2.0.0 → 1.0.0')).toBeTruthy()
    expect(screen.getByText(copy.replaceHint)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: copy.dismiss }))
    expect(b.install).not.toHaveBeenCalled()
    b.read.mockResolvedValue({ ...base, selection: { ...base.selection, pending: candidate } })
    fireEvent.click(screen.getByRole('button', { name: copy.confirmReplace }))
    await screen.findAllByText(copy.pending)
    expect(b.install).toHaveBeenCalledExactlyOnceWith('example', 'web', '2.0.0', 'review')
  })
  it('requires review and refreshes native state after acknowledged installation', async () => {
    const b = bench()
    await ready(b.props)
    await review()
    expect(b.install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(screen.queryByRole('group', { name: en.review })).toBeNull()
    await review()
    b.read.mockResolvedValue({ ...base, selection: { ...base.selection, pending: candidate } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await screen.findByText(en.pending)
    expect(b.install).toHaveBeenCalledExactlyOnceWith('example', 'web', null, 'review')
    expect(screen.queryByRole('button', { name: en.confirm })).toBeNull()
    b.read.mockResolvedValue(base)
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByText(en.pending)).toBeNull() })
    expect(b.cancel).toHaveBeenCalledExactlyOnceWith(candidate.profile)
  })
  it.each(['unconfirmed', 'throw'])('reconciles an uncertain %s response without retrying installation', async (result) => {
    const b = bench()
    if (result === 'throw') b.install.mockRejectedValueOnce(new Error('offline'))
    else b.install.mockResolvedValueOnce('unconfirmed')
    await ready(b.props)
    await review()
    b.read.mockResolvedValue({ ...base, selection: { ...base.selection, pending: candidate } })
    fireEvent.click(screen.getByRole('button', { name: en.confirm }))
    await screen.findByText(en.unconfirmed)
    await screen.findByText(en.pending)
    expect(b.install).toHaveBeenCalledOnce()
  })
  it('disables incompatible candidates and renders recovery and trial facts', async () => {
    const b = bench({ ...base, entries: [{ ...base.entries[0]!, issues: ['harness-version', 'platform', 'artifact-size'] }],
      selection: { ...base.selection, trial: candidate, lastFailure: { candidate, reason: 'startup-failed' } } })
    await ready(b.props)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.install }).disabled).toBe(true)
    expect(screen.getByText(en['harness-version'])).toBeTruthy()
    expect(screen.getByText(en.trial)).toBeTruthy()
    expect(screen.getByText(en.recovered)).toBeTruthy()
  })
  it('rejects stale reads across disconnect and reconnect, while manual refresh recovers failures', async () => {
    const b = bench()
    const oldRead = Promise.withResolvers<MarketplaceSnapshot>()
    b.read.mockReturnValueOnce(oldRead.promise)
    const view = render(<MarketplaceTab {...b.props} />)
    view.rerender(<MarketplaceTab {...b.props} useConnectionGeneration={select => select(undefined)} />)
    expect(screen.getByText(en.offline)).toBeTruthy()
    await act(async () => { oldRead.resolve(base); await oldRead.promise })
    expect(screen.queryByText('Example Bundle')).toBeNull()
    b.read.mockRejectedValueOnce(new Error('unavailable'))
    view.rerender(<MarketplaceTab {...b.props} useConnectionGeneration={select => select({ id: 2, host: { home: '/test' } })} />)
    await screen.findByText(en.readFailed)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await screen.findByText('Example Bundle')
    expect(b.install).not.toHaveBeenCalled()
  })
  it.each(['resolve', 'reject'])('contains late operation %s after unmount and prevents duplicate clicks', async (settlement) => {
    const b = bench()
    const held = Promise.withResolvers<'acknowledged'>()
    b.install.mockReturnValueOnce(held.promise)
    const view = await ready(b.props)
    await review()
    const confirm = screen.getByRole('button', { name: en.confirm })
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm) })
    expect(b.install).toHaveBeenCalledOnce()
    expect(screen.getByText(en.preparing)).toBeTruthy()
    view.unmount()
    await act(async () => {
      if (settlement === 'resolve') held.resolve('acknowledged')
      else held.reject(new Error('Disconnected'))
      await held.promise.catch(() => {})
    })
    expect(b.read).toHaveBeenCalledOnce()
  })
  it('ignores a failed read after its connection generation is replaced', async () => {
    const b = bench()
    const old = Promise.withResolvers<MarketplaceSnapshot>()
    b.read.mockReturnValueOnce(old.promise)
    const view = render(<MarketplaceTab {...b.props} />)
    view.rerender(<MarketplaceTab {...b.props} useConnectionGeneration={select => select({ id: 2, host: { home: '/test' } })} />)
    await screen.findByText('Example Bundle')
    await act(async () => { old.reject(new Error('Old read failed')); await old.promise.catch(() => {}) })
    expect(screen.queryByText(en.readFailed)).toBeNull()
  })
  it('provides a localized empty catalog instead of invented installable entries', async () => {
    const b = bench({ ...base, entries: [] }, true)
    render(<MarketplaceTab {...b.props} />)
    await screen.findByText(en.empty)
    expect(screen.getByText(en.trust)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.install })).toBeNull()
  })
})
