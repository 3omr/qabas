// @vitest-environment jsdom
/** First-run pi-ai provider ordering, sign-in, and route provisioning. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationEntryView, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState } from '../src/client/store.ts'
import { ProviderOnboardingDialog } from '../src/client/ProviderOnboardingDialog.tsx'
import type { ProviderOnboardingDialogProps } from '../src/client/ProviderOnboardingDialog.tsx'
import type { ModelsOperations } from '../src/client/operations.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { document.body.innerHTML = '' })

const namespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai', schema: {}, value: { providers: {} }, base: { providers: {} }, user: {},
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

function harness(outcome: 'authorized' | 'cancelled' | 'failed' = 'authorized') {
  const complete = vi.fn()
  const writeSettings = vi.fn(() => Promise.resolve({ kind: 'written' as const, view: namespace }))
  const listed = [
    flow('google', 'Google API key', 'api-key'),
    flow('openrouter', 'OpenRouter OAuth'),
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
    discoverModels: () => Promise.resolve({ kind: 'found' as const, models: [] }),
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
  return { props, complete, writeSettings }
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
  })
})
