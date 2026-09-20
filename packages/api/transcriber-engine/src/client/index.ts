/** Client provider for the engine-facing transcriber capability. */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranscriberDoctorReport, TranscriberDoctorRequest } from '../types.ts'
import type {} from '@deepseek-ai/dsh-api-transcriber-engine/remote'

/** Browser-facing methods supplied by this package's Client provider. */
export interface TranscriberEngineClient {
  /** Run the engine's presence or liveness doctor through the Host Remote. */
  doctor(request: TranscriberDoctorRequest, signal?: AbortSignal): Promise<RemoteResult<TranscriberDoctorReport>>
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
  } satisfies TranscriberEngineClient)
}
