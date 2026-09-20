/** Interactive NotebookLM authentication over the native desktop PTY. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TranscriberAuthFrame, TranscriberDoctorReport } from './types.ts'

/** Native session handle used only inside the Host process. */
export interface NotebookLmAuthTerminalSession {
  readonly session: string
}

/** One bounded poll from the native PTY owner. */
export interface NotebookLmAuthTerminalPoll {
  readonly cursor: number
  readonly output: string
  readonly done: boolean
  readonly failure: string | null
}

/** Process-facing terminal operations used by the auth flow and its fake tests. */
export interface TranscriberAuthTerminal {
  start(): Promise<NotebookLmAuthTerminalSession>
  poll(session: NotebookLmAuthTerminalSession, cursor: number, signal: AbortSignal): Promise<NotebookLmAuthTerminalPoll>
  write(session: NotebookLmAuthTerminalSession, line: string): Promise<void>
  cancel(session: NotebookLmAuthTerminalSession): Promise<void>
}

const AUTH_PROMPT_ID = 'line'
const AUTH_POLL_DELAY_MS = 100
const FALLBACK_MESSAGE = 'NotebookLM authentication could not finish. Run `nlm auth` in a terminal.'

/**
 * Run the PTY conversation and verify it with the engine's NotebookLM probe.
 * @param signal - lifetime of the streamed Remote call.
 * @param terminal - native PTY adapter, or a fake process for tests.
 * @param doctor - live engine doctor callback used as the only success check.
 * @returns output, detected input prompts, and the probe-backed settlement.
 */
export async function* runNotebookLmAuth(
  signal: AbortSignal,
  terminal: TranscriberAuthTerminal,
  doctor: (signal: AbortSignal) => Promise<TranscriberDoctorReport>,
): AsyncIterable<TranscriberAuthFrame> {
  let session: NotebookLmAuthTerminalSession
  try {
    session = await terminal.start()
  } catch (error: unknown) {
    throw authUnavailable(messageOf(error))
  }
  let cursor = 0
  let settled = false
  try {
    while (!signal.aborted) {
      const poll = await terminal.poll(session, cursor, signal)
      cursor = poll.cursor
      if (poll.output.length > 0) {
        const message = cleanTerminalText(poll.output)
        yield { type: 'notice', message }
        const prompt = promptMessage(message)
        if (prompt !== undefined) yield { type: 'prompt', id: AUTH_PROMPT_ID, message: prompt }
      }
      if (poll.failure !== null) {
        yield { type: 'settled', outcome: 'failed', message: FALLBACK_MESSAGE }
        settled = true
        return
      }
      if (poll.done) {
        const report = await doctor(signal)
        if (!notebookLmProbePassed(report)) {
          yield { type: 'settled', outcome: 'failed', message: notebookLmFailureMessage(report) }
          settled = true
          return
        }
        yield { type: 'settled', outcome: 'authorized' }
        settled = true
        return
      }
      await waitForNextPoll(signal)
    }
  } finally {
    if (!settled) await terminal.cancel(session)
  }
}

/**
 * Decide connection from the engine's `nlm notebook list` probe, never exit code.
 * @param report - doctor dependency facts from the live engine check.
 * @returns whether the `nlm` dependency probe passed.
 */
export function notebookLmProbePassed(report: Pick<TranscriberDoctorReport, 'dependencies'>): boolean {
  return report.dependencies.find(dependency => dependency.name === 'nlm')?.probe?.passed === true
}

function notebookLmFailureMessage(report: Pick<TranscriberDoctorReport, 'dependencies'>): string {
  const hint = report.dependencies.find(dependency => dependency.name === 'nlm')?.failure_hint.trim()
  return hint === undefined || hint.length === 0 ? FALLBACK_MESSAGE : hint
}

function promptMessage(output: string): string | undefined {
  const lastLine = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1)
  if (lastLine === undefined || /^https?:\/\//u.test(lastLine)) return undefined
  return /(?:[:?]|\b(?:enter|paste|type|code|email|verification)\b)\s*$/iu.test(lastLine)
    ? lastLine
    : undefined
}

function cleanTerminalText(output: string): string {
  return output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
}

function authUnavailable(detail: string): RemoteError<'transcriber-engine/auth-unavailable'> {
  return new RemoteError(
    'transcriber-engine/auth-unavailable',
    'Could not start NotebookLM authentication. Run `nlm auth` in a terminal.',
    { command: 'nlm auth', detail },
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitForNextPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, AUTH_POLL_DELAY_MS)
    function onAbort(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (signal.reason instanceof Error) {
        reject(signal.reason)
        return
      }
      reject(new Error('NotebookLM authentication cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
