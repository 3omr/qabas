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
}

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

/** One recording unit returned by the engine's NotebookLM listing. */
export interface TranscriberLectureEntry {
  readonly title: string
  readonly recording_sources: readonly string[]
  readonly paths: readonly string[]
  readonly parts: number
  readonly transcribed: boolean
  readonly in_notebook_only: boolean
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
    /** The import request could not be resolved to a module-local destination. */
    'transcriber-engine/import-invalid': {
      readonly detail: string
    }
    /** The native PTY could not start or be reached for `nlm auth`. */
    'transcriber-engine/auth-unavailable': {
      readonly command: 'nlm auth'
      readonly detail: string
    }
    /** A second NotebookLM authentication attempt was requested while one runs. */
    'transcriber-engine/auth-in-progress': Record<never, never>
  }
}
