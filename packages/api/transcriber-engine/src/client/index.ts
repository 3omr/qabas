/** Client provider for the engine-facing transcriber capability. */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  TranscriberLibraryRequest, TranscriberLibraryListing, TranscriberOrganizationProposal, TranscriberApplyOrganizationRequest,
  TranscriberOrganizationResult, TranscriberExamIndexResult,
  TranscriberModuleFiles, TranscriberDefineLectureRequest, TranscriberLectureDefinition, TranscriberDeleteLectureRequest,
  TranscriberRenameFileRequest, TranscriberModuleFileRequest, TranscriberUploadRecordingsRequest, TranscriberUploadRecordingsResult,
  TranscriberImportFileRequest, TranscriberImportFileResult,
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
   * Read all library inventories in one engine call.
   * @param request - notebook cache policy.
   * @param signal - optional cancellation.
   * @returns workspace library or typed failure.
   */
  listLibrary(request: TranscriberLibraryRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberLibraryListing>>
  /**
   * Propose lecture organization through agy or automatic grouping.
   * @param request - module and optional refresh.
   * @param signal - optional cancellation.
   * @returns proposal or typed failure.
   */
  proposeOrganization(
    request: TranscriberLectureListingRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<TranscriberOrganizationProposal>>
  /**
   * Save student-reviewed definitions atomically.
   * @param request - definitions and replacement policy.
   * @param signal - optional cancellation.
   * @returns resulting definitions or typed failure.
   */
  applyOrganization(
    request: TranscriberApplyOrganizationRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<TranscriberOrganizationResult>>
  /**
   * Build the local exam index and wait for completion.
   * @param request - selected module.
   * @param signal - optional cancellation.
   * @returns launcher summary or typed failure.
   */
  buildExamIndex(request: { readonly module: string }, signal?: AbortSignal): Promise<RemoteResult<TranscriberExamIndexResult>>
  /**
   * List module files with lecture ownership and notebook presence.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  listModuleFiles(request: TranscriberLectureListingRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberModuleFiles>>
  /**
   * Save the student-selected ordered lecture definition.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  defineLecture(request: TranscriberDefineLectureRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberLectureDefinition>>
  /**
   * Remove a manual lecture definition while retaining its files.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  deleteLecture(request: TranscriberDeleteLectureRequest, signal?: AbortSignal): Promise<RemoteResult<{ readonly deleted: string }>>
  /**
   * Rename one module file and update its lecture references.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  renameFile(request: TranscriberRenameFileRequest, signal?: AbortSignal): Promise<RemoteResult<{ readonly path: string }>>
  /**
   * Move one module file to engine-owned trash and drop its references.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  removeFile(request: TranscriberModuleFileRequest, signal?: AbortSignal): Promise<RemoteResult<{ readonly trash_path: string }>>
  /**
   * Upload the student-selected recordings and report per-file readiness.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  uploadRecordings(
    request: TranscriberUploadRecordingsRequest, signal?: AbortSignal,
  ): Promise<RemoteResult<TranscriberUploadRecordingsResult>>
  /**
   * Import browser bytes using temporary Host staging.
   * @param request - module and student-selected operation arguments.
   * @param signal - optional call cancellation.
   * @returns validated engine result or typed Remote failure.
   */
  importFile(request: TranscriberImportFileRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberImportFileResult>>
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
    listLibrary: (request, signal) => remote.transcriberEngine.listLibrary(request, signal),
    proposeOrganization: (request, signal) => remote.transcriberEngine.proposeOrganization(request, signal),
    applyOrganization: (request, signal) => remote.transcriberEngine.applyOrganization(request, signal),
    buildExamIndex: (request, signal) => remote.transcriberEngine.buildExamIndex(request, signal),
    listModules: signal => remote.transcriberEngine.listModules(signal),
    listModuleFiles: (request, signal) => remote.transcriberEngine.listModuleFiles(request, signal),
    defineLecture: (request, signal) => remote.transcriberEngine.defineLecture(request, signal),
    deleteLecture: (request, signal) => remote.transcriberEngine.deleteLecture(request, signal),
    importFile: (request, signal) => remote.transcriberEngine.importFile(request, signal),
    renameFile: (request, signal) => remote.transcriberEngine.renameFile(request, signal),
    removeFile: (request, signal) => remote.transcriberEngine.removeFile(request, signal),
    uploadRecordings: (request, signal) => remote.transcriberEngine.uploadRecordings(request, signal),

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
