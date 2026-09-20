/** Host Remote owner for the transcriber engine's readiness and future operations. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  runNotebookLmAuth, runNotebookLmAuthStatus,
  type NotebookLmAuthTerminalSession,
  type TranscriberAuthTerminal,
} from './auth.ts'
import { runDoctor, type TranscriberDoctorInternals } from './doctor.ts'
import { runImportFiles } from './import.ts'
import { runDependencyInstall } from './install.ts'
import { runListLectures } from './lectures.ts'
import type {
  TranscriberDoctorReport, TranscriberDoctorRequest, TranscriberImportReport,
  TranscriberImportRequest, TranscriberLectureListing, TranscriberLectureListingRequest,
} from './types.ts'

export type * from './types.ts'
export {
  buildDoctorCommand, buildEngineCommand, parseDoctorReport,
  type TranscriberDoctorCommand, type TranscriberDoctorMode,
} from './doctor.ts'
export type { TranscriberDoctorInternals } from './doctor.ts'
export {
  notebookLmProbePassed, runNotebookLmAuth,
  runNotebookLmAuthStatus,
  type NotebookLmAuthTerminalPoll, type NotebookLmAuthTerminalSession, type TranscriberAuthTerminal,
} from './auth.ts'
export {
  runDependencyInstall,
  TERMINAL_LAUNCHERS,
  type TranscriberInstallExecution,
  type TranscriberInstallInternals,
} from './install.ts'
export { parseLectureListingOutput } from './lectures.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the transcriber engine Remote namespace. */
    transcriberEngine: TranscriberEngine
  }
}

/** Host service backing `ctx.remote.transcriberEngine`. */
export class TranscriberEngine extends TypertRemoteService {
  static inject = ['subprocess']

  private readonly internals: TranscriberDoctorInternals
  private authSession: NotebookLmAuthTerminalSession | undefined

  /**
   * @param ctx - Host context carrying the subprocess provider.
   * @param internals - optional process seams used by direct tests.
   */
  constructor(ctx: Context, internals: TranscriberDoctorInternals = {}) {
    super(ctx, 'transcriberEngine')
    this.internals = internals
  }

  /**
   * Run the engine's presence or liveness doctor.
   *
   * A valid report resolves even when its `ok` and `exit_code` say the doctor
   * failed. Only a missing launcher, failed process start, cancellation, or
   * invalid JSON rejects the Remote call.
   * @param request - whether to run the slow liveness probes.
   * @param signal - caller cancellation, including page disposal.
   * @returns the parsed engine report.
   */
  @Remote
  doctor(request: TranscriberDoctorRequest, signal: AbortSignal): Promise<TranscriberDoctorReport> {
    const spawn = this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec))
    return runDoctor(request, signal, this.internals, spawn)
  }

  /**
   * Install one missing dependency through its declared Host route and re-run a presence check.
   * User-scope routes run in the Host process; privileged routes use `pkexec` or a prefilled
   * terminal, and the application never receives an operating-system password.
   * @param request - dependency name from the current doctor report.
   * @param signal - cancellation owned by the streamed Remote call.
   * @returns install output and the fresh doctor report when the install succeeds.
   */
  @Remote({ mode: 'stream' })
  async *installDependency(
    request: import('./types.ts').TranscriberInstallRequest,
    signal: AbortSignal,
  ): AsyncIterable<import('./types.ts').TranscriberInstallFrame> {
    const report = await this.doctor({ live: false }, signal)
    const dependency = report.dependencies.find(item => item.name === request.name)
    if (dependency === undefined) {
      throw new RemoteError('gateway/bad-request', `Unknown transcriber dependency: ${request.name}`, {})
    }
    const spawn = this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec))
    const resolveExecutable = this.internals.resolveExecutable
      ?? ((command, environment, resolveSignal) => this.ctx.subprocess.resolveExecutable(
        command,
        stringEnvironment(environment),
        resolveSignal,
      ))
    yield* runDependencyInstall(
      {
        dependency,
        signal,
        internals: this.internals,
        spawn,
        resolveExecutable,
        reProbe: probeSignal => this.doctor({ live: false }, probeSignal),
      },
    )
  }

  /**
   * Check the NotebookLM session with `nlm login --check`, independently of engine readiness.
   * A missing CLI or expired session resolves as disconnected so the Settings page can show
   * the repair state without turning an expected auth failure into a broken screen.
   * @param signal - cancellation owned by the Remote call.
   * @returns the connection state and its coarse cause.
   */
  @Remote
  authStatus(signal: AbortSignal): Promise<import('./types.ts').TranscriberAuthStatus> {
    const spawn = this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec))
    const resolveExecutable = this.internals.resolveExecutable
      ?? ((command, environment, resolveSignal) => this.ctx.subprocess.resolveExecutable(
        command,
        stringEnvironment(environment),
        resolveSignal,
      ))
    return runNotebookLmAuthStatus(signal, resolveExecutable, spawn, this.internals.environment)
  }

  /**
   * List a module's local and NotebookLM recordings through the engine MCP server.
   *
   * A valid engine answer resolves even when its `warning` field says that
   * NotebookLM could not be reached. Process-start failures, cancellation, and
   * invalid MCP output reject so the browser can keep the disk view and explain
   * why the remote half is unavailable.
   * @param request - module id to list.
   * @param signal - cancellation owned by the Remote call.
   * @returns the validated lecture listing and any engine warning.
   */
  @Remote
  listLectures(
    request: TranscriberLectureListingRequest,
    signal: AbortSignal,
  ): Promise<TranscriberLectureListing> {
    const spawn = this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec))
    return runListLectures(request, signal, this.internals, spawn)
  }

  /**
   * Copy dropped source files into one module folder without overwriting existing files.
   * Invalid module paths reject before copying; file-level format, source, and
   * collision failures are returned in the report so one bad drop cannot hide
   * files that landed successfully.
   * @param request - module, `Lecture` or `Questions`, and absolute source paths.
   * @param signal - cancellation owned by the Remote call.
   * @returns copied files and per-file rejections.
   */
  @Remote
  importFiles(request: TranscriberImportRequest, signal: AbortSignal): Promise<TranscriberImportReport> {
    return runImportFiles(request, signal, this.internals)
  }

  /**
   * Stream the native `nlm login` conversation and verify it with `nlm login --check`.
   * @param signal - cancellation owned by the Remote stream.
   * @returns PTY notices, detected prompts, and a probe-backed settlement.
   */
  @Remote({ mode: 'stream' })
  async *auth(signal: AbortSignal): AsyncIterable<import('./types.ts').TranscriberAuthFrame> {
    if (this.authSession !== undefined) {
      throw new RemoteError('transcriber-engine/auth-in-progress', 'NotebookLM authentication is already running', {})
    }
    const terminal = this.authTerminal()
    if (terminal === undefined) {
      throw new RemoteError(
        'transcriber-engine/auth-unavailable',
        'NotebookLM login needs the desktop application; this browser profile cannot open it.',
        { command: 'nlm login', detail: 'native desktop PTY is unavailable' },
      )
    }
    const tracked = this.trackAuthTerminal(terminal)
    try {
      yield* runNotebookLmAuth(
        signal,
        tracked,
        statusSignal => this.authStatus(statusSignal).then(status => status.connected),
      )
    } finally {
      this.authSession = undefined
    }
  }

  /**
   * Send one line to the running NotebookLM auth PTY.
   * @param line - user-entered response without an implicit newline.
   * @returns after the native host accepts the response.
   */
  @Remote
  async answerAuth(line: string): Promise<void> {
    const session = this.authSession
    if (session === undefined) return
    const terminal = this.authTerminal()
    if (terminal === undefined) return
    await terminal.write(session, line)
  }

  /**
   * Cancel the running NotebookLM auth PTY, if one exists.
   * @returns after the native host requests termination.
   */
  @Remote
  async cancelAuth(): Promise<void> {
    const session = this.authSession
    if (session === undefined) return
    const terminal = this.authTerminal()
    if (terminal === undefined) return
    this.authSession = undefined
    await terminal.cancel(session)
  }

  private authTerminal(): TranscriberAuthTerminal | undefined {
    if (this.internals.authTerminal !== undefined) return this.internals.authTerminal
    const desktop = this.ctx.get('desktop') as {
      startNotebookLmAuth(): Promise<NotebookLmAuthTerminalSession>
      pollNotebookLmAuth(session: NotebookLmAuthTerminalSession, cursor: number, signal?: AbortSignal): Promise<{
        readonly cursor: number
        readonly output: string
        readonly done: boolean
        readonly failure: string | null
      }>
      writeNotebookLmAuth(session: NotebookLmAuthTerminalSession, line: string): Promise<void>
      cancelNotebookLmAuth(session: NotebookLmAuthTerminalSession): Promise<void>
    } | undefined
    if (desktop === undefined) return undefined
    return {
      start: () => desktop.startNotebookLmAuth(),
      poll: (session, cursor, signal) => desktop.pollNotebookLmAuth(session, cursor, signal),
      write: (session, line) => desktop.writeNotebookLmAuth(session, line),
      cancel: session => desktop.cancelNotebookLmAuth(session),
    }
  }

  private trackAuthTerminal(terminal: TranscriberAuthTerminal): TranscriberAuthTerminal {
    return {
      start: async () => {
        const session = await terminal.start()
        this.authSession = session
        return session
      },
      poll: (session, cursor, signal) => terminal.poll(session, cursor, signal),
      write: (session, line) => terminal.write(session, line),
      cancel: async (session) => {
        await terminal.cancel(session)
        if (this.authSession?.session === session.session) this.authSession = undefined
      },
    }
  }
}

export default TranscriberEngine

function stringEnvironment(environment: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> | undefined {
  if (environment === undefined) return undefined
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
