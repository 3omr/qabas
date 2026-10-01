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
  readonly install_command: string
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
  readonly title: string
  readonly recording_sources: readonly string[]
  readonly paths: readonly string[]
  readonly parts: number
  readonly transcribed: boolean
  readonly in_notebook_only: boolean
  readonly state?: 'pending' | 'verbatim' | 'draft' | 'final'
  readonly transcript?: string | null
  readonly draft?: string | null
  readonly verbatim?: string | null
}

/** One non-recording file the engine found beside a module's recordings. */
export interface TranscriberMaterialEntry {
  readonly name: string
  readonly path: string
}

/** Request for one module's local and NotebookLM lecture inventory. */
export interface TranscriberLectureListingRequest {
  readonly module: string
}

/** Complete JSON answer from the engine's `list_lectures` MCP tool. */
export interface TranscriberLectureListing {
  readonly module: string
  readonly lectures: readonly TranscriberLectureEntry[]
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

/** One visible frame from the interactive NotebookLM authentication flow. */
export type TranscriberAuthFrame =
  | { readonly type: 'notice'; readonly message: string }
  | { readonly type: 'prompt'; readonly id: string; readonly message: string }
  | { readonly type: 'settled'; readonly outcome: 'authorized' | 'cancelled' | 'failed'; readonly message?: string }

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The configured skill root or launcher script does not exist. */
    'transcriber-engine/not-found': {
      readonly path: string
      readonly setting: 'TRANSCRIBER_SKILL_ROOT' | 'TRANSCRIBER_WORKSPACE'
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
