/** Pure first-run readiness and catalog standing projection. */
import { describe, expect, it } from 'vitest'
import type { CredentialInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelsSettingsState, ProviderRow } from '../src/client/store.ts'
import { onboardingReadiness, providerStanding, providerUsable } from '../src/client/store.ts'

const missing: CredentialInfo = { configured: false, writable: true }
const present: CredentialInfo = { configured: true, writable: true, source: 'file' }

function row(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    entry: { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], active: true },
    configured: false, removable: false, apiKeyEnv: 'ANTHROPIC_API_KEY', credential: missing, ...overrides,
  }
}

function state(overrides: Partial<ModelsSettingsState> = {}): ModelsSettingsState {
  return { status: 'ready', error: null, credentialError: null, writable: true, rows: [row()], namespaces: new Map(), ...overrides }
}

describe('provider readiness', () => {
  it('requires both a configured route and a credential', () => {
    expect(providerUsable(row())).toBe(false)
    expect(providerUsable(row({ configured: true, credential: present }))).toBe(true)
    expect(providerUsable(row({ entry: { ...row().entry, active: false }, configured: true, credential: present }))).toBe(false)
  })

  it('marks an authorized credential without a route as attention', () => {
    expect(providerStanding(row(), true)).toBe('attention')
    expect(providerStanding(row({ configured: true, credential: present }), false)).toBe('ready')
    expect(providerStanding(row({ configured: true, credential: missing }), false)).toBe('attention')
    expect(providerStanding(row(), false)).toBe('unset')
  })
})

describe('onboardingReadiness', () => {
  it('waits for the join and reports an absent adapter', () => {
    expect(onboardingReadiness(state({ status: 'loading', rows: [] }))).toEqual({ kind: 'loading' })
    expect(onboardingReadiness(state({ rows: [] }))).toEqual({ kind: 'adapter-absent' })
  })

  it('ends once a configured route has a credential or successful sign-in', () => {
    expect(onboardingReadiness(state({ rows: [row({ configured: true, credential: present })] })))
      .toEqual({ kind: 'provider-ready' })
    expect(onboardingReadiness(state(), new Set(['llm-pi-ai/anthropic']))).toEqual({ kind: 'credential-missing' })
    expect(onboardingReadiness(state({ rows: [row({ configured: true })] }), new Set(['llm-pi-ai/anthropic'])))
      .toEqual({ kind: 'provider-ready' })
  })

  it('keeps settings and credential failures diagnostic', () => {
    expect(onboardingReadiness(state({ status: 'error', error: 'settings down' }))).toEqual({ kind: 'unavailable', reason: 'load-failed' })
    expect(onboardingReadiness(state({ writable: false }))).toEqual({ kind: 'unavailable', reason: 'settings-read-only' })
    expect(onboardingReadiness(state({ credentialError: 'credentials down' }))).toEqual({ kind: 'unavailable', reason: 'credentials-unavailable' })
    expect(onboardingReadiness(state({ rows: [row({ credential: { configured: false, writable: false } })] }))).toEqual({ kind: 'unavailable', reason: 'credential-read-only' })
  })
})
