// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as connectionApply } from '@deepseek-ai/dsh-client-connection/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { MarketplaceTab, type MarketplaceInjected } from '../src/client/MarketplaceTab.tsx'

vi.mock('@deepseek-ai/dsh-bundle-marketplace/remote', () => ({ default: {} }))
usePinnedBrowserLanguages('en-CN')
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

describe('marketplace browser registration', () => {
  it('mounts its own Remote and retracts tab, namespace and dictionary on disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin({ apply: connectionApply }).await()
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const snapshot = vi.fn().mockResolvedValue({ ok: true, value: { entries: [] } })
    const history = vi.fn().mockResolvedValue({ ok: true, value: [] })
    const refreshCatalog = vi.fn().mockResolvedValue({ ok: true, value: 'acknowledged' })
    const install = vi.fn().mockResolvedValue({ ok: true, value: 'acknowledged' })
    const cancel = vi.fn().mockResolvedValue({ ok: true, value: 'acknowledged' })
    const openLocalAgents = vi.fn().mockResolvedValue({ ok: true, value: 'acknowledged' })
    const remove = vi.fn().mockResolvedValue({ ok: true, value: 'acknowledged' })
    const dispose = vi.fn().mockResolvedValue(undefined)
    const mount = vi.fn().mockResolvedValue(dispose)
    ctx.provide('remote', { $mount: mount, bundleMarketplace: { snapshot, history, refreshCatalog, queueActivation: install, queueRemoval: remove, cancel, openLocalAgents } } as never)
    ctx.provide('remote.bundleMarketplace', { snapshot, history, refreshCatalog, queueActivation: install, queueRemoval: remove, cancel, openLocalAgents })
    const slots = ctx.get('slots') as SlotRegistry
    const fiber = ctx.plugin({ apply, inject })
    await fiber.await()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    const declare = () => slots.register({ name: 'root', children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } } } as never, () => null)
    const stop = declare()
    await vi.waitFor(() => { expect(slots.entries('settings.plugins.tab')).toHaveLength(1) })
    const entry = slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(MarketplaceTab)
    expect(resolveSlotLabel(entry.options.label)).toBe('Marketplace')
    expect(snapshot).not.toHaveBeenCalled()
    const callbacks = (entry.inject as unknown as () => MarketplaceInjected)()
    expect(callbacks.catalogLanguage()).toBe('en')
    await expect(callbacks.openLocalAgents()).resolves.toBe('acknowledged')
    expect(openLocalAgents).toHaveBeenCalledExactlyOnceWith()
    openLocalAgents.mockResolvedValueOnce({ ok: false })
    await expect(callbacks.openLocalAgents()).resolves.toBe('unconfirmed')
    await expect(callbacks.snapshot()).resolves.toEqual({ entries: [] })
    await expect(callbacks.refreshCatalog()).resolves.toBe('acknowledged')
    refreshCatalog.mockResolvedValueOnce({ ok: false })
    await expect(callbacks.refreshCatalog()).resolves.toBe('unconfirmed')
    await expect(callbacks.history()).resolves.toEqual([])
    history.mockResolvedValueOnce({ ok: false })
    await expect(callbacks.history()).rejects.toThrow('Marketplace history is unavailable')
    await expect(callbacks.install('fixture' as never, 'web' as never, null, 'review' as never)).resolves.toBe('acknowledged')
    expect(install).toHaveBeenLastCalledWith('fixture', 'web', null, 'review')
    await expect(callbacks.cancel('pending' as never)).resolves.toBe('acknowledged')
    await expect(callbacks.remove('web' as never, 'fixture', '1')).resolves.toBe('acknowledged')
    remove.mockResolvedValueOnce({ ok: false })
    await expect(callbacks.remove('web' as never, 'fixture', '1')).resolves.toBe('unconfirmed')
    snapshot.mockResolvedValueOnce({ ok: false })
    install.mockResolvedValueOnce({ ok: false })
    cancel.mockResolvedValueOnce({ ok: false })
    await expect(callbacks.snapshot()).rejects.toThrow('Marketplace snapshot is unavailable')
    await expect(callbacks.install('fixture' as never, 'web' as never, '0.9', 'review' as never)).resolves.toBe('unconfirmed')
    expect(install).toHaveBeenLastCalledWith('fixture', 'web', '0.9', 'review')
    await expect(callbacks.cancel('pending' as never)).resolves.toBe('unconfirmed')
    stop()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    declare()
    await vi.waitFor(() => { expect(slots.entries('settings.plugins.tab')).toHaveLength(1) })
    locale.setLocale('en')
    expect(callbacks.catalogLanguage()).toBe('en')
    expect(resolveSlotLabel(slots.entries('settings.plugins.tab')[0]!.options.label)).toBe('Marketplace')
    await fiber.dispose()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    expect(dispose).toHaveBeenCalledOnce()
    expect(() => locale.register('settings.bundleMarketplace', 'en', {})).not.toThrow()
  })
})
