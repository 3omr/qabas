// @vitest-environment jsdom
/** Plugin assembly admits background actions while retaining explicit conversation navigation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, Config } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { en } from '../src/client/locales.ts'

const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  localStorage.clear()
})

async function mount(startupPanel: 'library' | 'conversation', deferred = false) {
  const ctx = new Context()
  roots.push(ctx)
  const sessions = new TestSessions(async (task) => { await task() }, ctx)
  ctx.provide('sessions', sessions)
  sessions.stubCreate(async () => sessions.add({ id: 'assistant' }, { current: false }))
  const panels = vi.fn()
  ctx.provide('layout', { selectPanel: panels })
  const dictionaries = vi.fn((_namespace: string, _dictionaries: unknown) => () => {})
  ctx.provide('locale', {
    register: dictionaries,
    bind: () => (key: keyof typeof en) => en[key],
  })
  ctx.provide('uiSession', { pendingInteractions: createSnapshotStore(new Map()) })
  ctx.provide('uiConversation', {})
  ctx.provide('remote', { transcriberEngine: {
    listModules: async () => ({ ok: true, value: { workspace: '/study', modules: [] } }),
    listLectures: async () => ({ ok: true, value: { lectures: [], materials: [] } }),
  } })
  const contributions: { name: string; key?: string; label?: () => string; inject?: () => { ask?: () => void; show?: () => void } }[] = []
  let registered = !deferred
  let changed = () => {}
  ctx.provide('slots', {
    inject: (_name: string, register: () => void) => { register() },
    register: (options: typeof contributions[number]) => { contributions.push(options); return () => {} },
    entries: () => registered ? contributions.map(options => ({ options })) : [],
    subscribe: (_name: string, listener: () => void) => { changed = listener; return () => {} },
  })
  const fiber = ctx.plugin({ apply, Config }, { startupPanel })
  await fiber.await()
  return { ctx, panels, dictionaries, contributions, registered: () => { registered = true; changed() }, changed: () => { changed() } }
}

describe('library plugin', () => {
  it('validates the deployment concurrency and registers background actions', async () => {
    expect(Config({}).jobConcurrency).toBe(2)
    for (const jobConcurrency of [0, -1, 1.5]) expect(() => Config({ jobConcurrency })).toThrow()
    const b = await mount('library', true)
    expect(b.panels).not.toHaveBeenCalled()
    b.changed()
    b.registered()
    b.changed()
    expect(b.panels).toHaveBeenCalledTimes(1)
    expect(b.panels).toHaveBeenCalledWith('library')
    expect(b.ctx.library.actions.getSnapshot().map(action => action.id)).toEqual(['transcribe', 'continue', 'questions', 'audit'])
    expect(b.ctx.libraryJobs.jobs.getSnapshot()).toEqual([])
    expect(b.dictionaries.mock.calls[0]?.[0]).toBe('library')
    expect(b.contributions.find(entry => entry.name === 'sidebar.panellist')?.label?.()).toBe('Library')
    b.contributions.find(entry => entry.name === 'sidebar.library')?.inject?.().show?.()
    b.contributions.find(entry => entry.name === 'main')?.inject?.().ask?.()
    await vi.waitFor(() => { expect(b.panels).toHaveBeenLastCalledWith('conversation') })
    expect(b.ctx.sessions.list.getSnapshot().current).toBe('assistant')
    hostApply()
  })

  it('preserves a conversation startup selection', async () => {
    const b = await mount('conversation')
    expect(b.panels).not.toHaveBeenCalled()
    expect(b.ctx.library.state.getSnapshot().workspace).toBe('/study')
  })
})
