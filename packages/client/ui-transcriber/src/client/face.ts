/**
 * The panel's asynchronous half: reading the workspace into the store.
 *
 * The component never awaits anything. It calls `start` or `refresh`, and this
 * face performs the read and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * One read is in force per tab: asking again — the refresh control, a panel
 * reopened — retires the read still in flight, whose settlement then writes
 * nothing. Cleanup rides the owner's `signal`: a read is not started for a
 * record that already ended, and when the record goes away the tab's
 * bookkeeping is forgotten, so no later settlement writes to it.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { createTranscriberStore } from './store.ts'
import type { ReadModules } from './workspace.ts'

/** The panel's injected business face, as the body receives it. */
export interface TranscriberInjected {
  /**
   * Seed this tab's panel and read the workspace once.
   * @param tabId - the tab being drawn.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, signal: AbortSignal) => void
  /**
   * Read the workspace again, replacing whatever the panel is showing.
   * @param tabId - the tab being drawn.
   * @param signal - the tab record's lifetime.
   */
  readonly refresh: (tabId: TabId, signal: AbortSignal) => void
}

/**
 * Bind the panel's face to one workspace read.
 * @param read - the bound workspace read.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function transcriberFace(
  read: ReadModules,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createTranscriberStore>>) => TranscriberInjected {
  return (sessionId, actions) => {
    /** Per tab: the read generation a settlement must match; the latest wins. */
    const generations = new Map<TabId, number>()
    const load = (tabId: TabId, signal: AbortSignal): void => {
      if (signal.aborted) return
      const generation = (generations.get(tabId) ?? 0) + 1
      generations.set(tabId, generation)
      actions.loading(tabId)
      void read(sessionId, signal).then((result) => {
        // A newer read was asked for since, or the record is gone and its
        // bookkeeping with it: nothing left for this one to write.
        if (generations.get(tabId) !== generation) return
        if (result.ok) actions.loaded(tabId, result.value)
        else actions.failed(tabId, result.error)
      })
    }
    return {
      start(tabId, signal) {
        actions.start(tabId)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          actions.forget(tabId)
        }, { once: true })
        load(tabId, signal)
      },
      refresh: load,
    }
  }
}
