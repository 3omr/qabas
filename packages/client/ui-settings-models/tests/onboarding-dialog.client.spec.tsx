// @vitest-environment jsdom
/** First-run pi-ai provider ordering, sign-in, and route provisioning. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import type { AuthorizationEntryView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ModelsSettingsState } from '../src/client/store.ts'
import { ProviderOnboardingDialog } from '../src/client/ProviderOnboardingDialog.tsx'
import type { ProviderOnboardingDialogProps } from '../src/client/ProviderOnboardingDialog.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => { document.body.innerHTML = '' })

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

const namespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai', schema: JSON.parse(JSON.stringify(PiAiConfig.toJSON())) as JsonValue,
  value: { providers: {} }, base: { providers: {} }, user: {},
  applies: 'live', secrets: [], revision: 7,
}

const rows: ModelsSettingsState['rows'] = [
  { entry: { provider: 'google', displayName: 'Google', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'google'], active: true }, configured: false, removable: false, apiKeyEnv: 'GEMINI_API_KEY', credential: undefined },
  { entry: { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'], active: true }, configured: false, removable: false, apiKeyEnv: 'OPENROUTER_API_KEY', credential: undefined },
  { entry: { provider: 'openai-codex', displayName: 'OpenAI Codex', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai-codex'], active: true }, configured: false, removable: false, apiKeyEnv: undefined, credential: undefined },
  { entry: { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: true }, configured: false, removable: false, apiKeyEnv: 'ANTHROPIC_API_KEY', credential: undefined },
]

const flow = (provider: string, label: string, method: 'oauth' | 'api-key' = 'oauth'): AuthorizationEntryView => ({
  key: `llm-pi-ai/${provider}`, label, methods: [{ id: method, label }], inFlight: false, signedIn: false,
})

function harness(
  outcome: 'authorized' | 'cancelled' | 'failed' = 'authorized',
  options: { models?: readonly { id: string }[]; defaultSelection?: { provider: string; model: string } } = {},
) {
  const complete = vi.fn()
  const writeSettings = vi.fn(() => Promise.resolve({ kind: 'written' as const, view: namespace }))
  let defaultSelection = options.defaultSelection
  const saveDefaultModel = vi.fn(async (provider: string, model: string) => {
    if (defaultSelection === undefined) defaultSelection = { provider, model }
    return undefined
  })
  const listed = [
    flow('google', 'Google API key', 'api-key'),
    // pi-ai's real label for this provider already contains the phrase.
    flow('openrouter', 'Sign in with OpenRouter'),
    flow('openai-codex', 'OpenAI (ChatGPT Plus/Pro)'),
    flow('anthropic', 'Anthropic (Claude Pro/Max)'),
  ]
  const operations: ModelsOperations = {
    listFlows: () => Promise.resolve(listed),
    runFlow: (_key, _method, _signal) => outcome === 'failed'
      ? (async function* () { throw new Error('flow failed') })()
      : (async function* () { yield { type: 'settled', outcome } })(),
    answer: () => Promise.resolve(),
    cancelFlow: () => Promise.resolve(),
    describeCredential: () => Promise.resolve(undefined),
    storeCredential: () => Promise.resolve(undefined),
    removeCredential: () => Promise.resolve(undefined),
    writeSettings,
    discoverModels: () => Promise.resolve({ kind: 'found' as const, models: options.models ?? [] }),
    saveDefaultModel,
  }
  const state: ModelsSettingsState = {
    status: 'ready', error: null, credentialError: null, writable: true, rows, namespaces: new Map([['llm-pi-ai', namespace]]),
  }
  const controller = { load: vi.fn(() => Promise.resolve()) } as unknown as ProviderOnboardingDialogProps['controller']
  const props = {
    stepId: 'pi-ai-provider', complete, openSection: vi.fn(),
    useSessions: (() => undefined) as never,
    useSessionPendingInteraction: (() => undefined) as never,
    usePanelInfo: ((selector: (value: { activePanelId: null }) => unknown) => selector({ activePanelId: null })) as never,
    useResource: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    controller, useModels: (selector: (value: ModelsSettingsState) => unknown) => selector(state), operations,
    t: (key: keyof typeof en, params?: Record<string, string>) => {
      const text = en[key]
      return params === undefined ? text : text.replace('{provider}', params.provider ?? '')
    },
  } as ProviderOnboardingDialogProps
  return { props, complete, writeSettings, saveDefaultModel, getDefault: () => defaultSelection }
}

describe('ProviderOnboardingDialog', () => {
  it('puts the requested subscription providers before API-key providers and labels each need', async () => {
    const h = harness()
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingTitle })
    const providers = [...document.querySelectorAll<HTMLElement>('[data-onboarding-provider]')]
      .map(node => node.dataset.onboardingProvider)
    expect(providers.slice(0, 3)).toEqual(['anthropic', 'openai-codex', 'openrouter'])
    expect(screen.getByText(en.onboardingPasteKey)).toBeTruthy()
    expect(screen.getByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))).toBeTruthy()
  })

  it('does not say "sign in with" twice for a label that already says it', async () => {
    // pi-ai writes its own OAuth method labels and is not consistent: Anthropic's
    // is a bare name, while OpenRouter's, Kimi's and xAI's already begin "Sign in
    // with". Interpolating the second kind rendered "Sign in with Sign in with
    // OpenRouter" in the real app.
    const h = harness()
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingTitle })
    expect(screen.getByText(en.onboardingSignInWith.replace('{provider}', 'OpenRouter'))).toBeTruthy()
    expect(document.body.textContent).not.toContain('Sign in with Sign in with')
  })

  it('offers pi-ai directory providers before their routes are active', async () => {
    const h = harness()
    const inactiveRows = rows.map(row => ({ ...row, entry: { ...row.entry, active: false } }))
    function useInactiveModels<S>(selector: (value: ModelsSettingsState) => S): S {
      return selector({
        status: 'ready', error: null, credentialError: null, writable: true,
        rows: inactiveRows, namespaces: new Map([['llm-pi-ai', namespace]]),
      })
    }
    h.props.useModels = useInactiveModels
    render(<ProviderOnboardingDialog {...h.props} />)
    expect(await screen.findByRole('dialog', { name: en.onboardingTitle })).toBeTruthy()
    expect(document.querySelector('[data-onboarding-provider="anthropic"]')).toBeTruthy()
  })

  it('filters the directory and opens the API-key flow for Google', async () => {
    const h = harness()
    h.props.schema = settingsSchema
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByRole('dialog', { name: en.onboardingTitle })
    const search = screen.getByRole('searchbox', { name: en.onboardingSearch })
    fireEvent.change(search, { target: { value: 'google' } })
    expect(document.querySelector('[data-onboarding-provider="google"]')).toBeTruthy()
    expect(document.querySelector('[data-onboarding-provider="anthropic"]')).toBeNull()

    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="google"]')!)
    expect(await screen.findByLabelText(en.keyInput)).toBeTruthy()
    expect(screen.queryByText(en.onboardingNoLogin)).toBeNull()
  })

  it('provisions exactly one empty route after authorization', async () => {
    const h = harness()
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="anthropic"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic \(Claude Pro\/Max\)' }))
    await waitFor(() => { expect(h.writeSettings).toHaveBeenCalledTimes(1) })
    expect(h.writeSettings).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
      7,
    )
    expect(h.complete).toHaveBeenCalledOnce()
  })

  it('saves the first discovered model as the default for the first route', async () => {
    const h = harness('authorized', { models: [{ id: 'catalog-first' }, { id: 'catalog-second' }] })
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="anthropic"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' }))

    await waitFor(() => { expect(h.saveDefaultModel).toHaveBeenCalledOnce() })
    expect(h.writeSettings).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
      7,
    )
    expect(h.saveDefaultModel).toHaveBeenCalledWith('anthropic', 'catalog-first')
    expect(h.getDefault()).toEqual({ provider: 'anthropic', model: 'catalog-first' })
  })

  it('keeps an existing default when a second route is provisioned', async () => {
    const h = harness('authorized', {
      models: [{ id: 'second-route-first' }],
      defaultSelection: { provider: 'google', model: 'gemini-existing' },
    })
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="anthropic"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' }))

    await waitFor(() => { expect(h.writeSettings).toHaveBeenCalledOnce() })
    expect(h.getDefault()).toEqual({ provider: 'google', model: 'gemini-existing' })
  })

  it('provisions a route without a default when discovery returns no models', async () => {
    const h = harness('authorized', { models: [] })
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="anthropic"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic (Claude Pro/Max)' }))

    await waitFor(() => { expect(h.writeSettings).toHaveBeenCalledOnce() })
    expect(h.saveDefaultModel).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'failed'] as const)('does not provision a route when the flow is %s', async (outcome) => {
    const h = harness(outcome)
    render(<ProviderOnboardingDialog {...h.props} />)
    await screen.findByText(en.onboardingSignInWith.replace('{provider}', 'Anthropic (Claude Pro/Max)'))
    fireEvent.click(document.querySelector<HTMLElement>('[data-onboarding-provider="anthropic"]')!)
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic \(Claude Pro\/Max\)' }))
    await waitFor(() => {
      expect(screen.getByText(outcome === 'cancelled' ? en['signIn.cancelled'] : /Sign-in failed/)).toBeTruthy()
    })
    expect(h.writeSettings).not.toHaveBeenCalled()
    expect(h.saveDefaultModel).not.toHaveBeenCalled()
  })
})
