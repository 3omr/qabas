/** Host Remote owner for transcriber readiness, authentication, inventory, and workspace files. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  runNotebookLmAuth, runNotebookLmAuthStatus,
  type NotebookLmAuthTerminalSession,
  type TranscriberAuthTerminal,
} from './auth.ts'
import { runDoctor, type TranscriberDoctorInternals } from './doctor.ts'
import { editingRequests, editingResults, runEditingTool, runImportFile, type EditingOptions } from './editing.ts'
import { runImportFiles } from './import.ts'
import { runDependencyInstall } from './install.ts'
import { runListLectures } from './lectures.ts'
import { runListModules } from './modules.ts'
import { runListLibrary } from './library.ts'
import { runReadFile, runReadFileBytes, runStatFile, runWriteFile } from './files.ts'
import type {
  TranscriberLibraryRequest, TranscriberLibraryListing, TranscriberOrganizationProposal, TranscriberApplyOrganizationRequest,
  TranscriberOrganizationResult, TranscriberExamIndexResult,
  TranscriberModuleFiles, TranscriberDefineLectureRequest, TranscriberLectureDefinition, TranscriberDeleteLectureRequest,
  TranscriberRenameFileRequest, TranscriberModuleFileRequest, TranscriberUploadRecordingsRequest, TranscriberUploadRecordingsResult,
  TranscriberImportFileRequest, TranscriberImportFileResult,
  TranscriberDoctorReport, TranscriberDoctorRequest, TranscriberFileBytes, TranscriberFileConfig,
  TranscriberFileStat, TranscriberFileText, TranscriberFileWriteResult, TranscriberImportReport,
  TranscriberImportRequest, TranscriberLectureListing, TranscriberLectureListingRequest,
  TranscriberMcpConfig, TranscriberModuleListing, TranscriberReadFileBytesRequest, TranscriberReadFileRequest,
  TranscriberWriteFileRequest,
} from './types.ts'

/** Deployment caps for session-free workspace file reads and writes. */
export interface Config {
  /** Inclusive byte cap for browser imports; base64 must fit the Connection HTTP body cap. */
  readonly maxImportBytes?: number
  /** Inclusive byte cap for UTF-8 text reads and Markdown replacements. */
  readonly maxTextBytes?: number
  /** Inclusive byte cap for image and other binary reads. */
  readonly maxImageBytes?: number
  /** Inclusive byte cap per captured stdout/stderr stream of a listing process. */
  readonly mcpOutputMaxBytes?: number
  /** Deadline in milliseconds for an agy organization proposal. */
  readonly organizationTimeoutMs?: number
  /** Deadline in milliseconds for building the local exam index. */
  readonly examIndexTimeoutMs?: number
  /** Grace period in milliseconds before forcefully terminating an engine process. */
  readonly mcpGraceMs?: number
}

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  maxImportBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(128 * 1024 * 1024),
  mcpOutputMaxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(4 * 1024 * 1024),
  organizationTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5 * 60 * 1000),
  examIndexTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(20 * 60 * 1000),
  mcpGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5000),
  maxTextBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(8 * 1024 * 1024),
  maxImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER - 1).default(16 * 1024 * 1024),
})

interface TranscriberEngineOptions extends TranscriberDoctorInternals, Config {}

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
export { parseModuleListingOutput } from './modules.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the transcriber engine Remote namespace. */
    transcriberEngine: TranscriberEngine
  }
}

/** Host service backing `ctx.remote.transcriberEngine`. */
export class TranscriberEngine extends TypertRemoteService {
  static inject = ['subprocess']
  static Config: z<Config> = Config

  private readonly internals: TranscriberDoctorInternals
  private readonly fileConfig: TranscriberFileConfig & TranscriberMcpConfig & Required<Config>
  private readonly writes = new Map<string, Promise<void>>()
  private authSession: NotebookLmAuthTerminalSession | undefined

  /**
   * @param ctx - Host context carrying the subprocess provider.
   * @param options - validated config plus optional process seams used by direct tests.
   */
  constructor(ctx: Context, options: TranscriberEngineOptions = {}) {
    super(ctx, 'transcriberEngine')
    this.internals = options
    this.fileConfig = Config(options) as Required<Config>
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
    return runListLectures(request, signal, this.internals, spawn, this.fileConfig)
  }

  /**
   * List the engine workspace modules through the `list_modules` MCP tool.
   * @param signal - cancellation owned by the Remote call.
   * @returns the validated workspace and module inventory.
   */
  @Remote
  listModules(signal: AbortSignal): Promise<TranscriberModuleListing> {
    const spawn = this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec))
    return runListModules(signal, this.internals, spawn, this.fileConfig)
  }

  /**
   * Read the entire workspace library in one engine call.
   * @param request - notebook cache policy.
   * @param signal - caller cancellation.
   * @returns validated inventories with isolated module failures.
   */
  @Remote
  listLibrary(request: TranscriberLibraryRequest, signal: AbortSignal): Promise<TranscriberLibraryListing> {
    return runListLibrary(request, signal, this.editingOptions())
  }

  /**
   * Propose lecture organization without changing definitions.
   * @param request - module and optional proposal refresh.
   * @param signal - caller cancellation.
   * @returns validated agy or automatic grouping and its notes.
   */
  @Remote
  proposeOrganization(request: TranscriberLectureListingRequest, signal: AbortSignal): Promise<TranscriberOrganizationProposal> {
    return runEditingTool({ tool: 'propose_organization', request, input: editingRequests.proposeOrganization,
      output: editingResults.proposeOrganization, timeoutMs: this.fileConfig.organizationTimeoutMs }, signal, this.editingOptions())
  }

  /**
   * Atomically save the organization reviewed by the student.
   * @param request - selected definitions and whether omitted definitions are removed.
   * @param signal - caller cancellation; completed writes cannot be undone by cancellation.
   * @returns all resulting definitions, including retained definitions.
   */
  @Remote
  applyOrganization(request: TranscriberApplyOrganizationRequest, signal: AbortSignal): Promise<TranscriberOrganizationResult> {
    return runEditingTool({ tool: 'apply_organization', request, input: editingRequests.applyOrganization,
      output: editingResults.applyOrganization }, signal, this.editingOptions())
  }

  /**
   * Build the module's exam index through the engine launcher.
   * @param request - module whose question files are indexed.
   * @param signal - caller cancellation.
   * @returns the launcher's text summary after completion; engine failures reject.
   */
  @Remote
  buildExamIndex(request: { readonly module: string }, signal: AbortSignal): Promise<TranscriberExamIndexResult> {
    return runEditingTool({ tool: 'build_exam_index', request, input: editingRequests.buildExamIndex,
      output: editingResults.buildExamIndex, textResult: true,
      timeoutMs: this.fileConfig.examIndexTimeoutMs }, signal, this.editingOptions())
  }

  /**
   * List module files with lecture ownership and notebook presence.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  listModuleFiles(request: TranscriberLectureListingRequest, signal: AbortSignal): Promise<TranscriberModuleFiles> {
    return runEditingTool({ tool: 'list_module_files', request, input: editingRequests.listModuleFiles, output: editingResults.listModuleFiles }, signal, this.editingOptions())
  }

  /**
   * Save the student-selected ordered lecture definition.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  defineLecture(request: TranscriberDefineLectureRequest, signal: AbortSignal): Promise<TranscriberLectureDefinition> {
    return runEditingTool({ tool: 'define_lecture', request, input: editingRequests.defineLecture, output: editingResults.defineLecture }, signal, this.editingOptions())
  }

  /**
   * Remove a manual lecture definition while retaining its files.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  deleteLecture(request: TranscriberDeleteLectureRequest, signal: AbortSignal): Promise<{ readonly deleted: string }> {
    return runEditingTool({ tool: 'delete_lecture', request, input: editingRequests.deleteLecture, output: editingResults.deleteLecture }, signal, this.editingOptions())
  }

  /**
   * Rename one module file and update its lecture references.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  renameFile(request: TranscriberRenameFileRequest, signal: AbortSignal): Promise<{ readonly path: string }> {
    return runEditingTool({ tool: 'rename_file', request, input: editingRequests.renameFile, output: editingResults.renameFile }, signal, this.editingOptions())
  }

  /**
   * Move one module file to engine-owned trash and drop its references.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  removeFile(request: TranscriberModuleFileRequest, signal: AbortSignal): Promise<{ readonly trash_path: string }> {
    return runEditingTool({ tool: 'remove_file', request, input: editingRequests.removeFile, output: editingResults.removeFile }, signal, this.editingOptions())
  }

  /**
   * Upload the student-selected recordings and report per-file readiness.
   * @param request - module and student-selected operation arguments.
   * @param signal - cancellation owned by the Remote call.
   * @returns validated engine result; engine refusals reject with a typed error.
   */
  @Remote
  uploadRecordings(request: TranscriberUploadRecordingsRequest, signal: AbortSignal): Promise<TranscriberUploadRecordingsResult> {
    return runEditingTool({ tool: 'upload_recordings', request, input: editingRequests.uploadRecordings, output: editingResults.uploadRecordings }, signal, this.editingOptions())
  }

  /**
   * Import browser bytes through a temporary Host file removed on every settlement.
   * @param request - module, original file name, kind, and canonical base64 bytes.
   * @param signal - cancellation owned by the Remote call.
   * @returns module-relative destination, kind, and byte size after engine conversion.
   */
  @Remote
  importFile(request: TranscriberImportFileRequest, signal: AbortSignal): Promise<TranscriberImportFileResult> {
    return runImportFile(request, signal, this.editingOptions())
  }

  private editingOptions(): EditingOptions {
    return { internals: this.internals, spawn: this.internals.spawn ?? (spec => this.ctx.subprocess.spawn(spec)), config: this.fileConfig }
  }

  /**
   * Read one UTF-8 file inside the configured transcriber workspace.
   * @param request - workspace path.
   * @param signal - cancellation owned by the Remote call.
   * @returns canonical path, version, and text.
   */
  @Remote
  readFile(request: TranscriberReadFileRequest, signal: AbortSignal): Promise<TranscriberFileText> {
    return runReadFile(request, signal, this.internals, this.fileConfig)
  }

  /**
   * Read one workspace file as base64 bytes, resolving relative image links from another file.
   * @param request - target path and optional workspace-file-relative base path.
   * @param signal - cancellation owned by the Remote call.
   * @returns canonical path, version, and base64 bytes.
   */
  @Remote
  readFileBytes(request: TranscriberReadFileBytesRequest, signal: AbortSignal): Promise<TranscriberFileBytes> {
    return runReadFileBytes(request, signal, this.internals, this.fileConfig)
  }

  /**
   * Atomically replace an existing Markdown transcript after an exact version check.
   * @param request - Markdown path, replacement text, and expected version.
   * @param signal - cancellation owned by the Remote call.
   * @returns canonical path and the new version.
   */
  @Remote
  writeFile(request: TranscriberWriteFileRequest, signal: AbortSignal): Promise<TranscriberFileWriteResult> {
    return runWriteFile(request, signal, this.internals, this.fileConfig, this.writes)
  }

  /**
   * Read one workspace file's current version and byte size for external-change polling.
   * @param request - workspace path.
   * @returns canonical path, version, and byte size.
   */
  @Remote
  stat(request: TranscriberReadFileRequest): Promise<TranscriberFileStat> {
    return runStatFile(request, new AbortController().signal, this.internals)
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
