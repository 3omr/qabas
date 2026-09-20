// @vitest-environment jsdom
/** Catalog DOM, pi-ai editor writes, and provider-state behavior. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { CredentialInfo, RemoteResult, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { ModelsSection, removeProviderProfile } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionInjected, ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import { ProviderEditor, pathOps } from '../src/client/ProviderEditor.tsx'
import { apiKeyFailure } from '../src/client/apiKey.ts'
import { createModelsOperations } from '../src/client/operations.ts'
import { formatCapacity, modelDrafts, parseCapacity, validateModelDrafts } from '../src/client/model-catalog.ts'
import { providerKeyRef, providerStanding, ModelsSettingsStore } from '../src/client/store.ts'
import type { ModelsOperations } from '../src/client/operations.ts'
import type { ProviderRow } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'

afterEach(cleanup)

const t: ModelsSectionInjected['t'] = key => en[key]
const PiAiConfig = Schema.object({
  providers: Schema.dict(Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref'),
    displayName: Schema.string(),
    api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({
      id: Schema.string().required(), name: Schema.string(), contextWindow: Schema.number(), maxTokens: Schema.number(),
    })),
  })),
})

function remoteOk<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function namespace(providers: Record<string, JsonValue> = { openai: { apiKeyEnv: 'OPENAI_API_KEY' } }): SettingsNamespaceView {
  return {
    ns: 'llm-pi-ai', schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
    value: { providers }, user: { providers }, base: { providers: {} }, applies: 'live', secrets: [], revision: 4,
  }
}

function scripted(overrides: {
  providers?: Record<string, JsonValue>
  listConfigurableProviders?: ReturnType<typeof vi.fn>
  credentials?: (refs: readonly string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
} = {}) {
  const current = namespace(overrides.providers)
  const listConfigurableProviders = overrides.listConfigurableProviders ?? vi.fn(() => Promise.resolve(remoteOk([
    { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
    { provider: 'zombie', displayName: 'zombie', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zombie'] },
  ])))
  const face = {
    authorization: { list: vi.fn(() => Promise.resolve(remoteOk([]))), run: vi.fn(), answer: vi.fn(), cancel: vi.fn() },
    llm: {
      listProviders: vi.fn(() => Promise.resolve(remoteOk([{ id: 'openai', name: 'openai' }, { id: 'anthropic', name: 'anthropic' }]))),
      listConfigurableProviders,
      discoverModels: vi.fn(() => Promise.resolve(remoteOk([]))),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve(remoteOk({ writable: true, hasDocument: false, namespaces: [current] }))),
      mutate: vi.fn(() => Promise.resolve(remoteOk(current))),
    },
    credentials: {
      describe: overrides.credentials ?? vi.fn((refs: readonly string[]) => Promise.resolve(remoteOk(
        Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'OPENAI_API_KEY', writable: true }])),
      ))),
      set: vi.fn(() => Promise.resolve(remoteOk(undefined))),
      unset: vi.fn(() => Promise.resolve(remoteOk(undefined))),
    },
    session: {
      saveDefaultModelIfUnset: vi.fn(() => Promise.resolve(remoteOk(undefined))),
    },
  }
  return { face, current }
}

async function mount(overrides: Parameters<typeof scripted>[0] = {}) {
  const value = scripted(overrides)
  const ctx = { remote: value.face } as never
  const controller = new ModelsSettingsStore(ctx, settingsSchema, new SettingsDescribeMirror(ctx))
  await controller.load()
  const renderSlot = vi.fn(() => null)
  const props: ModelsSectionProps = {
    controller, useSnapshot: bindSnapshotSelector(controller.store), operations: createModelsOperations(ctx),
    schema: settingsSchema, t, renderSlot,
  }
  const view = render(<ModelsSection {...props} />)
  return { ...value, controller, renderSlot, view, operations: props.operations }
}

function openProvider(provider: string, tab: 'authentication' | 'models' = 'models'): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${provider}`) }))
  fireEvent.click(screen.getByRole('tab', {
    name: tab === 'authentication' ? en['catalog.tabAuthentication'] : en['catalog.tabModels'],
  }))
}

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: true },
    configured: false, removable: false, apiKeyEnv: 'ANTHROPIC_API_KEY', credential: undefined, ...overrides,
  }
}

describe('ModelsSection catalog', () => {
  it('renders the catalog row and opens the model editor through catalog tabs', async () => {
    await mount()
    expect(screen.getByRole('button', { name: /openai.*Ready/ })).toBeTruthy()
    openProvider('openai')
    expect(screen.getByRole('button', { name: en.addModel })).toBeTruthy()
  })

  it('keeps a provider diagnostic visible in the catalog detail', async () => {
    const failure = 'catalog needs repair'
    const listed = vi.fn(() => Promise.resolve(remoteOk([
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], error: failure },
    ])))
    await mount({ listConfigurableProviders: listed })
    expect(screen.getByRole('alert').textContent).toContain(failure)
    openProvider('openai', 'authentication')
    expect(screen.getByLabelText(en.keyInput)).toBeTruthy()
  })

  it('does not remove a credential when removing its provider route', async () => {
    const removeCredential = vi.fn()
    const writeSettings = vi.fn(() => Promise.resolve({ kind: 'written' as const, view: namespace() }))
    const operations = { removeCredential, writeSettings } as unknown as ModelsOperations
    const controller = { load: vi.fn(() => Promise.resolve()) } as unknown as ModelsSettingsStore
    await removeProviderProfile(operations, controller, { settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] })
    expect(removeCredential).not.toHaveBeenCalled()
    expect(writeSettings).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'openai'] }], undefined)
  })
})

describe('provider and model helpers', () => {
  it('uses pi-ai environment names and a custom-route fallback', () => {
    expect(providerKeyRef('google')).toBe('GEMINI_API_KEY')
    expect(providerKeyRef('huggingface')).toBe('HF_TOKEN')
    expect(providerKeyRef('github-copilot')).toBe('COPILOT_GITHUB_TOKEN')
    expect(providerKeyRef('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(providerKeyRef('acme-gateway')).toBe('ACME_GATEWAY_API_KEY')
  })

  it('distinguishes ready, signed-in-without-route, and unset standings', () => {
    expect(providerStanding(row(), false)).toBe('unset')
    expect(providerStanding(row(), true)).toBe('attention')
    expect(providerStanding(row({ configured: true, credential: { configured: true, writable: true } }), false)).toBe('ready')
    expect(providerStanding(row({ configured: true, credential: { configured: false, writable: true } }), false)).toBe('attention')
  })

  it('keeps path writes minimal and model validation generic', () => {
    expect(pathOps(['providers', 'openai'], { baseURL: 'old', reasoning: 'high' }, { reasoning: 'high' }))
      .toEqual([{ op: 'unset', path: ['providers', 'openai', 'baseURL'] }])
    expect(modelDrafts([null, 'bad', { id: 'ok' }])).toEqual([{}, {}, { id: 'ok' }])
    expect(validateModelDrafts([{ id: 'same' }, { id: 'same' }])).toEqual({ index: 1, key: 'modelIdDuplicate' })
    expect(validateModelDrafts([{ id: 'ok', contextWindow: 1 }])).toBeUndefined()
  })

  it('round-trips decimal capacity spellings and rejects invalid keys', () => {
    expect(parseCapacity('2.3M')).toBe(2_300_000)
    expect(formatCapacity(256_000)).toBe('256K')
    expect(parseCapacity(formatCapacity(1_000_000))).toBe(1_000_000)
    expect(apiKeyFailure('OPENAI_API_KEY=secret')).toBe('keyIllegalCharacters')
    expect(apiKeyFailure('  ')).toBe('keyBlank')
  })
})

describe('ProviderEditor', () => {
  it('stores an API key under pi-ai’s documented reference and creates its route', async () => {
    const view = namespace({ providers: {} })
    const writeSettings = vi.fn(() => Promise.resolve({
      kind: 'written' as const,
      view: { ...view, user: { providers: { anthropic: {} } }, revision: 8 },
    }))
    const storeCredential = vi.fn(() => Promise.resolve(undefined))
    const saveDefaultModel = vi.fn(() => Promise.resolve(undefined))
    const operations: ModelsOperations = {
      listFlows: () => Promise.resolve([]),
      runFlow: async function* () {}, answer: () => Promise.resolve(), cancelFlow: () => Promise.resolve(),
      describeCredential: () => Promise.resolve(undefined), storeCredential, removeCredential: () => Promise.resolve(undefined),
      writeSettings,
      discoverModels: () => Promise.resolve({ kind: 'found' as const, models: [{ id: 'anthropic-first' }] }),
      saveDefaultModel,
    }
    render(<ProviderEditor provider="anthropic" displayName="Anthropic" namespace={view} schema={settingsSchema}
      settingsPath={['providers', 'anthropic']} operations={operations} t={t} readOnly={false} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: '  sk-anthropic  ' } })
    fireEvent.click(screen.getByText(en.apply))
    await waitFor(() => { expect(writeSettings).toHaveBeenCalledTimes(1) })
    expect(writeSettings).toHaveBeenCalledWith(
      'llm-pi-ai', [{ op: 'set', path: ['providers', 'anthropic'], value: {} }], 4,
    )
    expect(storeCredential).toHaveBeenCalledWith('ANTHROPIC_API_KEY', 'sk-anthropic')
    expect(saveDefaultModel).toHaveBeenCalledWith('anthropic', 'anthropic-first')
  })

  it('leaves the default unset when a newly provisioned route has no discovered models', async () => {
    const view = namespace({ providers: {} })
    const writeSettings = vi.fn(() => Promise.resolve({
      kind: 'written' as const,
      view: { ...view, user: { providers: { anthropic: {} } }, revision: 8 },
    }))
    const saveDefaultModel = vi.fn(() => Promise.resolve(undefined))
    const operations: ModelsOperations = {
      listFlows: () => Promise.resolve([]),
      runFlow: async function* () {}, answer: () => Promise.resolve(), cancelFlow: () => Promise.resolve(),
      describeCredential: () => Promise.resolve(undefined), storeCredential: () => Promise.resolve(undefined),
      removeCredential: () => Promise.resolve(undefined), writeSettings,
      discoverModels: () => Promise.resolve({ kind: 'found' as const, models: [] }),
      saveDefaultModel,
    }
    render(<ProviderEditor provider="anthropic" displayName="Anthropic" namespace={view} schema={settingsSchema}
      settingsPath={['providers', 'anthropic']} operations={operations} t={t} readOnly={false} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(en.keyInput), { target: { value: 'sk-anthropic' } })
    fireEvent.click(screen.getByText(en.apply))

    await waitFor(() => { expect(writeSettings).toHaveBeenCalledOnce() })
    expect(saveDefaultModel).not.toHaveBeenCalled()
  })
})
