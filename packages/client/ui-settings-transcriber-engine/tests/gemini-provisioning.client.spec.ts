/** Saving a student key provisions only the native Google route and a conditional Flash default. */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote, RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { geminiKeyOf } from '../src/client/gemini-key.ts'
import { preferredGeminiFlash, type GeminiProvisioningRemote } from '../src/client/gemini-provisioning.ts'

const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
function fixture(providers: Record<string, Record<string, string>> = {}, initial?: { provider: string; model: string }) {
  let namespace: SettingsNamespaceView = { ns: 'llm-pi-ai', schema: {}, value: { providers }, user: { providers },
    applies: 'live', secrets: [], revision: 7 }
  let selection = initial
  const stored = new Map<string, string>()
  const credentials = {
    describe: async () => ok({ GEMINI_API_KEY: { configured: stored.has('GEMINI_API_KEY'), writable: true } }),
    checkGeminiKey: async () => ok({ status: 'works' as const }),
    set: vi.fn(async (ref: string, value: string) => { stored.set(ref, value); return ok(undefined) }),
    unset: vi.fn(async (ref: string) => { stored.delete(ref); return ok(undefined) }),
  } satisfies Pick<ClientRemote['credentials'], 'describe' | 'checkGeminiKey' | 'set' | 'unset'>
  const provisioning = {
    settings: {
      describe: vi.fn(async () => ok({ writable: true, hasDocument: false, namespaces: [namespace] })),
      mutate: vi.fn<GeminiProvisioningRemote['settings']['mutate']>(async (_ns, ops, revision) => {
        if (revision !== namespace.revision) throw new Error('stale provisioning write')
        if (ops.length !== 1 || ops[0]?.op !== 'set') throw new Error('unexpected path operation')
        namespace = { ...namespace, value: { providers: { ...providers, google: {} } }, revision: namespace.revision + 1 }
        return ok(namespace)
      }),
    },
    llm: { discoverModels: vi.fn(async () => ok([
      { id: 'gemini-2.5-flash', maxTokens: 65536 }, { id: 'gemini-4.0-pro', maxTokens: 100000 },
      { id: 'gemini-3.8-flash' }, { id: 'gemini-3.9-flash-preview' }, { id: 'gemini-3.9-flash-lite' },
    ])) },
    session: { saveDefaultModelIfUnset: vi.fn(async (wanted: { provider: string; model: string }) => {
      selection ??= wanted
      return ok(undefined)
    }) },
  } satisfies GeminiProvisioningRemote
  return { key: geminiKeyOf(credentials, () => () => {}, provisioning), credentials, provisioning,
    stored, profile: () => namespace.value, selection: () => selection }
}

describe('stored Gemini key provisioning', () => {
  it('makes a fresh install usable with an empty native profile and newest main Flash default', async () => {
    const app = fixture({ other: { baseURL: 'https://retained.example' } })
    expect(await app.key.save('student-secret')).toBeUndefined()
    expect(app.stored.get('GEMINI_API_KEY')).toBe('student-secret')
    expect(app.profile()).toEqual({ providers: { other: { baseURL: 'https://retained.example' }, google: {} } })
    expect(app.provisioning.settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'google'], value: {} }], 7)
    expect(app.provisioning.llm.discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'google' })
    expect(app.selection()).toEqual({ provider: 'google', model: 'gemini-3.8-flash' })
    expect(JSON.stringify(app.profile())).not.toContain('student-secret')
  })

  it('preserves an existing profile/default on save and retains them when the key is removed', async () => {
    const app = fixture({ google: { baseURL: 'https://existing.example' } }, { provider: 'google', model: 'gemini-2.5-flash' })
    expect(await app.key.save('new-key')).toBeUndefined()
    expect(app.provisioning.settings.mutate).not.toHaveBeenCalled()
    expect(app.selection()).toEqual({ provider: 'google', model: 'gemini-2.5-flash' })
    expect(await app.key.remove()).toBeUndefined()
    expect(app.stored.has('GEMINI_API_KEY')).toBe(false)
    expect(app.profile()).toEqual({ providers: { google: { baseURL: 'https://existing.example' } } })
    expect(app.selection()).toEqual({ provider: 'google', model: 'gemini-2.5-flash' })
    expect(await app.key.save('later-key')).toBeUndefined()
    expect(app.stored.get('GEMINI_API_KEY')).toBe('later-key')
  })

  it('does not provision when storing the key is refused', async () => {
    const app = fixture()
    app.credentials.set.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'read-only credentials', {}) })
    expect(await app.key.save('key')).toBe('read-only credentials')
    expect(app.provisioning.settings.describe).not.toHaveBeenCalled()
  })

  it('reports a concurrent profile write refusal without setting a default or losing the saved credential', async () => {
    const app = fixture()
    app.provisioning.settings.mutate.mockResolvedValueOnce({ ok: false, error: new RemoteError('settings/conflict', 'settings changed', { ns: 'llm-pi-ai', expected: 7, actual: 8 }) })
    expect(await app.key.save('key')).toBe('settings changed')
    expect(app.stored.get('GEMINI_API_KEY')).toBe('key')
    expect(app.provisioning.llm.discoverModels).not.toHaveBeenCalled()
    expect(app.selection()).toBeUndefined()
  })

  it('reports discovery failure and permits retry without removing the new route', async () => {
    const app = fixture()
    app.provisioning.llm.discoverModels.mockRejectedValueOnce(new Error('catalog unavailable'))
    expect(await app.key.save('key')).toBe('catalog unavailable')
    expect(app.profile()).toEqual({ providers: { google: {} } })
    expect(app.selection()).toBeUndefined()
    expect(await app.key.save('key')).toBeUndefined()
    expect(app.selection()?.provider).toBe('google')
  })
})

it('chooses version components in order and never chooses a preview, lite or non-Flash model', () => {
  expect(preferredGeminiFlash([{ id: 'gemini-3.9-flash' }, { id: 'gemini-3.10-flash' },
    { id: 'gemini-4.0-flash-preview' }, { id: 'gemini-4.0-flash-lite' }, { id: 'gemini-5.0-pro' }])?.id).toBe('gemini-3.10-flash')
  expect(preferredGeminiFlash([{ id: 'gemini-flash-latest' }])?.id).toBe('gemini-flash-latest')
  expect(preferredGeminiFlash([{ id: 'gemini-3.8-pro' }])).toBeUndefined()
})
