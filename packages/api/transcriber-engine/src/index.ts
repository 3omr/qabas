/** Host Remote owner for the transcriber engine's readiness and future operations. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { runDoctor, type TranscriberDoctorInternals } from './doctor.ts'
import { runListLectures } from './lectures.ts'
import type {
  TranscriberDoctorReport, TranscriberDoctorRequest, TranscriberLectureListing,
  TranscriberLectureListingRequest,
} from './types.ts'

export type * from './types.ts'
export {
  buildDoctorCommand, buildEngineCommand, parseDoctorReport,
  type TranscriberDoctorCommand, type TranscriberDoctorMode,
} from './doctor.ts'
export type { TranscriberDoctorInternals } from './doctor.ts'
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
}

export default TranscriberEngine
