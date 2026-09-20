/** NotebookLM authentication uses a fake PTY and the real doctor decision. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { TranscriberEngine } from '../src/index.ts'
import type { TranscriberAuthTerminal, NotebookLmAuthTerminalPoll, NotebookLmAuthTerminalSession } from '../src/auth.ts'
import type { TranscriberAuthFrame } from '../src/types.ts'

const FIXTURE = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/doctor-live-windows.json'), 'utf8')) as {
  dependencies: Array<{ name: string; probe: { passed: boolean | null } | null }>
  exit_code: number
  ok: boolean
}

function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function handle(stdout: string): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader('') },
    done: Promise.resolve({ exitCode: 1, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

class FakeAuthTerminal implements TranscriberAuthTerminal {
  readonly session: NotebookLmAuthTerminalSession = { session: 'fixture' }
  readonly writes: string[] = []
  private readonly answered = Promise.withResolvers<undefined>()
  private polls = 0

  constructor(private readonly finishImmediately = false) {}

  start = vi.fn(async () => this.session)

  poll = vi.fn(async (
    _session: NotebookLmAuthTerminalSession,
    cursor: number,
    _signal: AbortSignal,
  ): Promise<NotebookLmAuthTerminalPoll> => {
    this.polls += 1
    if (this.polls === 1 && this.finishImmediately) {
      return { cursor: cursor + 20, output: 'Authentication finished.', done: true, failure: null }
    }
    if (this.polls === 1) return { cursor: cursor + 20, output: 'Open https://accounts.example.test\nPaste code: ', done: false, failure: null }
    await this.answered.promise
    return { cursor: cursor + 1, output: '', done: true, failure: null }
  })

  write = vi.fn(async (_session: NotebookLmAuthTerminalSession, line: string) => {
    this.writes.push(line)
    this.answered.resolve(undefined)
  })

  cancel = vi.fn(async () => {})
}

function service(terminal: FakeAuthTerminal): TranscriberEngine {
  const report = structuredReport()
  return new TranscriberEngine(new Context(), {
    environment: { TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' },
    fileExists: () => true,
    spawn: () => handle(report),
    authTerminal: terminal,
  })
}

function structuredReport(): string {
  const report = structuredFixture()
  report.exit_code = 1
  report.ok = false
  const nlm = report.dependencies.find(dependency => dependency.name === 'nlm')
  if (nlm?.probe !== null && nlm !== undefined) nlm.probe.passed = true
  return JSON.stringify(report)
}

function structuredFixture(): typeof FIXTURE {
  return JSON.parse(JSON.stringify(FIXTURE)) as typeof FIXTURE
}

describe('NotebookLM authentication flow', () => {
  it('sends a line through the fake PTY and authorizes from the nlm probe, not exit code', async () => {
    const terminal = new FakeAuthTerminal()
    const endpoint = service(terminal)
    const iterator = endpoint.auth(new AbortController().signal)[Symbol.asyncIterator]()

    const notice = await nextFrame(iterator)
    expect(notice.type).toBe('notice')
    if (notice.type === 'notice') expect(notice.message).toContain('https://accounts.example.test')
    const prompt = await nextFrame(iterator)
    expect(prompt).toMatchObject({ type: 'prompt', id: 'line' })
    await endpoint.answerAuth('fixture-code')
    expect(await nextFrame(iterator)).toMatchObject({ type: 'settled', outcome: 'authorized' })
    expect(terminal.writes).toEqual(['fixture-code'])
    expect(terminal.poll).toHaveBeenCalled()
  })

  it('reports the doctor failure hint when the nlm probe remains red', async () => {
    const terminal = new FakeAuthTerminal(true)
    const report = structuredFixture()
    const nlm = report.dependencies.find(dependency => dependency.name === 'nlm')
    if (nlm?.probe !== null && nlm !== undefined) nlm.probe.passed = false
    const endpoint = new TranscriberEngine(new Context(), {
      environment: { TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' },
      fileExists: () => true,
      spawn: () => handle(JSON.stringify(report)),
      authTerminal: terminal,
    })
    const frames: TranscriberAuthFrame[] = []
    for await (const frame of endpoint.auth(new AbortController().signal)) frames.push(frame)
    const last = frames.at(-1)
    expect(last).toMatchObject({ type: 'settled', outcome: 'failed' })
    if (last?.type === 'settled') expect(last.message).toContain('nlm auth')
  })

  it('fails before opening a stream when no native PTY is available', async () => {
    const endpoint = new TranscriberEngine(new Context())
    const iterator = endpoint.auth(new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'transcriber-engine/auth-unavailable',
    })
  })
})

async function nextFrame(iterator: AsyncIterator<TranscriberAuthFrame>): Promise<TranscriberAuthFrame> {
  const result = await iterator.next()
  if (result.done) throw new Error('auth stream ended before the expected frame')
  return result.value
}
