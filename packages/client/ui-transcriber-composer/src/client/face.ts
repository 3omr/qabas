import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ReadModules } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { createTranscriberComposerStore } from './store.ts'

/** Workspace-read operations injected into the composer strip. */
export interface TranscriberComposerInjected {
  /** Read the current session workspace until the slot's lifetime ends. */
  readonly start: (signal: AbortSignal) => void
  /** Refresh the disk and NotebookLM halves when the strip opens again. */
  readonly refresh: (signal: AbortSignal) => void
}

/**
 * Bind the shared workspace read to one session-scoped store.
 * @param read - shared workspace reader.
 * @returns a session-bound start and refresh face.
 */
export function transcriberComposerFace(
  read: ReadModules,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createTranscriberComposerStore>>) => TranscriberComposerInjected {
  return (sessionId, actions) => {
    let generation = 0
    const load = (signal: AbortSignal): void => {
      if (signal.aborted) return
      const current = ++generation
      actions.loading()
      const publish = (result: RemoteResult<ModuleView[]>): void => {
        if (signal.aborted || current !== generation) return
        if (result.ok) {
          actions.loaded(result.value)
        }
        else actions.failed(result.error)
      }
      void read(sessionId, signal, {
        onDisk: (modules) => { publish({ ok: true, value: [...modules] }) },
      }).then(publish)
    }
    return {
      start: load,
      refresh: load,
    }
  }
}
