/** Wire vocabulary returned by the transcriber engine's Remote methods. */

import type {} from '@deepseek-ai/dsh-typert-protocol'

/** One liveness probe result, or `null` when the report only checked presence. */
export interface TranscriberProbeReport {
  readonly ran: boolean
  readonly passed: boolean | null
  readonly failure: string | null
}

/** Python runtime facts included beside the external dependency list. */
export interface TranscriberPythonReport {
  readonly version: string
  readonly minimum_version: string
  readonly supported: boolean
}

/** One external executable or Python package the engine can use. */
export interface TranscriberDependencyReport {
  readonly name: string
  readonly purpose: string
  readonly required: boolean
  readonly resolved: boolean
  readonly path: string | null
  readonly probe: TranscriberProbeReport | null
  readonly failure_hint: string
  readonly install_command: string | null
  readonly installed?: boolean | undefined
  readonly version?: string | null | undefined
  readonly version_error?: string | undefined
  readonly disabled?: boolean | undefined
  readonly model?: string | undefined
  readonly status?: string | undefined
  readonly install_hint?: string | undefined
  readonly install_route: TranscriberInstallRoute
}

/** Route selected by the Host for one dependency's declared install command. */
export type TranscriberInstallRoute = 'user' | 'privileged' | 'manual'

/** Complete JSON answer from `run_transcription.py --doctor-json`. */
export interface TranscriberDoctorReport {
  readonly platform: string
  readonly live: boolean
  readonly python: TranscriberPythonReport
  readonly dependencies: readonly TranscriberDependencyReport[]
  readonly ok: boolean
  readonly exit_code: number
}

/** Requested doctor mode. The engine keeps presence and liveness separate. */
export interface TranscriberDoctorRequest {
  readonly live: boolean
}

/** Request to install one dependency reported by the engine doctor. */
export interface TranscriberInstallRequest {
  readonly name: string
}

/** How the Host can launch one install action. */
export type TranscriberInstallLauncher = 'in-process' | 'pkexec' | 'terminal' | 'copy'

/** Why an app-managed install could not complete. */
export type TranscriberInstallFailureCode =
  | 'unsupported-tool'
  | 'pipx-missing'
  | 'package-manager-missing'
  | 'pkexec-missing'
  | 'terminal-missing'
  | 'process-failed'
  | 'probe-failed'

/** One streamed observation from a dependency installation. */
export type TranscriberInstallFrame =
  | {
    readonly type: 'plan'
    readonly route: TranscriberInstallRoute
    readonly launcher: TranscriberInstallLauncher
    readonly command: string
    readonly prerequisite?: string
    readonly terminal?: string
  }
  | { readonly type: 'output'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
  | {
    readonly type: 'settled'
    readonly outcome: 'installed' | 'failed'
    readonly reason?: TranscriberInstallFailureCode
    readonly exit_code?: number | null
    readonly report?: TranscriberDoctorReport
  }

/** Result of `nlm login --check`; it is separate from engine readiness. */
export interface TranscriberAuthStatus {
  readonly connected: boolean
  readonly reason: 'connected' | 'not-connected' | 'not-installed' | 'unavailable'
}

/** One recording unit returned by the engine's NotebookLM listing. */
export interface TranscriberLectureEntry {
  readonly origin?: 'manual' | 'auto'
  readonly id?: string
  /** Subject id of a defined lecture; absent when it has none. */
  readonly subject?: string
  readonly materials?: readonly string[]
  readonly title: string
  readonly recording_sources: readonly string[]
  readonly paths: readonly string[]
  readonly parts: number
  readonly transcribed: boolean
  readonly in_notebook_only: boolean
  readonly in_notebook?: boolean | null
  readonly state?: 'pending' | 'verbatim' | 'draft' | 'final'
  readonly transcript?: string | null
  /** The finished transcript's own title, when it names the lecture differently. */
  readonly transcript_title?: string | null
  readonly draft?: string | null
  readonly verbatim?: string | null
  /** Every recording's verbatim file, in part order (boys and girls recordings each have one). */
  readonly verbatims?: readonly string[]
}

/** One non-recording file the engine found beside a module's recordings. */
export interface TranscriberMaterialEntry {
  readonly name: string
  readonly path: string
}

/** Request for one module's local and NotebookLM lecture inventory. */
export interface TranscriberLectureListingRequest {
  readonly module: string
  readonly refresh?: boolean
}

/** Complete JSON answer from the engine's `list_lectures` MCP tool. */
export interface TranscriberLectureListing {
  /** Published coverage and current-original counts; legacy extractor age is independent of SHA matches. */
  readonly question_index?: { readonly state: 'built' | 'missing' | 'stale' | 'partial' | 'legacy'; readonly files: number; readonly indexed?: number | undefined; readonly failed?: number | undefined; readonly pending?: number | undefined }

  /** Module-wide sources, relative to Lecture/, when supported by the engine. */
  readonly general_materials?: readonly string[] | undefined
  readonly remote_as_of?: string | null | undefined
  readonly questions?: 'indexed' | 'missing' | 'needs-conversion'
  readonly module: string
  readonly lectures: readonly TranscriberLectureEntry[]
  /** Ordered subjects; absent or empty when the module has none. */
  readonly subjects?: readonly TranscriberSubject[] | undefined
  readonly materials: readonly TranscriberMaterialEntry[]
  readonly warning?: string
}

/** One module returned by the engine's `list_modules` MCP tool. */
export interface TranscriberModuleEntry {
  readonly module: string
  readonly display_name: string
  readonly notebooks: readonly string[]
  readonly root: string
}

/** Complete JSON answer from the engine's `list_modules` MCP tool. */
export interface TranscriberModuleListing {
  readonly workspace: string
  readonly modules: readonly TranscriberModuleEntry[]
}

/** Request for one workspace text file. */
export interface TranscriberReadFileRequest {
  readonly path: string
}

/** Remote notebook inventory policy for a whole-library read. */
export interface TranscriberLibraryRequest {
  readonly remote?: 'cached' | 'refresh' | 'skip'
}

/** Library module metadata with either its complete inventory or an isolated failure. */
export type TranscriberLibraryModule = TranscriberModuleEntry & (
  | (TranscriberLectureListing & { readonly exam_index: 'built' | 'missing' | 'stale' | 'partial' | 'legacy'; readonly question_files: number; readonly question_index_counts?: { readonly indexed: number; readonly failed: number; readonly pending: number } })
  | { readonly error: string; readonly general_materials?: readonly string[] | undefined }
)

/** Complete workspace inventory from one `list_library` call. */
export interface TranscriberLibraryListing {
  readonly workspace: string
  readonly modules: readonly TranscriberLibraryModule[]
}

/** One read-only lecture grouping proposed by the engine. */
export interface TranscriberProposedLecture {
  readonly title: string
  readonly recordings: readonly string[]
  readonly materials: readonly string[]
  readonly existing_id?: string | undefined
  readonly change: 'new' | 'same' | 'changed'
}

/** Validated organization proposal; unassigned paths remain explicit. */
export interface TranscriberOrganizationProposal {
  /** Proposed module-wide sources, relative to Lecture/. */
  readonly general?: readonly string[] | undefined
  readonly source: 'agy' | 'automatic'
  readonly lectures: readonly TranscriberProposedLecture[]
  readonly unassigned: { readonly recordings: readonly string[]; readonly materials: readonly string[] }
  readonly notes: readonly string[]
}

/** Student-reviewed definitions to save atomically. */
export interface TranscriberApplyOrganizationRequest {
  /** Optional module-wide sources to save, relative to Lecture/. */
  readonly general?: readonly string[] | undefined
  readonly module: string
  readonly lectures: readonly {
    readonly title: string
    readonly recordings: readonly string[]
    readonly materials: readonly string[]
    readonly id?: string
  }[]
  readonly replaceExisting: boolean
}

/** All resulting definitions, including retained definitions. */
export interface TranscriberOrganizationResult {
  readonly module: string
  readonly lectures: readonly TranscriberLectureDefinition[]
}

/** Launcher summary returned after the exam index is written. */
export interface TranscriberExamIndexResult {
  readonly output: string
  /** Terminal paper outcome; partial retains extracted questions from failed papers. */
  readonly status?: 'done' | 'partial' | 'stopped' | undefined
  readonly failed_papers?: number | undefined
  readonly interruption?: TranscriberInterruption | undefined
}

/** Validated MCP checkpoint; optional paper phases preserve older engine responses. */
export interface TranscriberExamProgress {
  readonly done: number
  readonly total: number
  readonly message: string
  readonly paper?: string
  readonly phase?: 'queued' | 'reading' | 'extracting' | 'reviewing' | 'done' | 'failed'
  readonly questions?: number
  readonly part?: number
  readonly parts?: number
  readonly split?: readonly number[]
  /** Why a `failed` paper failed: its file could not be read, the model run did not complete, or agy is signed out. */
  readonly cause?: TranscriberExamFailureCause
}

/** Whether a paper's indexing failed reading its file, in the model run, or because agy is signed out. */
export type TranscriberExamFailureCause = 'source' | 'model' | 'auth'

/** Live indexing checkpoints followed by the existing completion summary. */
export type TranscriberExamIndexFrame =
  | { readonly type: 'progress'; readonly progress: TranscriberExamProgress }
  | { readonly type: 'outcome'; readonly outcome: TranscriberExamIndexResult }

/** Retained engine path and optional identity accepted by restoreTrash. */
export interface TranscriberFileRemoval {
  readonly trash_path: string
  readonly id?: string | undefined
}

/** One simple original source position retained for an extracted question. */
export type TranscriberExamQuestionLocatorPart =
  | { readonly type: 'page'; readonly page: number }
  | { readonly type: 'line'; readonly line: number }
  | { readonly type: 'spreadsheet_row'; readonly sheet: string; readonly row: number; readonly range: string }
  | { readonly type: 'paragraph'; readonly paragraph: number }
  | { readonly type: 'table_row'; readonly table: number; readonly row: number }

/** One or more source positions for a question split across document blocks. */
export type TranscriberExamQuestionLocator = TranscriberExamQuestionLocatorPart
  | { readonly type: 'multiple'; readonly items: readonly TranscriberExamQuestionLocatorPart[] }

/** One question occurrence extracted from the selected original exam file. */
export interface TranscriberExamQuestion {
  readonly id: string
  readonly number: number | null
  readonly kind: 'mcq' | 'written'
  readonly stem: string
  readonly options: Readonly<Record<string, string>>
  readonly answer: string | null
  /** Source-backed answer, absent key, unresolved evidence, or a legacy unverifiable claim. */
  readonly answer_status?: 'printed' | 'no_key' | 'uncertain' | 'unverified' | undefined
  readonly source_answer: string | null
  /** Explanation printed with this question, or an empty string when none is printed. */
  readonly explanation: string
  readonly section: string
  readonly year: number | null
  readonly topic: string | null
  readonly locator: TranscriberExamQuestionLocator | null
  readonly needs_review: boolean
  readonly review_reason: string | null
}

/** A stable page from the extracted questions for one original exam file. */
export interface TranscriberExamQuestionsPage {
  readonly module: string
  readonly path: string
  readonly sha256: string
  readonly query: string
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly questions: readonly TranscriberExamQuestion[]
  readonly next_offset: number | null
}

/** One page request for an exam file's extracted question occurrences. */
export interface TranscriberExamQuestionsRequest {
  readonly module: string
  readonly path: string
  readonly offset?: number
  readonly limit?: number
  readonly query?: string
}

/** Owner-selected paper year, `'bank'` for an undated question bank, or null to clear the durable choice. */
export interface TranscriberSetExamYearRequest {
  readonly module: string
  readonly path: string
  readonly year: number | 'bank' | null
}

/** Effective year after saving or clearing a paper override without extraction. */
export interface TranscriberExamYear {
  readonly module: string
  readonly path: string
  readonly year: number | null
  readonly year_source: 'owner' | 'paper' | 'filename' | null
}

/** Request for one workspace binary file, optionally relative to another file. */
export interface TranscriberReadFileBytesRequest {
  readonly path: string
  readonly relativeTo?: string
}

/** UTF-8 text file returned by the session-free workspace Remote. */
export interface TranscriberFileText {
  readonly absolutePath: string
  readonly version: string
  readonly text: string
}

/** Acknowledgement returned after an atomic Markdown replacement. */
export interface TranscriberFileWriteResult {
  readonly absolutePath: string
  readonly version: string
}

/** Binary file returned as canonical base64 on the JSON Remote wire. */
export interface TranscriberFileBytes {
  readonly absolutePath: string
  readonly version: string
  readonly bytes: string
}

/** Request to replace an existing Markdown transcript after an observed version. */
export interface TranscriberWriteFileRequest {
  readonly path: string
  readonly text: string
  readonly expectedVersion: string
}

/** File metadata returned without file content. */
export interface TranscriberFileStat {
  readonly absolutePath: string
  readonly version: string
  readonly bytes: number
}

/** Resolved listing-process capture and termination limits. */
export interface TranscriberMcpConfig {
  readonly mcpOutputMaxBytes: number
  readonly mcpGraceMs: number
}

/** Resolved byte caps used by session-free workspace file operations. */
export interface TranscriberFileConfig {
  readonly maxTextBytes: number
  readonly maxImageBytes: number
}

/** The two engine-owned folders that can receive dropped source files. */
export type TranscriberImportDestination = 'Lecture' | 'Questions'

/** Request to copy external files into one module folder. */
export interface TranscriberImportRequest {
  readonly module: string
  readonly destination: TranscriberImportDestination
  readonly paths: readonly string[]
}

/** One file copied by an import operation. */
export interface TranscriberImportedFile {
  readonly source: string
  readonly destination: string
}

/** Why one dropped file was not copied. */
export type TranscriberImportRejectionCode =
  | 'source-not-absolute'
  | 'unsupported-extension'
  | 'source-not-found'
  | 'source-not-file'
  | 'source-unreadable'
  | 'name-collision'
  | 'copy-failed'

/** One file rejected while the rest of a drop continues. */
export interface TranscriberRejectedFile {
  readonly source: string
  readonly name: string
  readonly reason: TranscriberImportRejectionCode
  readonly detail?: string
}

/** Complete result of one copy operation, including mixed accepted/rejected drops. */
export interface TranscriberImportReport {
  readonly module: string
  readonly destination: TranscriberImportDestination
  readonly filed: readonly TranscriberImportedFile[]
  readonly rejected: readonly TranscriberRejectedFile[]
}

/** File categories accepted by the engine registry. */
export type TranscriberModuleFileKind = 'recording' | 'material' | 'question'

/** Module-relative file inventory, including shared lecture ownership. */
export interface TranscriberModuleFile {
  /** Effective paper year, including the durable owner override. */
  readonly year?: number | null | undefined
  /** Authority for the effective paper year. */
  readonly year_source?: 'owner' | 'paper' | 'filename' | null | undefined
  /** Automatic paper review outcome; a failed review can be retried independently. */
  readonly review_status?: 'done' | 'failed' | 'pending' | null | undefined
  /** SHA-256 of an original exam file for identical-upload detection. */
  readonly sha256?: string | undefined
  /** A published source matches this original SHA-256, regardless of other papers. */
  readonly indexed?: boolean | undefined
  /** Questions from a legacy source without a recorded SHA remain readable. */
  readonly index_legacy?: boolean | undefined
  /** Whether the published failure belongs to this original SHA-256. */
  readonly index_failed?: boolean | undefined
  /** Diagnostic from the matching published indexing failure. */
  readonly index_error?: string | undefined
  /** Cause of the matching published failure; absent for failures recorded before causes existed. */
  readonly index_failure_cause?: TranscriberExamFailureCause | undefined
  /** Saved questions in a matching indexed or readable legacy source. */
  readonly question_count?: number | undefined
  /** Extracted questions with a genuine source defect. */
  readonly question_review_count?: number | undefined
  /** Paper-level provenance notes, excluded from question review counts. */
  readonly review_reasons?: readonly string[] | undefined
  /** Readiness of locally extracted exam text. */
  readonly preparation?: 'pending' | 'ready' | 'failed' | undefined
  /** Diagnostic from the last failed exam preparation. */
  readonly preparation_error?: string | undefined

  /** Hidden recordings are retained for restore and are not unassigned sources. */
  readonly hidden?: boolean | undefined
  /** Whether this file is selected as a module-wide source. */
  readonly general?: boolean | undefined
  readonly path: string
  readonly name: string
  readonly size_bytes: number
  readonly kind: TranscriberModuleFileKind
  readonly lectures: readonly { readonly id: string | null; readonly title: string; readonly origin: 'manual' | 'auto' }[]
  readonly in_notebook: boolean | null
}

/** Answer from `list_module_files`; notebook failures preserve local files. */
export interface TranscriberModuleFiles {
  readonly remote_as_of?: string | null | undefined
  readonly module: string
  readonly files: readonly TranscriberModuleFile[]
  readonly warning?: string | undefined
}

/** Student-selected ordered recordings and materials, relative to Lecture/. */
export interface TranscriberDefineLectureRequest {
  readonly module: string
  readonly title: string
  readonly recordings: readonly string[]
  readonly materials: readonly string[]
  readonly id?: string | undefined
  /** Subject id; null removes the lecture from its subject; omitted keeps the current one. */
  readonly subject?: string | null | undefined
}

/** One subject (مادة) inside a module. */
export interface TranscriberSubject {
  readonly id: string
  readonly title: string
}

/** Saved subject with its timestamps. */
export interface TranscriberSubjectRecord extends TranscriberSubject {
  readonly created: string
  readonly updated: string
}

/** Add a subject to a module. */
export interface TranscriberCreateSubjectRequest {
  readonly module: string
  readonly title: string
}

/** Rename one subject. */
export interface TranscriberRenameSubjectRequest {
  readonly module: string
  readonly id: string
  readonly title: string
}

/** Set the order of every subject in a module. */
export interface TranscriberReorderSubjectsRequest {
  readonly module: string
  readonly ids: readonly string[]
}

/** Delete one subject; its lectures are kept without a subject. */
export interface TranscriberDeleteSubjectRequest {
  readonly module: string
  readonly id: string
}

/** Put a defined lecture in a subject, or null to remove it from its subject. */
export interface TranscriberSetLectureSubjectRequest {
  readonly module: string
  readonly id: string
  readonly subject: string | null
}

/** Subjects and lecture assignments after a subject operation; `id` names a created subject. */
export interface TranscriberSubjects {
  readonly module: string
  readonly id?: string | undefined
  readonly subjects: readonly TranscriberSubjectRecord[]
  readonly lectures: readonly { readonly id: string; readonly subject?: string | null | undefined }[]
}

/** Module-wide source selection; paths are relative to the module's Lecture/ directory. */
export interface TranscriberSetGeneralMaterialsRequest {
  readonly module: string
  readonly materials: readonly string[]
}

/** Saved module-wide source selection returned by the engine. */
export interface TranscriberGeneralMaterials {
  readonly module: string
  readonly general_materials: readonly string[]
}

/** Saved manual lecture definition. */
export interface TranscriberLectureDefinition {
  readonly id: string
  readonly title: string
  readonly recordings: readonly string[]
  readonly materials: readonly string[]
  readonly created: string
  readonly updated: string
  readonly subject?: string | undefined
}

/** Delete only the identified manual definition. */
export interface TranscriberDeleteLectureRequest {
  readonly module: string
  readonly id: string
}

/** Hide a recording-backed lecture by title, or a manual id when titles are ambiguous. */
export interface TranscriberHideLectureRequest {
  readonly module: string
  readonly title: string
}

/** Restore safe recording names relative to Lecture/. */
export interface TranscriberRestoreRecordingsRequest {
  readonly module: string
  readonly recordings: readonly string[]
}

/** Recording names hidden or restored by an atomic registry operation. */
export interface TranscriberRecordingVisibility {
  readonly module: string
  readonly recordings: readonly string[]
}

/** Selected browser bytes, encoded as canonical base64 for the unary JSON transport. */
export interface TranscriberImportFileRequest {
  readonly module: string
  readonly name: string
  readonly kind: TranscriberModuleFileKind
  readonly bytes: string
  readonly replace?: boolean | undefined
}

/** Imported file; path is normalized to be module-relative by the Host. */
export interface TranscriberImportFileResult {
  readonly path: string
  readonly kind: TranscriberModuleFileKind
  readonly size_bytes: number
}

/** Build a module's question bank, optionally retrying only some failed papers. */
export interface TranscriberExamIndexRequest {
  readonly module: string
  /**
   * Failed file names under `Questions/` to retry. Other papers whose published failure matches
   * their current file keep it without a new attempt; new and changed papers are still read.
   * Absent retries every failed paper.
   */
  readonly papers?: readonly string[]
}

/** Module-relative file selected by the student. */
export interface TranscriberModuleFileRequest {
  readonly module: string
  readonly path: string
}

/** Rename a file in its current directory. */
export interface TranscriberRenameFileRequest extends TranscriberModuleFileRequest {
  readonly new_name: string
}

/** Upload only the selected module-relative recordings. */
export interface TranscriberUploadRecordingsRequest {
  readonly module: string
  readonly files: readonly string[]
}

/** NotebookLM readiness for one selected recording. */
export interface TranscriberRecordingUpload {
  readonly path: string
  readonly name: string
  readonly size_bytes: number
  readonly size_mb: number
  readonly status: 'uploaded' | 'already-uploaded' | 'processing' | 'not-ready'
  readonly ready?: boolean | undefined
  readonly source_id?: string | undefined
  readonly message?: string | undefined
  readonly error?: string | undefined
}

/** Per-file results; processing does not imply that recordings are ready. */
export interface TranscriberUploadRecordingsResult {
  readonly module: string
  readonly notebook: { readonly id: string; readonly title: string }
  readonly status: 'ready' | 'processing'
  readonly files: readonly TranscriberRecordingUpload[]
  readonly next: string
}

/** One visible frame from the interactive NotebookLM authentication flow. */
export type TranscriberAuthFrame =
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'external-console'; readonly diagnostics: string | null }
  | { readonly type: 'prompt'; readonly id: string; readonly message: string }
  | { readonly type: 'settled'; readonly outcome: 'authorized' | 'cancelled' | 'failed'; readonly message?: string; readonly diagnostics?: string }

/** Selected library directory and its live local module count. */
export interface TranscriberWorkspace {
  readonly path: string
  readonly source: 'env' | 'default'
  readonly exists: boolean
  readonly modules: number
}

/** Confirmed student request to create a module and its NotebookLM notebook. */
export interface TranscriberCreateModuleRequest {
  readonly module: string
  readonly displayName: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Host filesystem could not inspect or persist the selected workspace. */
    'transcriber-engine/workspace-unavailable': { readonly detail: string }
    /** An engine MCP operation exceeded its configured deadline. */
    'transcriber-engine/tool-timeout': { readonly tool: string; readonly timeoutMs: number }
    /** An engine registry operation refused the requested edit. */
    'transcriber-engine/edit-rejected': { readonly tool: string; readonly detail: string }
    /** An engine registry operation emitted an invalid result. */
    'transcriber-engine/invalid-edit-result': { readonly tool: string; readonly detail: string }
    /** Host staging or module resolution failed before an edit completed. */
    'transcriber-engine/edit-unavailable': { readonly detail: string }

    /** The configured skill root or launcher script does not exist. */
    'transcriber-engine/not-found': {
      readonly path: string
      readonly setting: 'TRANSCRIBER_ENGINE_ROOT' | 'TRANSCRIBER_SKILL_ROOT' | 'TRANSCRIBER_WORKSPACE'
    }
    /** The configured engine process could not be started or settled. */
    'transcriber-engine/unavailable': {
      readonly command: string
      readonly detail: string
    }
    /** The engine ran but did not emit the documented JSON report. */
    'transcriber-engine/invalid-report': {
      readonly detail: string
    }
    /** The engine MCP server did not return the documented lecture listing. */
    'transcriber-engine/invalid-listing': {
      readonly detail: string
    }
    /** The engine MCP server did not return the documented module listing. */
    'transcriber-engine/invalid-modules': {
      readonly detail: string
    }
    /** The import request could not be resolved to a module-local destination. */
    'transcriber-engine/import-invalid': {
      readonly detail: string
    }
    /** A requested workspace path is outside the resolved transcriber workspace. */
    'transcriber-engine/path-outside-workspace': {
      readonly path: string
    }
    /** A requested workspace file does not exist. */
    'transcriber-engine/file-not-found': {
      readonly path: string
    }
    /** A requested workspace path is not a regular file. */
    'transcriber-engine/file-not-regular': {
      readonly path: string
    }
    /** A complete file operation would exceed a configured byte cap. */
    'transcriber-engine/file-too-large': {
      readonly path: string
      readonly limit: number
      readonly bytes: number
    }
    /** A requested text file is not valid UTF-8. */
    'transcriber-engine/file-not-utf8': {
      readonly path: string
    }
    /** A write target is not an existing Markdown file. */
    'transcriber-engine/file-not-markdown': {
      readonly path: string
    }
    /** A write observed a different current version than the caller supplied. */
    'transcriber-engine/file-conflict': {
      readonly path: string
      readonly expectedVersion: string
      readonly actualVersion: string
    }
    /** The Host filesystem could not complete a workspace file operation. */
    'transcriber-engine/file-unavailable': {
      readonly path: string
      readonly operation: 'read' | 'read-bytes' | 'stat' | 'write'
    }
    /** The desktop PTY could not start or is unavailable for `nlm login`. */
    'transcriber-engine/auth-unavailable': {
      readonly command: 'nlm login'
      readonly detail: string
    }
    /** A second NotebookLM authentication attempt was requested while one runs. */
    'transcriber-engine/auth-in-progress': Record<never, never>
  }
}

/** Transcript stages independently removable and restorable. */
export type TranscriberTranscriptKind = 'final' | 'draft' | 'verbatim'

/** Selected lecture outputs; recordings and its definition remain unchanged. */
export interface TranscriberRemoveTranscriptRequest {
  readonly module: string
  readonly lecture: string
  readonly kinds: readonly TranscriberTranscriptKind[]
}

/** Existing module to remove or inspect without a Session. */
export interface TranscriberModuleRequest { readonly module: string }

/** Stable removed-module entry under the library's module trash. */
export interface TranscriberRemovedModule {
  readonly trash_id: string
  readonly module: string
  readonly display_name: string
  readonly removed_at: string
}

/** Whole-module rename result; NotebookLM remains untouched. */
export interface TranscriberRemovedModuleResult {
  readonly module: string
  readonly trash_id: string
  readonly notebook_untouched: boolean
}

/** Removed module selected for restoration. */
export interface TranscriberRestoreModuleRequest { readonly trashId: string }

/** Restored module id; NotebookLM remains untouched. */
export interface TranscriberRestoredModule {
  readonly module: string
  readonly notebook_untouched: boolean
}

/** Restorable module-local removal, including hidden lecture recordings. */
export interface TranscriberTrashEntry {
  readonly id: string
  readonly removed_at: string
  readonly kind: 'file' | 'transcript' | 'lecture'
  readonly label: string
  readonly paths: readonly string[]
}

/** Existing module and trash entry selected for restoration. */
export interface TranscriberRestoreTrashRequest {
  readonly module: string
  readonly id: string
}

/** Files or visibility paths removed/restored as one entry. */
export interface TranscriberTrashResult {
  readonly module: string
  readonly id: string
  readonly paths: readonly string[]
}

/** Workspace-owned preferences; disabling external images prevents lookup and verification calls. */
export interface TranscriberEngineSettings {
  /** Whether guide gaps can request openly licensed external illustrations. */
  readonly web_figures: boolean
}

/** Student-authorized execution of one lecture, independent of chat. */
export interface TranscriberPipelineRequest {
  readonly module: string
  readonly lecture: string
  readonly mode: 'transcribe' | 'redo' | 'continue'
  /** Explicit recovery of retained content through engine validation and finalization. */
  readonly salvage?: boolean | undefined
  /** Retained manifest for resuming the lecture, validated by the engine. */
  readonly resume_manifest?: string | undefined
  /** Absolute effort deadline in epoch milliseconds for this recovery request. */
  readonly deadline?: number | undefined
}

/** Provider interruption with a reported UTC reset and the original diagnostic. */
export interface TranscriberInterruption {
  readonly kind: 'network' | 'quota' | 'auth' | 'missing-recording'
  readonly reason: string
  readonly reset_at?: string | null | undefined
  readonly raw_diagnostic?: string | undefined
}

/** Engine outcomes: validated publication, resumable interruption, or failed content recovery. */
export type TranscriberPipelineOutcome =
  | { readonly status: 'failed'; readonly step: string; readonly reason: string; readonly findings: string; readonly salvage_error: string; readonly resume?: { readonly module: string; readonly manifest_path: string } | undefined }
  | { readonly status: 'finalized'; readonly paths: { readonly transcript: string; readonly index: string }; readonly summary: string; readonly note?: string | undefined }
  | { readonly status: 'stopped'; readonly step: string; readonly kind: 'network' | 'quota' | 'auth' | 'missing-recording'; readonly reason: string; readonly raw_diagnostic?: string | undefined; readonly reset_at?: string | undefined; readonly resume?: { readonly module: string; readonly manifest_path: string } | undefined }

/** Live progress with a tool-name step and `<step>:` message prefix, then one outcome; no draft bytes. */
export type TranscriberPipelineFrame =
  | { readonly type: 'progress'; readonly step: string; readonly done: number; readonly total: number; readonly message: string }
  | { readonly type: 'outcome'; readonly outcome: TranscriberPipelineOutcome }

/** Per-paper preparation; missing reading tools report installer identifiers for automatic recovery. */
export interface TranscriberExamPreparation {
  readonly path: string
  readonly status: 'ready' | 'failed'
  readonly message?: string | undefined
  readonly code?: 'ocr_tool_missing' | undefined
  readonly tools?: readonly string[] | undefined
}
