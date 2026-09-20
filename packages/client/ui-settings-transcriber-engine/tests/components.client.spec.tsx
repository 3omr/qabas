// @vitest-environment jsdom
/** Settings page behavior: state mapping, pending actions, and platform guidance. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { en } from '../src/client/locales.ts'
import {
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
      failure_hint: 'Run `nlm auth`.',
      install_command: 'https://github.com/tmc/nlm -- then run `nlm auth`',
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
  const props = {
    close: vi.fn(),
    t: translate,
    engine: { doctor },
  } as unknown as TranscriberEngineSectionProps
  return { doctor, view: render(<TranscriberEngineSection {...props} />) }
}

describe('TranscriberEngineSection', () => {
  it('renders ready, missing, and installed-but-unhealthy rows', async () => {
    const { view } = mount()
    await waitFor(() => { expect(view.container.querySelectorAll('[data-catalog-entry]')).toHaveLength(3) })

    expect([...view.container.querySelectorAll('[data-catalog-entry] [data-catalog-status]')].map(node => node.textContent)).toEqual([
      'Ready', 'Installed but not working', 'Not installed',
    ])
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
      }],
    })
    await waitFor(() => { expect(view.container.textContent).toContain('Something the engine added') })

    expect(view.container.textContent).not.toContain('tool.newtool')
  })

  it('shows only the report install command for a failing tool', async () => {
    const { view } = mount()
    await waitFor(() => { expect(view.container.querySelector('[data-catalog-entry="poppler-utils"]')).not.toBeNull() })
    fireEvent.click(view.container.querySelector('[data-catalog-entry="nlm"]')!)
    expect(view.container.querySelector('[data-transcriber-dependency="nlm"]')?.textContent).toContain('Run `nlm auth`.')
    fireEvent.click(view.container.querySelector('[data-catalog-entry="poppler-utils"]')!)

    const detail = view.container.querySelector('[data-transcriber-dependency="poppler-utils"]')
    expect(detail?.textContent).toContain('winget install oschwartz10612.Poppler')
    expect(detail?.textContent).not.toContain('apt install')
    expect(detail?.textContent).not.toContain('brew install')
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
      engine: { doctor },
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

  it('shows an actionable probe failure and the exact terminal fallback when PTY start fails', async () => {
    const failedAuth = vi.fn(async function* () {
      yield { type: 'settled' as const, outcome: 'failed' as const, message: 'Run `nlm auth` again.' }
    })
    const probeFailureProps = {
      close: vi.fn(),
      t: translate,
      engine: {
        doctor: vi.fn().mockResolvedValue({ ok: true as const, value: REPORT }),
        auth: failedAuth,
        answerAuth: vi.fn(),
        cancelAuth: vi.fn(),
      },
    } as unknown as TranscriberEngineSectionProps
    const probeFailureView = render(<TranscriberEngineSection {...probeFailureProps} />)
    await waitFor(() => { expect(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(probeFailureView.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(probeFailureView.getByText('Run `nlm auth` again.')).toBeTruthy() })
    cleanup()

    const unavailableProps = {
      close: vi.fn(),
      t: translate,
      engine: {
        doctor: vi.fn().mockResolvedValue({ ok: true as const, value: REPORT }),
        auth: vi.fn().mockRejectedValue(new Error('native PTY unavailable')),
        answerAuth: vi.fn(),
        cancelAuth: vi.fn(),
      },
    } as unknown as TranscriberEngineSectionProps
    const unavailableView = render(<TranscriberEngineSection {...unavailableProps} />)
    await waitFor(() => { expect(unavailableView.getByRole('button', { name: 'Connect to NotebookLM' })).toBeTruthy() })
    fireEvent.click(unavailableView.getByRole('button', { name: 'Connect to NotebookLM' }))
    await waitFor(() => { expect(unavailableView.getByText('nlm auth')).toBeTruthy() })
    expect(unavailableView.getByText('The in-app connection could not start. Run this exact command in a terminal:')).toBeTruthy()
  })
})
