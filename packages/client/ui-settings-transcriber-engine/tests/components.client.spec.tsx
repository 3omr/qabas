// @vitest-environment jsdom
/** Settings page behavior: state mapping, pending actions, and platform guidance. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { en } from '../src/client/locales.ts'
import {
  failureHintOf,
  TranscriberEngineSection,
  type TranscriberEngineSectionProps,
} from '../src/client/TranscriberEngineSection.tsx'

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

function mount(report: TranscriberDoctorReport = REPORT) {
  const doctor = vi.fn().mockResolvedValue({ ok: true as const, value: report })
  const authStatus = vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } })
  const installDependency = vi.fn(async function* () {})
  const props = {
    close: vi.fn(),
    t: translate,
    engine: { doctor, authStatus, installDependency },
  } as unknown as TranscriberEngineSectionProps
  return { doctor, authStatus, installDependency, view: render(<TranscriberEngineSection {...props} />) }
}

describe('TranscriberEngineSection', () => {
  it('renders disconnected, missing, and installed-but-unhealthy rows', async () => {
    const { view } = mount()
    await waitFor(() => {
      expect([...view.container.querySelectorAll('[data-catalog-entry] [data-catalog-status]')].map(node => node.textContent)).toEqual([
        'Ready', 'Installed but not working', 'Not installed',
      ])
      expect(view.container.querySelector('[data-catalog-entry="nlm"] [data-catalog-status]')?.textContent).toBe('Installed but not working')
    })

    // poppler-utils is a tool this page carries copy for, so its own sentence
    // is shown rather than the engine's -- the engine writes English for the
    // terminal, and these strings are read by a student.
    expect(view.container.textContent).toContain(
      "Reading a PDF's text layer to decide whether it needs OCR · Required")
    expect(view.container.textContent).not.toContain('Read PDF text')
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
    await waitFor(() => { expect(view.container.textContent).toContain('Something the engine added') })
    expect(view.container.textContent).not.toContain('undefined')

    expect(view.container.textContent).not.toContain('tool.newtool')
  })

  it('shows only the report install command for a failing tool', async () => {
    const { view } = mount()
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-entry="poppler-utils"]')).not.toBeNull() })
    fireEvent.click(view.container.querySelector('[data-catalog-entry="nlm"]')!)
    // The page's own copy, not the engine's terminal wording: an installed
    // but signed-out nlm is fixed by the connect button right here.
    expect(view.container.querySelector('[data-transcriber-dependency="nlm"]')?.textContent).toContain(en['hint.nlm'])
    expect(view.container.querySelector('[data-transcriber-dependency="nlm"]')?.textContent).not.toContain('Run `nlm login`.')
    expect(view.container.querySelector('[data-transcriber-dependency="nlm"]')?.textContent).not.toContain('pipx install notebooklm-mcp-cli')
    fireEvent.click(view.container.querySelector('[data-catalog-entry="poppler-utils"]')!)

    const detail = view.container.querySelector('[data-transcriber-dependency="poppler-utils"]')
    expect(detail?.textContent).toContain('winget install oschwartz10612.Poppler')
    expect(detail?.textContent).not.toContain('apt install')
    expect(detail?.textContent).not.toContain('brew install')
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
    const view = render(<TranscriberEngineSection {...{
      close: vi.fn(),
      t: translate,
      engine: { doctor, authStatus, installDependency, auth: vi.fn(async function* () {}), answerAuth: vi.fn(), cancelAuth: vi.fn() },
    } as unknown as TranscriberEngineSectionProps} />)
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-entry="nlm"]')).not.toBeNull() })
    fireEvent.click(view.container.querySelector('[data-catalog-entry="nlm"]')!)
    fireEvent.click(view.getByRole('button', { name: 'Install for this user' }))
    await waitFor(() => { expect(view.getByText('pipx: network failed')).toBeTruthy() })
    expect(view.getByText('pipx install notebooklm-mcp-cli')).toBeTruthy()
    expect(view.getByText('The installation did not finish. The installer output is kept below.')).toBeTruthy()
  })

  it('keeps presence and live checks as separate actions', async () => {
    const { doctor, view } = mount()
    await waitFor(() => { expect(doctor).toHaveBeenCalledWith({ live: false }, expect.any(AbortSignal)) })
    fireEvent.click(view.getByRole('button', { name: 'Check again' }))
    await waitFor(() => { expect(doctor).toHaveBeenCalledTimes(2) })
    fireEvent.click(view.getByRole('button', { name: 'Run live checks' }))
    expect(doctor).toHaveBeenLastCalledWith({ live: true }, expect.any(AbortSignal))
  })

  it('shows a visible pending state while the initial report is awaited', () => {
    const doctor = vi.fn(() => new Promise<never>(() => {}))
    const props = {
      close: vi.fn(),
      t: translate,
      engine: {
        doctor,
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
      },
    } as unknown as TranscriberEngineSectionProps
    const view = render(<TranscriberEngineSection {...props} />)
    expect(view.getByRole('status').textContent).toBe('Checking tools…')
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
      engine: {
        doctor,
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
        auth,
        answerAuth,
        cancelAuth: vi.fn().mockResolvedValue({ ok: true as const, value: undefined }),
      },
    } as unknown as TranscriberEngineSectionProps
    const view = render(<TranscriberEngineSection {...props} />)
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
      engine: {
        doctor: vi.fn().mockResolvedValue({ ok: true as const, value: REPORT }),
        authStatus: vi.fn().mockResolvedValue({ ok: true as const, value: { connected: false, reason: 'not-connected' as const } }),
        install: vi.fn(async function* () {}),
        auth: failedAuth,
        answerAuth: vi.fn(),
        cancelAuth: vi.fn(),
      },
    } as unknown as TranscriberEngineSectionProps
    const probeFailureView = render(<TranscriberEngineSection {...probeFailureProps} />)
    await waitFor(() => { expect(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(probeFailureView.getByText('Run `nlm login` again.')).toBeTruthy() })
    cleanup()

    const unavailableProps = {
      close: vi.fn(),
      t: translate,
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
    } as unknown as TranscriberEngineSectionProps
    const unavailableView = render(<TranscriberEngineSection {...unavailableProps} />)
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
