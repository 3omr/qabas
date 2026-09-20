/** Page-store join: directory × namespaces × credentials, with last-good rows on failure. */
import { describe, expect, it } from 'vitest'
import type { CredentialInfo, RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore, joinProviderDirectory } from '../src/client/store.ts'
import { settingsSchema } from './settings-schema.client.ts'

function remoteOk<T>(value: T): RemoteResult<T> { return { ok: true, value } }
function remoteFail<T>(message: string): RemoteResult<T> { return { ok: false, error: new RemoteError('gateway/internal', message, {}) } }

type SettingsDescribeValue = {
  writable: boolean
  hasDocument: boolean
  namespaces: readonly SettingsNamespaceView[]
}

const namespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai', schema: {}, value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
  user: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }, base: { providers: {} }, applies: 'live', secrets: [], revision: 2,
}

function api(overrides: {
  providers?: () => Promise<RemoteResult<readonly object[]>>
  describeSettings?: () => Promise<RemoteResult<SettingsDescribeValue>>
  describeCredentials?: (refs: readonly string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
} = {}) {
  const directory = [
    { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    { provider: 'google', displayName: 'Google', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'google'] },
  ]
  const providers = overrides.providers ?? (() => Promise.resolve(remoteOk(directory)))
  const face = {
    llm: {
      listProviders: () => Promise.resolve(remoteOk([{ id: 'openai', name: 'openai' }, { id: 'google', name: 'Google' }])),
      listConfigurableProviders: providers,
      discoverModels: () => Promise.resolve(remoteOk([])),
    },
    settings: {
      describe: overrides.describeSettings ?? (() => Promise.resolve(remoteOk({
        writable: true, hasDocument: false, namespaces: [namespace],
      }))),
      mutate: () => Promise.resolve(remoteFail('writes are outside this store test')),
    },
    credentials: {
      describe: (refs: readonly string[]) => overrides.describeCredentials?.(refs) ?? Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
      )),
      set: () => Promise.resolve(remoteOk(undefined)), unset: () => Promise.resolve(remoteOk(undefined)),
    },
  }
  const ctx = { remote: face } as never
  return { ctx, face, mirror: new SettingsDescribeMirror(ctx) }
}

describe('joinProviderDirectory', () => {
  it('keeps declared diagnostics and appends registered undeclared routes', () => {
    expect(joinProviderDirectory([{ id: 'live', name: 'Live' }], [{
      provider: 'configured', displayName: 'Configured', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'configured'], error: 'repair me',
    }])).toEqual([
      { provider: 'configured', displayName: 'Configured', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'configured'], active: false, error: 'repair me' },
      { provider: 'live', displayName: 'Live', settingsNs: '', settingsPath: [], active: true },
    ])
  })
})

describe('ModelsSettingsStore', () => {
  it('joins route configuration and pi-ai credential references', async () => {
    const { ctx, mirror } = api()
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    const snapshot = store.store.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.rows.find(row => row.entry.provider === 'openai')).toMatchObject({
      configured: true, apiKeyEnv: 'OPENAI_API_KEY', credential: { configured: true },
    })
    expect(snapshot.rows.find(row => row.entry.provider === 'google')).toMatchObject({
      configured: false, apiKeyEnv: undefined, derivedCredential: { configured: false },
    })
  })

  it('uses documented non-conventional references for dormant providers', async () => {
    const seen: string[][] = []
    const { ctx, mirror } = api({
      describeSettings: () => Promise.resolve(remoteOk({
        writable: true, hasDocument: false, namespaces: [{ ...namespace, value: { providers: {} }, user: {} }],
      })),
      describeCredentials: (refs) => {
        seen.push([...refs])
        return Promise.resolve(remoteOk(Object.fromEntries(refs.map(ref => [ref, { configured: false, writable: true }]))))
      },
    })
    const store = new ModelsSettingsStore(ctx, settingsSchema, mirror)
    await store.load()
    expect(seen).toEqual([['OPENAI_API_KEY', 'GEMINI_API_KEY']])
  })

  it('surfaces directory and credential failures without inventing rows', async () => {
    const broken = api({ providers: () => Promise.resolve(remoteFail('directory down')) })
    const store = new ModelsSettingsStore(broken.ctx, settingsSchema, broken.mirror)
    await store.load()
    expect(store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'directory down' })

    const credentials = api({ describeCredentials: () => Promise.resolve(remoteFail('credentials down')) })
    const loaded = new ModelsSettingsStore(credentials.ctx, settingsSchema, credentials.mirror)
    await loaded.load()
    expect(loaded.store.getSnapshot()).toMatchObject({ status: 'ready', credentialError: 'credentials down' })
  })

  it('lets the newest load win', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    let call = 0
    const fixture = api({ providers: async () => {
      call += 1
      if (call === 1) { await gate; return remoteFail('stale') }
      return remoteOk([{ provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] }])
    } })
    const store = new ModelsSettingsStore(fixture.ctx, settingsSchema, fixture.mirror)
    const first = store.load(); const second = store.load(); release?.()
    await Promise.all([first, second])
    expect(store.store.getSnapshot().status).toBe('ready')
  })
})
