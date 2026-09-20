/** Dependency installation uses fake subprocesses and executable lookup only. */

import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { installRouteOf, runDependencyInstall } from '../src/install.ts'
import { TranscriberEngine } from '../src/index.ts'
import type {
  TranscriberDependencyReport, TranscriberDoctorReport, TranscriberInstallFrame,
} from '../src/types.ts'

function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function processHandle(stdout: string, stderr: string, exitCode: number): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: stdout === '' ? undefined : Readable.from([stdout]),
    stderr: stderr === '' ? undefined : Readable.from([stderr]),
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

function dependency(name: string, command: string, route: TranscriberDependencyReport['install_route']): TranscriberDependencyReport {
  return {
    name,
    purpose: name,
    required: true,
    resolved: false,
    path: null,
    probe: { ran: false, passed: null, failure: null },
    failure_hint: '',
    install_command: command,
    install_route: route,
  }
}

function report(name: string, resolved: boolean): TranscriberDoctorReport {
  const route = name === 'nlm' ? 'user' : 'privileged'
  return {
    platform: 'linux',
    live: false,
    python: { version: '3.12', minimum_version: '3.10', supported: true },
    dependencies: [{ ...dependency(name, name === 'nlm' ? 'pipx install notebooklm-mcp-cli' : 'apt-get install -y poppler-utils', route), resolved }],
    ok: resolved,
    exit_code: resolved ? 0 : 1,
  }
}

async function framesFrom(
  item: TranscriberDependencyReport,
  found: readonly string[],
  spawned: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  fresh: () => Promise<TranscriberDoctorReport>,
): Promise<TranscriberInstallFrame[]> {
  const resolveExecutable = vi.fn(async (command: string) => {
    if (!found.includes(command)) throw new Error(`${command} missing`)
    return `/usr/bin/${command}`
  })
  const frames: TranscriberInstallFrame[] = []
  for await (const frame of runDependencyInstall(
    {
      dependency: item,
      signal: new AbortController().signal,
      internals: { environment: { TRANSCRIBER_WORKSPACE: '/workspace' } },
      spawn: spawned,
      resolveExecutable,
      reProbe: fresh,
    },
  )) frames.push(frame)
  return frames
}

describe('transcriber dependency installation', () => {
  it('installs nlm with pipx, streams output, and re-probes', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const fresh = vi.fn(async () => report('nlm', true))
    const frames = await framesFrom(
      dependency('nlm', 'pipx install notebooklm-mcp-cli', 'user'),
      ['pipx'],
      (spec) => { specs.push(spec); return processHandle('downloaded\n', 'warning\n', 0) },
      fresh,
    )

    expect(specs[0]?.argv).toEqual(['/usr/bin/pipx', 'install', 'notebooklm-mcp-cli'])
    expect(frames).toContainEqual({ type: 'output', stream: 'stdout', text: 'downloaded\n' })
    expect(frames).toContainEqual({ type: 'output', stream: 'stderr', text: 'warning\n' })
    expect(frames.at(-1)).toMatchObject({ type: 'settled', outcome: 'installed', report: { dependencies: [{ resolved: true }] } })
    expect(fresh).toHaveBeenCalledOnce()
  })

  it('uses pkexec for a privileged package install without exposing password input', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const frames = await framesFrom(
      dependency('poppler-utils', 'apt-get install poppler-utils', 'privileged'),
      ['apt-get', 'pkexec'],
      (spec) => { specs.push(spec); return processHandle('', '', 0) },
      async () => report('poppler-utils', true),
    )

    expect(specs[0]?.argv).toEqual(['/usr/bin/pkexec', '/usr/bin/apt-get', '-y', 'install', 'poppler-utils'])
    expect(specs[0]?.stdio.stdin).toBe('ignore')
    expect(frames[0]).toMatchObject({ type: 'plan', launcher: 'pkexec', route: 'privileged' })
  })

  it('names pipx when the no-elevation NotebookLM installer is absent', async () => {
    const frames = await framesFrom(
      dependency('nlm', 'pipx install notebooklm-mcp-cli', 'user'),
      [],
      () => { throw new Error('installer must not spawn') },
      async () => report('nlm', true),
    )

    expect(frames[0]).toMatchObject({ type: 'plan', launcher: 'copy', prerequisite: 'pipx' })
    expect(frames.at(-1)).toEqual({ type: 'settled', outcome: 'failed', reason: 'pipx-missing' })
  })

  it('prefills the first available terminal when pkexec is absent', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const frames = await framesFrom(
      dependency('poppler-utils', 'apt-get install -y poppler-utils', 'privileged'),
      ['apt-get', 'sudo', 'gnome-terminal'],
      (spec) => { specs.push(spec); return processHandle('', '', 0) },
      async () => report('poppler-utils', true),
    )

    expect(specs[0]?.argv).toContain('/usr/bin/gnome-terminal')
    expect(specs[0]?.argv.join(' ')).toContain('sudo /usr/bin/apt-get install -y poppler-utils')
    expect(frames[0]).toMatchObject({ type: 'plan', launcher: 'terminal', terminal: 'gnome-terminal' })
    expect(frames.at(-1)).toMatchObject({ type: 'settled', outcome: 'installed' })
  })

  it.each([
    { found: [] as readonly string[], prerequisite: 'apt-get', reason: 'package-manager-missing' as const },
    { found: ['apt-get', 'sudo'], prerequisite: 'terminal emulator', reason: 'terminal-missing' as const },
  ])('returns a copy fallback when $reason', async ({ found, prerequisite, reason }) => {
    const frames = await framesFrom(
      dependency('poppler-utils', 'apt-get install -y poppler-utils', 'privileged'),
      found,
      () => { throw new Error('terminal spawn must not run') },
      async () => report('poppler-utils', true),
    )
    expect(frames[0]).toMatchObject({ type: 'plan', launcher: 'copy', prerequisite })
    expect(frames.at(-1)).toMatchObject({ type: 'settled', reason })
  })

  it('keeps installer output and the fallback after a failed command', async () => {
    const fresh = vi.fn(async () => report('nlm', true))
    const frames = await framesFrom(
      dependency('nlm', 'pipx install notebooklm-mcp-cli', 'user'),
      ['pipx'],
      () => processHandle('pipx: network failed\n', '', 1),
      fresh,
    )

    expect(frames).toContainEqual({ type: 'output', stream: 'stdout', text: 'pipx: network failed\n' })
    expect(frames.at(-1)).toEqual({ type: 'settled', outcome: 'failed', reason: 'process-failed', exit_code: 1 })
    expect(fresh).not.toHaveBeenCalled()
  })

  it('re-probes through the Host method and publishes the changed report', async () => {
    const missing = JSON.stringify(report('nlm', false))
    const installed = JSON.stringify(report('nlm', true))
    const specs: SubprocessSpawnSpec[] = []
    const endpoint = new TranscriberEngine(new Context(), {
      environment: { TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' },
      fileExists: () => true,
      resolveExecutable: async () => '/usr/bin/pipx',
      spawn: (spec) => {
        specs.push(spec)
        if (spec.argv[0] === 'python3') return processHandle(specs.length === 1 ? missing : installed, '', 1)
        return processHandle('installed\n', '', 0)
      },
    })

    const frames: TranscriberInstallFrame[] = []
    for await (const frame of endpoint.installDependency({ name: 'nlm' }, new AbortController().signal)) frames.push(frame)
    expect(specs).toHaveLength(3)
    expect(frames.at(-1)).toMatchObject({ type: 'settled', outcome: 'installed', report: { dependencies: [{ resolved: true }] } })
  })
  it('routes every installer that needs no password to the user route', () => {
    // macOS installs all of these through brew, and brew writes into the
    // user's own prefix. Reading only the elevated installers sent each of
    // them to 'manual', where the page can do nothing but print the command --
    // on that platform the install button had nothing left to install.
    expect(installRouteOf('brew install ffmpeg')).toBe('user')
    expect(installRouteOf('brew install --cask libreoffice')).toBe('user')
    expect(installRouteOf('pipx install notebooklm-mcp-cli')).toBe('user')
    expect(installRouteOf('apt install ffmpeg')).toBe('privileged')
    expect(installRouteOf('winget install Gyan.FFmpeg')).toBe('privileged')
    expect(installRouteOf('pip install -r requirements.txt')).toBe('manual')
  })
})
