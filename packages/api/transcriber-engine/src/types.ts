/** Wire vocabulary returned by the transcriber engine's dependency doctor. */

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
  }
}
