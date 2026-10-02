/** Interactive NotebookLM authentication over the native desktop PTY. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { engineWorkspacePath } from './workspace.ts'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { TranscriberAuthFrame, TranscriberDoctorReport } from './types.ts'
import type { TranscriberAuthStatus } from './types.ts'

/** Native session handle used only inside the Host process. */
export interface NotebookLmAuthTerminalSession {
  /** Opaque session id owned by the native PTY provider. */
  readonly session: string
}

/** One bounded poll from the native PTY owner. */
export interface NotebookLmAuthTerminalPoll {
  /** Number of output characters already consumed by the caller. */
  readonly cursor: number
  /** New terminal output after the previous cursor. */
  readonly output: string
  /** Whether the native process has ended. */
  readonly done: boolean
  /** Provider failure text, or null when the poll succeeded. */
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
const FALLBACK_MESSAGE = 'NotebookLM login did not complete.'
const AUTH_STATUS_GRACE_MS = 5000

/**
 * Run the PTY conversation and verify it with the engine's NotebookLM probe.
 * @param signal - lifetime of the streamed Remote call.
 * @param terminal - native PTY adapter, or a fake process for tests.
 * @param check - `nlm login --check` callback used as the only connection check.
 * @returns output, detected input prompts, and the probe-backed settlement.
 */
export async function* runNotebookLmAuth(
  signal: AbortSignal,
  terminal: TranscriberAuthTerminal,
  check: (signal: AbortSignal) => Promise<boolean>,
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
        if (!await check(signal)) {
          yield { type: 'settled', outcome: 'failed', message: FALLBACK_MESSAGE }
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

/**
 * Run `nlm login --check` without confusing authentication with readiness.
 * @param signal - cancellation owned by the Remote call.
 * @param resolveExecutable - Host executable resolver for `nlm`.
 * @param spawn - Host subprocess provider used for the check.
 * @param environment - environment passed to executable lookup and the child.
 * @returns the connection state and its coarse cause.
 */
export async function runNotebookLmAuthStatus(
  signal: AbortSignal,
  resolveExecutable: (
    command: string,
    environment?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string>,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<TranscriberAuthStatus> {
  signal.throwIfAborted()
  let executable: string
  try {
    executable = await resolveExecutable('nlm', environment, signal)
  } catch {
    if (signal.aborted) throw cancelledStatus()
    return { connected: false, reason: 'not-installed' }
  }
  let handle: SubprocessHandle
  try {
    handle = spawn({
      argv: [executable, 'login', '--check'],
      cwd: engineWorkspacePath(environment),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: AUTH_STATUS_GRACE_MS,
      signal,
      env: environment,
    })
  } catch {
    if (signal.aborted) throw cancelledStatus()
    return { connected: false, reason: 'unavailable' }
  }
  try {
    const outcome = await handle.done
    if (!await handle.waitForExit(signal)) throw cancelledStatus()
    if (signal.aborted) throw cancelledStatus()
    return outcome.exitCode === 0 && outcome.signal === null
      ? { connected: true, reason: 'connected' }
      : { connected: false, reason: 'not-connected' }
  } catch (error: unknown) {
    if (signal.aborted) throw cancelledStatus()
    if (error instanceof RemoteError) throw error
    return { connected: false, reason: 'unavailable' }
  }
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
    'NotebookLM login could not start inside the application.',
    { command: 'nlm login', detail },
  )
}

function cancelledStatus(): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
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
