import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadModules } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { createTranscriberComposerStore } from './store.ts'

/** Workspace-read operations injected into the composer strip. */
export interface TranscriberComposerInjected {
  /** Read the current session workspace until the slot's lifetime ends. */
  readonly start: (signal: AbortSignal) => void
}

/** Bind the shared workspace read to one session-scoped store. */
export function transcriberComposerFace(
  read: ReadModules,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createTranscriberComposerStore>>) => TranscriberComposerInjected {
  return (sessionId, actions) => {
    let generation = 0
    return {
      start(signal) {
        if (signal.aborted) return
        const current = ++generation
        actions.loading()
        void read(sessionId, signal).then((result) => {
          if (signal.aborted || current !== generation) return
          if (result.ok) actions.loaded(result.value)
          else actions.failed(result.error)
        })
      },
    }
  }
}
