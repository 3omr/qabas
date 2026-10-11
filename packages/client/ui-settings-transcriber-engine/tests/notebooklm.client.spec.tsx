// @vitest-environment jsdom
/** Windows NotebookLM recovery stays visible and cancellable in the account card. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { TranscriberAuthFrame } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { AccountsSection, type AccountsSectionProps } from '../src/client/AccountsSection.tsx'
import { NotebookLmConnect } from '../src/client/NotebookLmConnect.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const diagnostics = 'nlm login exited 0xC0000142; env names: PATH, SystemRoot; PATH contains SystemRoot/System32: true'

function translator(dictionary: Readonly<Record<string, string>>) {
  return (key: keyof typeof en, params?: Record<string, string>): string => {
    let text = dictionary[key] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
    return text
  }
}

function fixture(frames: readonly TranscriberAuthFrame[], dictionary: Readonly<Record<string, string>> = en) {
  const finish = Promise.withResolvers<undefined>()
  const onAuthorized = vi.fn()
  const onExternalConsole = vi.fn()
  const cancelAuth = vi.fn(async () => { finish.resolve(undefined); return { ok: true } })
  const engine = {
    authStatus: async () => ({ ok: true, value: { connected: false } }),
    auth: async function* (signal: AbortSignal) {
      for (const frame of frames) yield frame
      await finish.promise
      if (!signal.aborted) yield { type: 'settled', outcome: 'authorized' } as const
    },
    cancelAuth,
  } as unknown as TranscriberEngineClient
  const view = render(
    <NotebookLmConnect
      engine={engine}
      t={translator(dictionary)}
      onAuthorized={onAuthorized}
      onConnectionStatus={vi.fn()}
      onExternalConsole={onExternalConsole}
      compact
    />,
  )
  return { view, finish, onAuthorized, onExternalConsole, cancelAuth }
}

describe('NotebookLM Windows login recovery', () => {
  it.each([
    ['en', en],
    ['ar', dictionaries['settings.transcriberEngine']!],
  ] as const)('shows separate-console guidance and diagnostics in %s until connected', async (_locale, dictionary) => {
    const { view, finish, onAuthorized } = fixture([{ type: 'external-console', diagnostics }], dictionary)
    fireEvent.click(await view.findByRole('button', { name: dictionary.notebookLmConnect }))
    await view.findByText(dictionary.notebookLmConsoleOpened)
    expect(view.getByText(dictionary.notebookLmDiagnostics).closest('details')?.open).toBe(false)
    fireEvent.click(view.getByText(dictionary.notebookLmDiagnostics))
    expect(view.getByText(diagnostics)).toBeTruthy()
    expect(view.queryByRole('textbox')).toBeNull()
    expect(view.getByRole('button', { name: dictionary.notebookLmCancel })).toBeTruthy()
    expect(view.container.textContent).toMatchSnapshot()
    finish.resolve(undefined)
    await view.findByText(dictionary.notebookLmSession)
    expect(onAuthorized).toHaveBeenCalledOnce()
  })

  it('cancels the console attempt without authorizing a late completion', async () => {
    const { view, cancelAuth, onAuthorized, onExternalConsole } = fixture([{ type: 'external-console', diagnostics }])
    fireEvent.click(await view.findByRole('button', { name: en.notebookLmConnect }))
    await view.findByText(en.notebookLmConsoleOpened)
    fireEvent.click(view.getByRole('button', { name: en.notebookLmCancel }))
    await view.findByText(en.notebookLmCancelled)
    await waitFor(() => { expect(cancelAuth).toHaveBeenCalledOnce() })
    expect(onExternalConsole).toHaveBeenLastCalledWith(false)
    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('replaces the disconnected card standing while the console is open', async () => {
    const finish = Promise.withResolvers<undefined>()
    const engine = {
      doctor: async () => ({ ok: true, value: { dependencies: [{ name: 'nlm', resolved: true }], live: false } }),
      authStatus: async () => ({ ok: true, value: { connected: false } }),
      auth: async function* () { yield { type: 'external-console', diagnostics }; await finish.promise },
      cancelAuth: async () => { finish.resolve(undefined); return { ok: true } },
    }
    const props = {
      engine,
      t: translator(en),
      geminiKey: { describe: async () => ({ configured: false, writable: true }), watch: () => () => {} },
    } as unknown as AccountsSectionProps
    const view = render(<AccountsSection {...props} />)
    fireEvent.click(await view.findByRole('button', { name: en.notebookLmConnect }))
    await view.findByText(en.notebookLmConsoleWaiting)
    expect(view.container.querySelector('[data-account="notebooklm"]')?.getAttribute('data-status')).toBe('checking')
    fireEvent.click(view.getByRole('button', { name: en.notebookLmCancel }))
    await waitFor(() => { expect(view.container.querySelector('[data-account="notebooklm"]')?.textContent).toContain(en['accounts.notebook.disconnected']) })
  })

  it('puts abnormal exit details behind a disclosure when login fails', async () => {
    const { view, finish } = fixture([{ type: 'settled', outcome: 'failed', message: 'NotebookLM login did not complete.', diagnostics }])
    fireEvent.click(await view.findByRole('button', { name: en.notebookLmConnect }))
    expect((await view.findByRole('alert')).textContent).toContain('NotebookLM login did not complete.')
    expect(view.getByText(en.notebookLmDiagnostics).closest('details')?.open).toBe(false)
    expect(view.getByText(diagnostics)).toBeTruthy()
    finish.resolve(undefined)
  })
})
