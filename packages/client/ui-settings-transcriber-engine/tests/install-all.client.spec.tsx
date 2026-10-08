// @vitest-environment jsdom
/** Bulk preparation skips installed/shared tools and isolates per-tool failures. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { en } from '../src/client/locales.ts'
import { InstallAllTools, prepareAllTools } from '../src/client/InstallAllTools.tsx'

afterEach(() => { cleanup() })

function report(installed: readonly string[] = []): TranscriberDoctorReport {
  return {
    platform: 'win32', live: false, ok: true, exit_code: 0,
    python: { version: '3.12', minimum_version: '3.10', supported: true },
    dependencies: ['nlm', 'agy', 'poppler-utils', 'poppler-utils (pdfimages)', 'libreoffice', 'ffmpeg', 'ghostscript', 'tesseract', 'ocrmypdf', 'genanki', 'faster-whisper'].map(name => ({
      name, purpose: '', required: name === 'nlm', resolved: installed.includes(name), path: null,
      probe: null, install_command: 'scoop install tool', install_route: 'user', failure_hint: '',
    })),
  }
}

function translate(key: keyof typeof en, params?: Record<string, string>): string {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
  return text
}

it('installs every missing application tool and skips a shared Poppler package after discovery', async () => {
  const names: string[] = []
  const installed = ['nlm']
  const engine = {
    doctor: vi.fn(async () => ({ ok: true, value: report(installed) })),
    async* installDependency({ name }: { name: string }) {
      names.push(name)
      installed.push(name)
      if (name === 'poppler-utils') installed.push('poppler-utils (pdfimages)')
      yield { type: 'settled', outcome: 'installed', report: report(installed) }
    },
  } as unknown as TranscriberEngineClient
  await prepareAllTools(engine, new AbortController().signal, vi.fn(), vi.fn())
  expect(names).toEqual(['agy', 'poppler-utils', 'libreoffice', 'ffmpeg', 'ghostscript', 'tesseract', 'ocrmypdf'])
})

describe('failed and cancelled preparation', () => {
  it('continues other tools after an installation rejects', async () => {
    const update = vi.fn()
    const names: string[] = []
    const engine = {
      doctor: vi.fn(async () => ({ ok: true, value: report() })),
      async* installDependency({ name }: { name: string }) {
        names.push(name)
        if (name === 'nlm') throw new Error('download failed')
        yield { type: 'settled', outcome: 'failed', reason: 'process-failed' }
      },
    } as unknown as TranscriberEngineClient
    await prepareAllTools(engine, new AbortController().signal, update, vi.fn())
    expect(update).toHaveBeenCalledWith({
      name: 'nlm', status: 'failed', output: [], failure: 'process-failed', prerequisite: undefined, message: 'download failed',
    })
    expect(names).toContain('ocrmypdf')
    expect(names).not.toContain('genanki')
  })

  it('stops the queue when cancelled during an install', async () => {
    const controller = new AbortController()
    const install = vi.fn(async function* () {
      controller.abort()
      throw new Error('cancelled')
      yield
    })
    const engine = {
      doctor: vi.fn(async () => ({ ok: true, value: report() })), installDependency: install,
    } as unknown as TranscriberEngineClient
    await expect(prepareAllTools(engine, controller.signal, vi.fn(), vi.fn())).rejects.toThrow()
    expect(install).toHaveBeenCalledOnce()
  })
})


it('keeps successful logs folded and opens failed tool diagnostics', async () => {
  const installed = report().dependencies
    .filter(dependency => dependency.name !== 'nlm' && dependency.name !== 'ocrmypdf')
    .map(dependency => dependency.name)
  const engine = {
    doctor: vi.fn(async () => ({ ok: true, value: report(installed) })),
    async* installDependency({ name }: { name: string }) {
      if (name !== 'nlm') installed.push(name)
      yield { type: 'plan', route: 'user', launcher: 'in-process', command: 'install' }
      yield { type: 'output', stream: name === 'nlm' ? 'stderr' : 'stdout', text: `${name} downloaded` }
      yield { type: 'settled', outcome: name === 'nlm' ? 'failed' : 'installed', reason: name === 'nlm' ? 'process-failed' : undefined, report: report(installed) }
    },
  } as unknown as TranscriberEngineClient
  const view = render(<InstallAllTools engine={engine} onReport={vi.fn()} t={translate} />)
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(view.getByText(`ocrmypdf: ${en.installInstalled}`)).toBeTruthy() })
  const successfulDetails = view.getByText(`ocrmypdf: ${en.installInstalled}`).parentElement?.querySelector<HTMLDetailsElement>('details')
  expect(successfulDetails?.open).toBe(false)
  fireEvent.click(successfulDetails?.querySelector('summary') as HTMLElement)
  expect(successfulDetails?.textContent).toContain(en.installOutputStdout)
  expect(successfulDetails?.textContent).toContain('ocrmypdf downloaded')
  expect(view.getByText(`nlm: ${en.installFailed}`)).toBeTruthy()
  const failedDetails = view.getByText(`nlm: ${en.installFailed}`).parentElement?.querySelector<HTMLDetailsElement>('details')
  expect(failedDetails?.open).toBe(true)
  expect(failedDetails?.textContent).toContain(en.installOutputStderr)
  expect(failedDetails?.textContent).toContain('nlm downloaded')
  expect(view.getByText(en.installAllFailed.replace('{count}', '1'))).toBeTruthy()
})

it('reports discovery errors without starting installers', async () => {
  const install = vi.fn()
  const engine = { doctor: vi.fn(async () => ({ ok: false, error: { message: 'offline' } })), installDependency: install } as unknown as TranscriberEngineClient
  const view = render(<InstallAllTools engine={engine} onReport={vi.fn()} t={key => en[key]} />)
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(view.getByRole('alert').textContent).toContain(en.installFailed); expect(view.getByText('offline')).toBeTruthy() })
  expect(install).not.toHaveBeenCalled()
})

it('says account sign-in is separate when every tool is already installed', async () => {
  const installed = report().dependencies.map(dependency => dependency.name)
  const install = vi.fn()
  const engine = {
    doctor: vi.fn(async () => ({ ok: true, value: report(installed) })), installDependency: install,
  } as unknown as TranscriberEngineClient
  const view = render(<InstallAllTools engine={engine} onReport={vi.fn()} t={translate} />)
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(view.getByText(en.installAllNothing)).toBeTruthy() })
  expect(install).not.toHaveBeenCalled()
})

it('cancels an active installer from the preparation control', async () => {
  let active: AbortSignal | undefined
  const engine = {
    doctor: vi.fn(async () => ({ ok: true, value: report() })),
    async* installDependency(_request: unknown, signal: AbortSignal) {
      active = signal
      await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true }) })
      yield { type: 'settled', outcome: 'failed' }
    },
  } as unknown as TranscriberEngineClient
  const view = render(<InstallAllTools engine={engine} onReport={vi.fn()} t={key => en[key]} />)
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(active).toBeDefined() })
  fireEvent.click(view.getByRole('button', { name: en.installAllCancel }))
  await waitFor(() => { expect(active?.aborted).toBe(true); expect(view.queryByRole('button', { name: en.installAllCancel })).toBeNull() })
  expect(view.queryByRole('alert')).toBeNull()
})

it('retries from fresh discovery and skips tools installed by the previous run', async () => {
  const installed: string[] = []
  const names: string[] = []
  let first = true
  const engine = {
    doctor: vi.fn(async () => ({ ok: true, value: report(installed) })),
    async* installDependency({ name }: { name: string }) {
      names.push(name)
      if (name === 'nlm' && first) { first = false; throw new Error('download failed') }
      installed.push(name)
      yield { type: 'settled', outcome: 'installed', report: report(installed) }
    },
  } as unknown as TranscriberEngineClient
  const view = render(<InstallAllTools engine={engine} onReport={vi.fn()} t={key => en[key]} />)
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(view.getByRole('button', { name: en.installAll }).hasAttribute('disabled')).toBe(false) })
  expect(view.getByText('download failed')).toBeTruthy()
  const previous = names.length
  fireEvent.click(view.getByRole('button', { name: en.installAll }))
  await waitFor(() => { expect(view.getByText(en.installAllReady)).toBeTruthy() })
  expect(names.slice(previous)).toEqual(['nlm'])
})
