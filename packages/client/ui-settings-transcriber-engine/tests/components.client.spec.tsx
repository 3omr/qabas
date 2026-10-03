// @vitest-environment jsdom
/** The Accounts and tools page: one card per service, its standing, and the control that fixes it. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { en } from '../src/client/locales.ts'
import { failureHintOf } from '../src/client/standing.ts'
import { AccountsSection, KeyCard, type AccountsSectionProps, type GeminiKey } from '../src/client/AccountsSection.tsx'
import { AgyProbeResult } from '../src/client/SetupStep.tsx'
import { nextQuotaReset, quotaResetTime } from '../src/client/quota.ts'

afterEach(() => { cleanup() })

const REPORT: TranscriberDoctorReport = {
  platform: 'win32',
  live: true,
  python: { version: '3.12.4', minimum_version: '3.10', supported: true },
  dependencies: [
    {
      name: 'nlm',
      purpose: 'NotebookLM queries',
      required: true,
      resolved: true,
      path: 'nlm.exe',
      probe: { ran: true, passed: false, failure: 'not authenticated' },
      failure_hint: 'Run `nlm login`.',
      install_command: 'pipx install notebooklm-mcp-cli',
      install_route: 'user',
    },
    {
      name: 'poppler-utils',
      purpose: 'Read PDF text',
      required: true,
      resolved: false,
      path: null,
      probe: { ran: false, passed: null, failure: null },
      failure_hint: '',
      install_command: 'winget install oschwartz10612.Poppler',
      install_route: 'privileged',
    },
    {
      name: 'ffmpeg',
      purpose: 'Normalize recordings',
      required: false,
      resolved: true,
      path: 'ffmpeg.exe',
      probe: { ran: true, passed: true, failure: null },
      failure_hint: '',
      install_command: 'winget install Gyan.FFmpeg',
      install_route: 'privileged',
    },
  ],
  ok: false,
  exit_code: 1,
}

function translate(key: keyof typeof en, params?: Record<string, string>): string {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, value)
  return text
}

function keyStub(configured = true, overrides: Partial<GeminiKey> = {}): GeminiKey {
  return {
    describe: vi.fn(async () => ({ configured, writable: true })),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    watch: vi.fn(() => () => {}),
    ...overrides,
  }
}

function mount(report: TranscriberDoctorReport = REPORT) {
  const doctor = vi.fn().mockResolvedValue({ ok: true as const, value: report })
  const authStatus = vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } })
  const installDependency = vi.fn(async function* () {})
  const props = {
    close: vi.fn(),
    t: translate,
    geminiKey: keyStub(),
    engine: { doctor, authStatus, installDependency },
  } as unknown as AccountsSectionProps
  return { doctor, authStatus, installDependency, view: render(<AccountsSection {...props} />) }
}

describe('AccountsSection', () => {
  it('gives each service a card with its standing, and shows the missing tools without asking', async () => {
    const { view } = mount()
    const card = (id: string) => view.container.querySelector(`[data-account="${id}"]`)
    await waitFor(() => { expect(card('notebooklm')?.getAttribute('data-status')).toBe('attention') })
    expect(card('notebooklm')?.textContent).toContain(en['accounts.notebook.disconnected'])
    expect(card('tools')?.getAttribute('data-status')).toBe('attention')
    expect(card('tools')?.textContent).toContain('1 missing')
    // The required tool that is missing is listed with its own copy; the
    // optional one that works waits behind the disclosure.
    expect(card('tools')?.textContent).toContain("Reading a PDF's text layer to decide whether it needs OCR")
    expect(card('tools')?.textContent).not.toContain('Read PDF text')
    expect(card('tools')?.querySelector('[data-transcriber-dependency="ffmpeg"]')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Show all 2 tools' }))
    expect(card('tools')?.querySelector('[data-transcriber-dependency="ffmpeg"]')).not.toBeNull()
    await waitFor(() => { expect(card('gemini-key')?.textContent).toContain(en['accounts.key.saved']) })
  })

  it('falls back to the engine sentence for a tool it carries no copy for', async () => {
    // A tool added upstream must read as an English sentence, never as a
    // missing one or a raw key.
    const { view } = mount({
      ...REPORT,
      dependencies: [{
        name: 'newtool',
        purpose: 'Something the engine added',
        required: false,
        resolved: true,
        path: '/usr/bin/newtool',
        probe: { ran: false, passed: null, failure: null },
        failure_hint: '',
        install_command: '',
        install_route: 'manual',
      }],
    })
    await waitFor(() => { expect(view.getByRole('button', { name: 'Show all 1 tools' })).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Show all 1 tools' }))
    expect(view.container.textContent).toContain('Something the engine added')
    expect(view.container.textContent).not.toContain('undefined')

    expect(view.container.textContent).not.toContain('tool.newtool')
  })

  it('offers the report install command for a missing tool, and only that one', async () => {
    const { view } = mount()
    await waitFor(() => { expect(view.container.querySelector('[data-transcriber-dependency="poppler-utils"]')).not.toBeNull() })
    const detail = view.container.querySelector('[data-transcriber-dependency="poppler-utils"]')
    expect(detail?.textContent).toContain('winget install oschwartz10612.Poppler')
    expect(detail?.textContent).not.toContain('apt install')
    expect(detail?.textContent).not.toContain('brew install')
    // A signed-out NotebookLM is fixed by its connect button, not a terminal command.
    expect(view.container.querySelector('[data-account="notebooklm"]')?.textContent).not.toContain('Run `nlm login`.')
  })

  it('streams a failed install and keeps its copyable fallback', async () => {
    const report: TranscriberDoctorReport = {
      ...REPORT,
      dependencies: REPORT.dependencies.map(dependency => dependency.name === 'nlm'
        ? { ...dependency, resolved: false, probe: null, install_route: 'user' as const }
        : dependency),
    }
    const installDependency = vi.fn(async function* () {
      yield { type: 'plan' as const, route: 'user' as const, launcher: 'in-process' as const, command: 'pipx install notebooklm-mcp-cli' }
      yield { type: 'output' as const, stream: 'stderr' as const, text: 'pipx: network failed\n' }
      yield { type: 'settled' as const, outcome: 'failed' as const, reason: 'process-failed' as const, exit_code: 1 }
    })
    const authStatus = vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } })
    const doctor = vi.fn().mockResolvedValue({ ok: true as const, value: report })
    const view = render(<AccountsSection {...{
      close: vi.fn(),
      t: translate,
      geminiKey: keyStub(),
      engine: { doctor, authStatus, installDependency, auth: vi.fn(async function* () {}), answerAuth: vi.fn(), cancelAuth: vi.fn() },
    } as unknown as AccountsSectionProps} />)
    await waitFor(() => { expect(view.getByRole('button', { name: 'Install for this user' })).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Install for this user' }))
    await waitFor(() => { expect(view.getByText('pipx: network failed')).toBeTruthy() })
    expect(view.getByText('pipx install notebooklm-mcp-cli')).toBeTruthy()
    expect(view.getByText('The installation did not finish. The installer output is kept below.')).toBeTruthy()
  })

  it('checks again for presence, and tests agy live only when asked', async () => {
    const agy = {
      name: 'agy', purpose: 'writer', required: false, resolved: true, path: '/bin/agy',
      probe: null, failure_hint: '', install_command: null, install_route: 'manual' as const, status: 'installed',
    }
    const { doctor, view } = mount({ ...REPORT, live: false, dependencies: [...REPORT.dependencies, agy] })
    await waitFor(() => { expect(doctor).toHaveBeenCalledWith({ live: false }, expect.any(AbortSignal)) })
    await waitFor(() => { expect(view.container.querySelector('[data-account="agy"]')?.textContent).toContain(en['accounts.agy.installed']) })
    fireEvent.click(view.getByRole('button', { name: 'Check again' }))
    await waitFor(() => { expect(doctor).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(view.getByRole('button', { name: en['setup.agyCheck'] })).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: en['setup.agyCheck'] }))
    expect(doctor).toHaveBeenLastCalledWith({ live: true }, expect.any(AbortSignal))
  })

  it('shows a visible pending state while the initial report is awaited', () => {
    const doctor = vi.fn(() => new Promise<never>(() => {}))
    const props = {
      close: vi.fn(),
      t: translate,
      geminiKey: keyStub(),
      engine: {
        doctor,
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
      },
    } as unknown as AccountsSectionProps
    const view = render(<AccountsSection {...props} />)
    expect(view.getByRole('button', { name: 'Checking tools…' })).toBeTruthy()
    expect(view.container.querySelector('[data-account="tools"]')?.getAttribute('data-status')).toBe('checking')
  })

  it('streams the NotebookLM URL, sends a prompt line, and shows probe-backed success', async () => {
    const answerRelease = Promise.withResolvers<undefined>()
    const auth = vi.fn(async function* () {
      yield { type: 'notice' as const, message: 'Open https://accounts.example.test' }
      yield { type: 'prompt' as const, id: 'line', message: 'Paste code:' }
      await answerRelease.promise
      yield { type: 'settled' as const, outcome: 'authorized' as const }
    })
    const answerAuth = vi.fn().mockImplementation(async () => {
      answerRelease.resolve(undefined)
      return { ok: true as const, value: undefined }
    })
    const doctor = vi.fn().mockResolvedValue({ ok: true as const, value: REPORT })
    const props = {
      close: vi.fn(),
      t: translate,
      geminiKey: keyStub(),
      engine: {
        doctor,
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
        auth,
        answerAuth,
        cancelAuth: vi.fn().mockResolvedValue({ ok: true as const, value: undefined }),
      },
    } as unknown as AccountsSectionProps
    const view = render(<AccountsSection {...props} />)
    await waitFor(() => { expect(view.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(view.getByRole('link', { name: 'https://accounts.example.test' })).toBeTruthy() })
    fireEvent.change(view.getByLabelText('Paste code:'), { target: { value: 'fixture-code' } })
    fireEvent.submit(view.getByLabelText('Paste code:').closest('form')!)
    await waitFor(() => { expect(answerAuth).toHaveBeenCalledWith('fixture-code') })
    await waitFor(() => { expect(view.getByText('NotebookLM is connected. Its session can expire; reconnecting is normal.')).toBeTruthy() })
  })

  it('shows a probe failure and an honest desktop-only fallback when PTY start fails', async () => {
    const failedAuth = vi.fn(async function* () {
      yield { type: 'settled' as const, outcome: 'failed' as const, message: 'Run `nlm login` again.' }
    })
    const probeFailureProps = {
      close: vi.fn(),
      t: translate,
      geminiKey: keyStub(),
      engine: {
        doctor: vi.fn().mockResolvedValue({ ok: true as const, value: REPORT }),
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
        auth: failedAuth,
        answerAuth: vi.fn(),
        cancelAuth: vi.fn(),
      },
    } as unknown as AccountsSectionProps
    const probeFailureView = render(<AccountsSection {...probeFailureProps} />)
    await waitFor(() => { expect(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(probeFailureView.getByText('Run `nlm login` again.')).toBeTruthy() })
    cleanup()

    const unavailableProps = {
      close: vi.fn(),
      t: translate,
      geminiKey: keyStub(),
      engine: {
        doctor: vi.fn().mockResolvedValue({ ok: true as const, value: REPORT }),
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
        auth: vi.fn(async function* () {
          throw new Error('native PTY unavailable')
        }),
        answerAuth: vi.fn(),
        cancelAuth: vi.fn(),
      },
    } as unknown as AccountsSectionProps
    const unavailableView = render(<AccountsSection {...unavailableProps} />)
    await waitFor(() => { expect(unavailableView.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(unavailableView.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(unavailableView.getByText('NotebookLM login needs the desktop app. The browser profile cannot open its login browser.')).toBeTruthy() })
  })
  it('translates the engine hint a stuck student is looking at', () => {
    // The engine writes for a terminal, so its one failure hint is English.
    // Rendered raw it put an English paragraph in the middle of an Arabic page
    // at the exact moment a student is stuck. Carried copy wins; an unknown
    // tool still falls back to the engine's own words rather than nothing.
    const arabic = ((key: string) => key === 'hint.nlm' ? 'الجلسة انتهت' : undefined) as never
    expect(failureHintOf('nlm', 'engine english', arabic)).toBe('الجلسة انتهت')
    expect(failureHintOf('some-new-tool', 'engine english', arabic)).toBe('engine english')
    // A translate that echoes the key is the other shape of a miss.
    expect(failureHintOf('nlm', 'engine english', (key: string) => key)).toBe('engine english')
  })
  it('carries copy for every tool the engine reports today', () => {
    // The fallback exists for a tool added upstream after this page shipped,
    // not as a standing excuse: four tools reached the student as English
    // sentences in an Arabic page simply because nobody wrote their line. This
    // list is the engine's own DEPENDENCIES, so adding one there fails here.
    for (const name of [
      'nlm', 'poppler-utils', 'poppler-utils (pdfinfo)', 'poppler-utils (pdftoppm)',
      'poppler-utils (pdfimages)', 'ocrmypdf', 'libreoffice', 'ghostscript', 'ffmpeg',
      'genanki', 'faster-whisper', 'openpyxl', 'python-docx', 'reportlab',
    ]) expect(en[`tool.${name}` as keyof typeof en], name).toBeTruthy()
  })
})

describe('KeyCard', () => {
  const now = () => new Date('2026-10-03T06:00:00Z')

  it('asks for a key when there is none, and refuses a blank one or one with spaces', async () => {
    const key = keyStub(false)
    const view = render(<KeyCard geminiKey={key} t={translate} now={now} />)
    const field = await view.findByLabelText(en['accounts.key.field'])
    fireEvent.submit(field.closest('form')!)
    expect(view.getByRole('alert').textContent).toBe(en['accounts.key.blank'])
    fireEvent.change(field, { target: { value: 'AIza abc' } })
    fireEvent.submit(field.closest('form')!)
    expect(view.getByRole('alert').textContent).toBe(en['accounts.key.spaces'])
    fireEvent.change(field, { target: { value: ' AIzaSecret ' } })
    fireEvent.submit(field.closest('form')!)
    await waitFor(() => { expect(key.save).toHaveBeenCalledWith('AIzaSecret') })
    expect(await view.findByText(en['accounts.key.justSaved'])).toBeTruthy()
    // The field is one: no second "sign-in" button for the same key.
    expect(view.queryByLabelText(en['accounts.key.field'])).toBeNull()
  })

  it('changes or removes a saved key, asking once before removing', async () => {
    const key = keyStub(true)
    const view = render(<KeyCard geminiKey={key} t={translate} now={now} />)
    fireEvent.click(await view.findByRole('button', { name: en['accounts.key.remove'] }))
    expect(key.remove).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en['accounts.key.removeConfirm'] }))
    await waitFor(() => { expect(key.remove).toHaveBeenCalledTimes(1) })
    expect(await view.findByLabelText(en['accounts.key.field'])).toBeTruthy()
  })

  it('cannot edit a key that comes from the environment', async () => {
    const key = keyStub(true, { describe: vi.fn(async () => ({ configured: true, writable: false })) })
    const view = render(<KeyCard geminiKey={key} t={translate} now={now} />)
    expect(await view.findByText(en['accounts.key.fromEnvironment'])).toBeTruthy()
    expect(view.queryByRole('button', { name: en['accounts.key.change'] })).toBeNull()
  })

  it('reads the key again when it changes elsewhere', async () => {
    let changed = (): void => {}
    const describe = vi.fn(async () => ({ configured: false, writable: true }))
    const key = keyStub(false, { describe, watch: vi.fn((callback: () => void) => { changed = callback; return () => {} }) })
    render(<KeyCard geminiKey={key} t={translate} now={now} />)
    await waitFor(() => { expect(describe).toHaveBeenCalledTimes(1) })
    changed()
    await waitFor(() => { expect(describe).toHaveBeenCalledTimes(2) })
  })
})

describe('quota reset', () => {
  it('is midnight in Pacific time, said on the student\'s own clock', () => {
    // 3 Oct 2026, 09:00 in Cairo is 23:00 the night before in Pacific (UTC-7): an hour to go.
    expect(nextQuotaReset(new Date('2026-10-03T06:00:00Z')).toISOString()).toBe('2026-10-03T07:00:00.000Z')
    expect(quotaResetTime(new Date('2026-10-03T06:00:00Z'), 'en-US', 'Africa/Cairo')).toBe('10:00 AM')
    // In winter Pacific is UTC-8.
    expect(nextQuotaReset(new Date('2026-12-10T12:00:00Z')).toISOString()).toBe('2026-12-11T08:00:00.000Z')
    // The night the clocks go back (1 Nov 2026) still lands on local midnight.
    expect(nextQuotaReset(new Date('2026-10-31T20:00:00Z')).toISOString()).toBe('2026-11-01T07:00:00.000Z')
    expect(nextQuotaReset(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-02T08:00:00.000Z')
  })
})

describe('AgyProbeResult', () => {
  const t = (key: keyof typeof en): string => en[key]
  const agy = (status: string, passed: boolean | null) => ({
    name: 'agy', purpose: 'writer', required: false, resolved: true, path: '/bin/agy',
    probe: passed === null ? null : { ran: true, passed, failure: passed ? null : 'no' },
    failure_hint: '', install_command: null, install_route: 'manual' as const, status,
  })

  it('says nothing until a live test ran', () => {
    expect(render(<AgyProbeResult agy={agy('installed', true)} live={false} t={t} />).container.textContent).toBe('')
    expect(render(<AgyProbeResult agy={agy('installed', null)} live t={t} />).container.textContent).toBe('')
  })

  it('says agy works, or what to do when it did not answer', () => {
    expect(render(<AgyProbeResult agy={agy('working', true)} live t={t} />).container.textContent).toBe(en['setup.agyWorks'])
    cleanup()
    expect(render(<AgyProbeResult agy={agy('not-signed-in', false)} live t={t} />).container.textContent).toBe(en['setup.agySignIn'])
    cleanup()
    expect(render(<AgyProbeResult agy={agy('model-unavailable', false)} live t={t} />).container.textContent).toBe(en['setup.agyModel'])
    cleanup()
    expect(render(<AgyProbeResult agy={agy('failed', false)} live t={t} />).container.textContent).toBe(en['setup.agyFailed'])
  })
})
