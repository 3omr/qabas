/** Host Remote owner for the transcriber engine's readiness and future operations. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { runDoctor, type TranscriberDoctorInternals } from './doctor.ts'
import type { TranscriberDoctorReport, TranscriberDoctorRequest } from './types.ts'

export type * from './types.ts'
export { buildDoctorCommand, parseDoctorReport, type TranscriberDoctorCommand, type TranscriberDoctorMode } from './doctor.ts'
export type { TranscriberDoctorInternals } from './doctor.ts'

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
}

export default TranscriberEngine
