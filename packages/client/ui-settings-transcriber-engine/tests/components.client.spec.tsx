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
    expect(view.container.textContent).toContain('Read PDF text · Required')
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
})
