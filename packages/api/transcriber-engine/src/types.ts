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
  }
}
