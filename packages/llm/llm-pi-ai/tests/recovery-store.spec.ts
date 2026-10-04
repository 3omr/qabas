/** Credential resets preserve model facts across host storage hydration and restart. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { RecoveryMemory } from '../src/recovery-memory.ts'
import { RecoveryStore } from '../src/recovery-store.ts'
import type { RecoveryObservation } from '../src/recovery-store.ts'
import * as PiAi from '../src/index.ts'
import { CredentialsController } from '../../../api/settings-controller/src/credentials.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

let context: Context | undefined
let directory: string | undefined
let store: RecoveryStore | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function storageContext(): Promise<Context> {
  directory ??= await mkdtemp(join(tmpdir(), 'pi-credential-reset-'))
  context = new Context()
  await context.plugin(Storage)
  await context.plugin(StorageJson, { root: directory })
  await context.plugin(StorageDomain, { backend: 'json' })
  return context
}

async function storedObservations(): Promise<RecoveryObservation[]> {
  const persisted = JSON.parse(await readFile(join(directory!, 'llm_pi_ai_recovery.json'), 'utf8')) as {
    tables: { models: Record<string, RecoveryObservation> }
  }
  return Object.values(persisted.tables.models)
}

describe('credential-scoped recovery exclusions', () => {
  it.each([false, true])('clears persisted exclusions before hydration even when storage arrives later (late=%s)', async (late) => {
    const ctx = await storageContext()
    const facility = ctx.get('storageDomain')
    store = new RecoveryStore(new RecoveryMemory())
    await store.ready(facility)
    await store.remember({ kind: 'daily', provider: 'google', model: 'flash', timeZone: 'UTC', resetDate: '2099-01-01' })
    await store.remember({ kind: 'unavailable', provider: 'google', model: 'retired' })
    await store.remember({ kind: 'daily', provider: 'other', model: 'flash', timeZone: 'UTC', resetDate: '2099-01-01' })
    await store.close()
    const memory = new RecoveryMemory()
    store = new RecoveryStore(memory)
    await store.clearQuota('google', late ? undefined : facility)
    if (!late) expect((await storedObservations()).some(observation => observation.provider === 'google' && observation.kind === 'daily')).toBe(false)
    await store.ready(facility)
    expect(memory.isExcluded('google', 'flash', 'UTC')).toBe(false)
    expect(memory.isExcluded('google', 'retired', 'UTC')).toBe(true)
    expect(memory.isExcluded('other', 'flash', 'UTC')).toBe(true)
    const persisted = await storedObservations()
    expect(persisted).toEqual(expect.arrayContaining([
      { kind: 'unavailable', provider: 'google', model: 'retired' },
      expect.objectContaining({ kind: 'daily', provider: 'other', model: 'flash' }),
    ]))
    expect(persisted.some(observation => observation.provider === 'google' && observation.kind === 'daily')).toBe(false)
  })

  it('clears persisted Google quotas before the first request when its route is dormant', async () => {
    const ctx = await storageContext()
    store = new RecoveryStore(new RecoveryMemory())
    await store.ready(ctx.get('storageDomain'))
    await store.remember({ kind: 'daily', provider: 'google', model: 'flash', timeZone: 'UTC', resetDate: '2099-01-01' })
    await store.remember({ kind: 'unavailable', provider: 'google', model: 'retired' })
    await store.close()
    store = undefined
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(PiAi, {})
    await ctx.plugin(MemoryCredentials)
    await new CredentialsController(ctx).set('GEMINI_API_KEY', 'new-key')
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
    context = undefined
    const restarted = await storageContext()
    const memory = new RecoveryMemory()
    store = new RecoveryStore(memory)
    await store.ready(restarted.get('storageDomain'))
    expect(memory.observation('google', 'flash')).toBeUndefined()
    expect(memory.observation('google', 'retired')?.kind).toBe('unavailable')
  })

  it('clears only the provider quota in memory and preserves unavailable models and thinking', () => {
    const memory = new RecoveryMemory()
    memory.exhaust('google', 'flash', 'America/Los_Angeles')
    memory.exhaust('google', 'pro', 'America/Los_Angeles')
    memory.exhaust('other', 'flash', 'UTC')
    memory.restore({ kind: 'unavailable', provider: 'google', model: 'retired' })
    memory.learnThinking('google', 'flash', 'minimal', 'low')
    memory.clearQuota('google')
    expect(memory.isExcluded('google', 'flash', 'America/Los_Angeles')).toBe(false)
    expect(memory.isExcluded('google', 'pro', 'America/Los_Angeles')).toBe(false)
    expect(memory.isExcluded('google', 'retired', 'America/Los_Angeles')).toBe(true)
    expect(memory.isExcluded('other', 'flash', 'UTC')).toBe(true)
    expect(memory.correctedThinking('google', 'flash', 'minimal')).toBe('low')
  })

  it.each([false, true])('clears hydrated and queued quotas durably without deleting other providers (storage=%s)', async (persisted) => {
    let memory = new RecoveryMemory()
    store = new RecoveryStore(memory)
    if (persisted) await storageContext()
    const facility = context?.get('storageDomain')
    await store.ready(facility)
    await store.remember(memory.exhaust('google', 'flash', 'UTC'))
    await store.remember(memory.exhaust('other', 'flash', 'UTC'))
    await store.remember({ kind: 'unavailable', provider: 'google', model: 'retired' })
    if (persisted) {
      await store.close()
      memory = new RecoveryMemory()
      store = new RecoveryStore(memory)
      // Clearing races the initial read; hydration must not restore the old key's quotas afterward.
      const hydration = store.ready(facility)
      await store.clearQuota('google', facility)
      await hydration
    }
    const queued = store.remember({ kind: 'daily', provider: 'google', model: 'pro', timeZone: 'UTC', resetDate: '2099-01-01' })
    const reset = store.clearQuota('google', facility)
    const late = store.remember({ kind: 'daily', provider: 'google', model: 'late', timeZone: 'UTC', resetDate: '2099-01-01' })
    await Promise.all([queued, reset, late])
    if (persisted) {
      await store.close()
      memory = new RecoveryMemory()
      store = new RecoveryStore(memory)
      await store.ready(facility)
    }
    expect(memory.observation('google', 'flash')).toBeUndefined()
    expect(memory.observation('google', 'pro')).toBeUndefined()
    expect(memory.observation('google', 'late')).toBeUndefined()
    expect(memory.observation('google', 'retired')?.kind).toBe('unavailable')
    expect(memory.observation('other', 'flash')?.kind).toBe('daily')
  })
})
