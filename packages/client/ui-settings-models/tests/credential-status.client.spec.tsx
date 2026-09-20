// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ModelsSettingsState, ModelsSettingsStore } from '../src/client/store.ts'
import type { AuthorizationEntryView } from '@deepseek-ai/dsh-api-remotes/client'
import { CredentialStatus } from '../src/client/CredentialStatus.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const missing: ModelsSettingsState = {
  status: 'ready',
  error: null,
  credentialError: null,
  writable: true,
  rows: [{
    entry: {
      provider: 'anthropic',
      displayName: 'Anthropic',
      active: true,
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'anthropic'],
    },
    configured: true,
    removable: false,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    credential: { configured: false, writable: true },
  }],
  namespaces: new Map(),
}

function t(key: keyof typeof en): string {
  return en[key]
}

describe('CredentialStatus', () => {
  it('keeps a missing credential visible and opens the Models section', () => {
    const openSettings = vi.fn()
    window.addEventListener('dsh-desktop-open-settings', openSettings)
    const controller = {
      store: { getSnapshot: () => missing },
      load: vi.fn(),
    } as unknown as ModelsSettingsStore
    render(<CredentialStatus
      wide
      controller={controller}
      operations={{ listFlows: () => Promise.resolve([]) }}
      useSnapshot={selector => selector(missing)}
      t={t}
    />)
    const button = screen.getByRole('button', { name: 'Configure API key' })
    expect(button.textContent).toContain('API key required')
    fireEvent.click(button)
    expect((openSettings.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'models' })
    window.removeEventListener('dsh-desktop-open-settings', openSettings)
  })

  it('loads the shared models state once from idle and stays hidden meanwhile', () => {
    const idle: ModelsSettingsState = { ...missing, status: 'idle', rows: [] }
    const load = vi.fn(() => Promise.resolve())
    const controller = {
      store: { getSnapshot: () => idle },
      load,
    } as unknown as ModelsSettingsStore
    const view = render(<CredentialStatus
      wide={false}
      controller={controller}
      operations={{ listFlows: () => Promise.resolve([]) }}
      useSnapshot={selector => selector(idle)}
      t={t}
    />)
    expect(view.container.innerHTML).toBe('')
    expect(load).toHaveBeenCalledOnce()
  })

  it('stays hidden for a configured route with a stored OAuth sign-in', async () => {
    const oauth: AuthorizationEntryView = {
      key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [], inFlight: false, signedIn: true,
    }
    const oauthState: ModelsSettingsState = {
      ...missing,
      rows: [{ ...missing.rows[0]!, apiKeyEnv: undefined, credential: undefined }],
    }
    const controller = {
      store: { getSnapshot: () => oauthState },
      load: vi.fn(),
    } as unknown as ModelsSettingsStore
    render(<CredentialStatus
      wide
      controller={controller}
      operations={{ listFlows: () => Promise.resolve([oauth]) }}
      useSnapshot={selector => selector(oauthState)}
      t={t}
    />)
    await waitFor(() => { expect(screen.queryByRole('button')).toBeNull() })
  })
})
