/**
 * The panel's asynchronous half: reading the workspace into the store.
 *
 * The component never awaits anything. It calls `start`, `refresh`, or `watch`,
 * and this face performs the read and writes the outcome through the store's
 * own actions — the Slot-standard `inject` shape, so the session id is resolved
 * by the framework and the write set stays the store's.
 *
 * One read is in force per tab: asking again — the refresh control, a panel
 * reopened — retires the read still in flight, whose settlement then writes
 * nothing. Cleanup rides the owner's `signal`: a read is not started for a
 * record that already ended, and when the record goes away the tab's
 * bookkeeping is forgotten, so no later settlement writes to it.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote, RemoteResult, TranscriberImportDestination } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { hasUnfinishedRun, RUN_POLL_INTERVAL_MS } from './store.ts'
import type { createTranscriberStore } from './store.ts'
import type { ModuleView, ReadModules, ReadModulesOptions } from './workspace.ts'

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
  /**
   * Arm or disarm the polling timer for this tab.
   * @param tabId - the tab being drawn.
   * @param signal - the tab record's lifetime.
   * @param active - whether the visible ready state has an unfinished run.
   */
  readonly watch: (tabId: TabId, signal: AbortSignal, active: boolean) => void
  /**
   * Copy native file-drop paths into one module and refresh its listing.
   * @param tabId - the visible panel tab receiving the drop.
   * @param signal - the tab record's lifetime.
   * @param moduleId - module folder id from the target element.
   * @param destination - engine-owned destination folder.
   * @param paths - absolute native paths supplied by Tauri.
   */
  readonly drop: (
    tabId: TabId,
    signal: AbortSignal,
    moduleId: string,
    destination: TranscriberImportDestination,
    paths: readonly string[],
  ) => void
}

/**
 * Bind the panel's face to one workspace read.
 * @param read - the bound workspace read.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function transcriberFace(
  read: ReadModules,
  importFiles?: ClientRemote['transcriberEngine']['importFiles'],
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createTranscriberStore>>) => TranscriberInjected {
  return (sessionId, actions) => {
    /** Per tab: the read generation a settlement must match; the latest wins. */
    const generations = new Map<TabId, number>()
    const timers = new Map<TabId, number>()
    const latest = new Map<TabId, readonly ModuleView[]>()
    const stopWatching = (tabId: TabId): void => {
      const timer = timers.get(tabId)
      if (timer === undefined) return
      window.clearInterval(timer)
      timers.delete(tabId)
    }
    const load = (tabId: TabId, signal: AbortSignal, includeNotebook = true): void => {
      if (signal.aborted) return
      const generation = (generations.get(tabId) ?? 0) + 1
      generations.set(tabId, generation)
      actions.loading(tabId)
      const publish = (result: RemoteResult<ModuleView[]>): void => {
        // A newer read was asked for since, or the record is gone and its
        // bookkeeping with it: nothing left for this one to write.
        if (signal.aborted || generations.get(tabId) !== generation) return
        if (result.ok) {
          latest.set(tabId, result.value)
          actions.loaded(tabId, result.value)
          if (!hasUnfinishedRun(result.value)) stopWatching(tabId)
        }
        else actions.failed(tabId, result.error)
      }
      const onDisk = (modules: readonly ModuleView[]): void => { publish({ ok: true, value: [...modules] }) }
      const previous = latest.get(tabId)
      const options: ReadModulesOptions = includeNotebook
        ? { onDisk }
        : previous === undefined
          ? { includeNotebook: false, onDisk }
          : { includeNotebook: false, previous, onDisk }
      void read(sessionId, signal, options).then(publish)
    }
    const watch = (tabId: TabId, signal: AbortSignal, active: boolean): void => {
      if (!active || signal.aborted || timers.has(tabId)) {
        if (!active || signal.aborted) stopWatching(tabId)
        return
      }
      timers.set(tabId, window.setInterval(() => {
        if (signal.aborted) stopWatching(tabId)
        else load(tabId, signal, false)
      }, RUN_POLL_INTERVAL_MS))
    }
    const drop = (
      tabId: TabId,
      signal: AbortSignal,
      moduleId: string,
      destination: TranscriberImportDestination,
      paths: readonly string[],
    ): void => {
      if (importFiles === undefined || signal.aborted || paths.length === 0) return
      const generation = (generations.get(tabId) ?? 0) + 1
      generations.set(tabId, generation)
      actions.dropStarted(tabId, moduleId, destination)
      void importFiles({ module: moduleId, destination, paths }, signal).then((outcome) => {
        if (signal.aborted || generations.get(tabId) !== generation) return
        actions.dropSettled(tabId, moduleId, outcome)
        load(tabId, signal)
      })
    }
    return {
      start(tabId, signal) {
        actions.start(tabId)
        signal.addEventListener('abort', () => {
          generations.delete(tabId)
          latest.delete(tabId)
          stopWatching(tabId)
          actions.forget(tabId)
        }, { once: true })
        load(tabId, signal)
      },
      refresh: load,
      watch,
      drop,
    }
  }
}
