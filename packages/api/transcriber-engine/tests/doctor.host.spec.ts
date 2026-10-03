/** Doctor report parsing and process-boundary behavior. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import {
  buildDoctorCommand, buildEngineCommand, parseDoctorReport, TranscriberEngine,
} from '../src/index.ts'
import type { TranscriberDoctorInternals } from '../src/index.ts'

const FIXTURE = readFileSync(resolve(import.meta.dirname, 'fixtures/doctor-live-windows.json'), 'utf8')

function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function handle(stdout: string, exitCode: number): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader('') },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

function service(
  stdout: string,
  exitCode: number,
  overrides: Partial<TranscriberDoctorInternals> = {},
): TranscriberEngine {
  const ctx = new Context()
  return new TranscriberEngine(ctx, {
    environment: {
      TRANSCRIBER_SKILL_ROOT: '/skill',
      TRANSCRIBER_WORKSPACE: '/workspace',
    },
    fileExists: () => true,
    spawn: () => handle(stdout, exitCode),
    ...overrides,
  })
}

describe('transcriber engine doctor report', () => {
  it('parses a recorded live report with a missing tool and a failed probe', () => {
    const report = parseDoctorReport(FIXTURE)
    expect(report.platform).toBe('win32')
    expect(report.live).toBe(true)
    expect(report.ok).toBe(false)
    const nlm = report.dependencies.find(dependency => dependency.name === 'nlm')
    const poppler = report.dependencies.find(dependency => dependency.name === 'poppler-utils')
    expect(nlm?.resolved).toBe(true)
    expect(nlm?.install_route).toBe('user')
    expect(nlm?.probe?.passed).toBe(false)
    expect(poppler?.resolved).toBe(false)
    expect(poppler?.install_route).toBe('privileged')
    expect(poppler?.probe?.ran).toBe(false)
  })

  it('shows a command it cannot execute instead of guessing at one', () => {
    // The engine states one executable command per platform and is tested for
    // it. If a hint ever carries prose again, the Host must not try to cut the
    // command back out of the sentence -- it routes the tool to 'manual', where
    // the page shows the text, and passes it through untouched.
    const fixture = JSON.parse(FIXTURE) as { dependencies: Array<{ name: string; install_command: string }> }
    const nlm = fixture.dependencies.find(dependency => dependency.name === 'nlm')
    if (nlm === undefined) throw new Error('fixture must contain nlm')
    nlm.install_command = 'pipx install notebooklm-mcp-cli -- then run `nlm login`'

    const parsed = parseDoctorReport(JSON.stringify(fixture)).dependencies[0]
    expect(parsed?.install_command).toBe('pipx install notebooklm-mcp-cli -- then run `nlm login`')
    expect(parsed?.install_route).toBe('manual')
  })

  it('preserves optional agy facts and treats a null install command as manual', () => {
    const fixture = JSON.parse(FIXTURE) as { dependencies: unknown[] }
    const agy = { name: 'agy', purpose: 'Recommended writer', required: false, resolved: true, installed: true,
      path: '/tools/agy', version: null, version_error: 'version timed out', disabled: false, model: 'gemini-3.8-flash-high',
      probe: null, install_command: null, install_hint: 'Install agy and sign in', failure_hint: 'Sign in', status: 'installed' }
    fixture.dependencies.push(agy)
    expect(parseDoctorReport(JSON.stringify(fixture)).dependencies.at(-1)).toEqual({ ...agy, install_route: 'manual' })
  })

  it('returns a valid failing report when the engine exits non-zero', async () => {
    const endpoint = service(FIXTURE, 1)
    const report = await endpoint.doctor({ live: true }, new AbortController().signal)
    expect(report.ok).toBe(false)
    expect(report.exit_code).toBe(1)
    expect(report.dependencies[0]?.probe?.passed).toBe(false)
  })

  it('builds the current interpreter-and-script command for both doctor modes', () => {
    const exists = vi.fn(() => true)
    expect(buildDoctorCommand('presence', {
      TRANSCRIBER_SKILL_ROOT: '/skill',
      TRANSCRIBER_WORKSPACE: '/workspace',
    }, exists)).toEqual({
      argv: ['python3', '/skill/scripts/run_transcription.py', '--workspace', '/workspace', '--doctor-json'],
      cwd: '/workspace',
    })
    expect(buildDoctorCommand('live', {
      TRANSCRIBER_SKILL_ROOT: '/skill',
      TRANSCRIBER_WORKSPACE: '/workspace',
    }, exists).argv).toContain('--doctor-live')
  })

  it('prefers the engine override while accepting a legacy skill root', () => {
    const both = { TRANSCRIBER_ENGINE_ROOT: '/engine', TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' }
    const command = buildDoctorCommand('presence', both, () => true)
    expect(command.argv[1]).toBe('/engine/scripts/run_transcription.py')
    expect(buildDoctorCommand('presence', { ...both, TRANSCRIBER_ENGINE_ROOT: '' }, () => true).argv[1])
      .toBe('/skill/scripts/run_transcription.py')
  })

  it('finds the repository engine when the host cwd is elsewhere', () => {
    const elsewhere = vi.spyOn(process, 'cwd').mockReturnValue('/another-workspace')
    try {
      const command = buildDoctorCommand('presence', { TRANSCRIBER_WORKSPACE: '/workspace' }, () => true)
      expect(command.argv[1]).toBe(resolve(import.meta.dirname, '../../../../engine/scripts/run_transcription.py'))
    } finally {
      elsewhere.mockRestore()
    }
  })

  it('dispatches a bundled onefile engine when source scripts are absent', () => {
    const executable = process.platform === 'win32' ? '/engine/transcriber-engine.exe' : '/engine/transcriber-engine'
    const exists = (path: string): boolean => path === executable || path === '/workspace'
    expect(buildEngineCommand('mcp_server.py', [], {
      TRANSCRIBER_ENGINE_ROOT: '/engine', TRANSCRIBER_WORKSPACE: '/workspace',
    }, exists)).toEqual({ argv: [executable, 'mcp-server', '--workspace', '/workspace'], cwd: '/workspace' })
    expect(buildDoctorCommand('presence', { TRANSCRIBER_ENGINE_ROOT: '/engine', TRANSCRIBER_WORKSPACE: '/workspace' }, exists).argv)
      .toEqual([executable, 'run-transcription', '--workspace', '/workspace', '--doctor-json'])
  })

  it('reports a missing launcher as an actionable Remote error', async () => {
    const endpoint = service('{}', 0, { fileExists: () => false })
    await expect(endpoint.doctor({ live: false }, new AbortController().signal))
      .rejects.toHaveProperty('code', 'transcriber-engine/not-found')
    await expect(endpoint.doctor({ live: false }, new AbortController().signal))
      .rejects.toHaveProperty('message', expect.stringContaining('TRANSCRIBER_ENGINE_ROOT'))
  })

  it('reports an unrunnable command when the output is not JSON', async () => {
    const endpoint = service('engine log', 1)
    await expect(endpoint.doctor({ live: false }, new AbortController().signal)).rejects.toMatchObject({
      code: 'transcriber-engine/invalid-report',
    })
  })

  it('reports a process-start failure as an actionable unavailable error', async () => {
    const endpoint = service(FIXTURE, 0, { spawn: () => { throw new Error('python3 was not found') } })
    const result = endpoint.doctor({ live: false }, new AbortController().signal)
    await expect(result).rejects.toHaveProperty('code', 'transcriber-engine/unavailable')
    await expect(result).rejects.toThrow('python3 was not found')
  })

  it('passes the caller signal to the subprocess and rejects an already-cancelled call', async () => {
    const signal = new AbortController()
    signal.abort()
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>()
    const endpoint = service(FIXTURE, 0, { spawn })
    await expect(endpoint.doctor({ live: true }, signal.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
