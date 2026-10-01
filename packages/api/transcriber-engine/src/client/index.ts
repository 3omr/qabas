/** Client provider for the engine-facing transcriber capability. */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TranscriberAuthFrame, TranscriberAuthStatus, TranscriberDoctorReport, TranscriberDoctorRequest,
  TranscriberFileBytes, TranscriberFileStat, TranscriberFileText, TranscriberFileWriteResult,
  TranscriberImportReport, TranscriberImportRequest, TranscriberInstallFrame, TranscriberInstallRequest,
  TranscriberLectureListing, TranscriberLectureListingRequest, TranscriberModuleListing,
  TranscriberReadFileBytesRequest, TranscriberReadFileRequest, TranscriberWriteFileRequest,
} from '../types.ts'
import type {} from '@deepseek-ai/dsh-api-transcriber-engine/remote'

/** Browser-facing methods supplied by this package's Client provider. */
export interface TranscriberEngineClient {
  /**
   * Run the engine's presence or liveness doctor through the Host Remote.
   * @param request - whether to run live probes.
   * @param signal - optional call cancellation.
   * @returns the doctor report or a typed Remote failure.
   */
  doctor(request: TranscriberDoctorRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberDoctorReport>>
  /**
   * Stream one dependency installation and its fresh presence report.
   * @param request - dependency name from the doctor report.
   * @param signal - optional stream cancellation.
   * @returns installation frames through settlement.
   */
  installDependency(request: TranscriberInstallRequest, signal?: AbortSignal): AsyncIterable<TranscriberInstallFrame>
  /**
   * Check `nlm login --check`, independently of `nlm notebook list`.
   * @param signal - optional call cancellation.
   * @returns connection status or a typed Remote failure.
   */
  authStatus(signal?: AbortSignal): Promise<RemoteResult<TranscriberAuthStatus>>
  /**
   * Read local and NotebookLM lectures for one module through the Host Remote.
   * @param request - module id to list.
   * @param signal - optional cancellation signal.
   * @returns the listing or a typed Remote failure.
   */
  listLectures(
    request: TranscriberLectureListingRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<TranscriberLectureListing>>
  /**
   * List the session-free transcriber workspace modules.
   * @param signal - optional cancellation signal.
   * @returns the validated module inventory or a typed Remote failure.
   */
  listModules(signal?: AbortSignal): Promise<RemoteResult<TranscriberModuleListing>>
  /**
   * Read one UTF-8 file inside the transcriber workspace.
   * @param request - workspace path.
   * @param signal - optional cancellation signal.
   * @returns canonical path, version, and text or a typed Remote failure.
   */
  readFile(request: TranscriberReadFileRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberFileText>>
  /**
   * Read one workspace file as base64 bytes.
   * @param request - target path and optional workspace-file-relative base path.
   * @param signal - optional cancellation signal.
   * @returns canonical path, version, and bytes or a typed Remote failure.
   */
  readFileBytes(request: TranscriberReadFileBytesRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberFileBytes>>
  /**
   * Atomically replace one existing Markdown transcript after a version check.
   * @param request - Markdown path, replacement text, and expected version.
   * @param signal - optional cancellation signal.
   * @returns canonical path and new version or a typed Remote failure.
   */
  writeFile(request: TranscriberWriteFileRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberFileWriteResult>>
  /**
   * Read one workspace file's current version and byte size.
   * @param request - workspace path.
   * @returns canonical path, version, and size or a typed Remote failure.
   */
  stat(request: TranscriberReadFileRequest): Promise<RemoteResult<TranscriberFileStat>>
  /**
   * Copy dropped files into one module folder and return mixed success/rejection data.
   * @param request - module, destination folder, and absolute source paths.
   * @param signal - optional cancellation signal.
   * @returns copied files and per-file rejections.
   */
  importFiles(
    request: TranscriberImportRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<TranscriberImportReport>>
  /**
   * Stream the native NotebookLM login conversation.
   * @param signal - optional cancellation signal owned by the page.
   * @returns frames until the login is authorized, cancelled, or failed.
   */
  auth(signal?: AbortSignal): AsyncIterable<TranscriberAuthFrame>
  /**
   * Send one line to the running NotebookLM login.
   * @param line - user-entered response without an implicit newline.
   * @returns a typed Remote result after the Host accepts or rejects the line.
   */
  answerAuth(line: string): Promise<RemoteResult<void>>
  /**
   * Cancel the running NotebookLM login.
   * @returns a typed Remote result after the Host requests termination.
   */
  cancelAuth(): Promise<RemoteResult<void>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client provider for the transcriber engine capability. */
    transcriberEngine: TranscriberEngineClient
  }
}

/** Required Client services: the Gateway Remote carrier and its namespace. */
export const inject = ['remote', 'remote.transcriberEngine']

/** Install the app-facing provider over the generated Remote namespace. */
export function apply(ctx: Context): void {
  const remote = ctx.get('remote') as ClientRemote
  ctx.provide('transcriberEngine', {
    doctor: (request, signal) => remote.transcriberEngine.doctor(request, signal),
    installDependency: (request, signal) => remote.transcriberEngine.installDependency(request, signal),
    authStatus: signal => remote.transcriberEngine.authStatus(signal),
    listLectures: (request, signal) => remote.transcriberEngine.listLectures(request, signal),
    listModules: signal => remote.transcriberEngine.listModules(signal),
    readFile: (request, signal) => remote.transcriberEngine.readFile(request, signal),
    readFileBytes: (request, signal) => remote.transcriberEngine.readFileBytes(request, signal),
    writeFile: (request, signal) => remote.transcriberEngine.writeFile(request, signal),
    stat: request => remote.transcriberEngine.stat(request),
    importFiles: (request, signal) => remote.transcriberEngine.importFiles(request, signal),
    auth: signal => remote.transcriberEngine.auth(signal),
    answerAuth: line => remote.transcriberEngine.answerAuth(line),
    cancelAuth: () => remote.transcriberEngine.cancelAuth(),
  } satisfies TranscriberEngineClient)
}
