/**
 * The panel's view state: the workspace's modules as the last read found them.
 *
 * One read produces the whole tree, so unlike the file tree there is no
 * per-level state to keep: a tab is loading, ready, or failed. It is bucketed
 * by tab id all the same, because two panels of this kind in one session
 * refresh independently.
 *
 * Writers run between `start` and `forget`: the owner's `signal` is what ends
 * a bucket's life, and the face stops dispatching once it aborts.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ModuleView } from './workspace.ts'

/** Five seconds keeps an in-flight run responsive without reading twelve times a minute. */
export const RUN_POLL_INTERVAL_MS = 5_000

/** What one panel is doing right now. */
export type PanelState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly modules: readonly ModuleView[] }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/** One tab's panel: what it last read, and which modules the reader has collapsed. */
export interface TranscriberTabState {
  /** The read's outcome. */
  state: PanelState
  /** Module ids the reader has collapsed; everything else is open. */
  collapsed: string[]
}

/** Every tab's panel, keyed by tab id. */
export interface TranscriberState {
  byTab: Record<TabId, TranscriberTabState>
}

/**
 * Whether a visible panel needs another workspace read for an unfinished run.
 * @param panel - the tab's current state, when its store bucket exists.
 * @param visible - whether the tab is currently shown to the reader.
 * @returns whether the interval should remain armed.
 */
export function shouldPollRuns(panel: TranscriberTabState | undefined, visible: boolean): boolean {
  return visible
    && panel?.state.kind === 'ready'
    && hasUnfinishedRun(panel.state.modules)
}

/** Whether any module view still carries a run without a terminal result. */
export function hasUnfinishedRun(modules: readonly ModuleView[]): boolean {
  return modules.some(module => module.run !== undefined && !module.run.finished)
}

/**
 * One tab's bucket, which every writer after `start` relies on.
 * @param state - the draft.
 * @param tabId - the tab being written.
 * @returns the tab's panel.
 */
function bucket(state: TranscriberState, tabId: TabId): TranscriberTabState {
  const panel = state.byTab[tabId]
  if (panel === undefined) throw new Error(`ui-transcriber: no panel for tab "${tabId}"`)
  return panel
}

/** The panel store's write set; every action names the tab it writes. */
type TranscriberActions = {
  start: (draft: TranscriberState, tabId: TabId) => void
  loading: (draft: TranscriberState, tabId: TabId) => void
  loaded: (draft: TranscriberState, tabId: TabId, modules: readonly ModuleView[]) => void
  failed: (draft: TranscriberState, tabId: TabId, failure: RemoteFailure) => void
  toggled: (draft: TranscriberState, tabId: TabId, moduleId: string) => void
  forget: (draft: TranscriberState, tabId: TabId) => void
}

/**
 * Declare the panel's store.
 * @returns the store handle to declare on the registration.
 */
export function createTranscriberStore(): EngineStoreHandle<TranscriberState, TranscriberActions> {
  return defineStore({
    init: (): TranscriberState => ({ byTab: {} }),
    actions: {
      start(draft, tabId) {
        draft.byTab[tabId] = { state: { kind: 'loading' }, collapsed: [] }
      },
      loading(draft, tabId) {
        const panel = bucket(draft, tabId)
        // Keep the last complete tree on interval refreshes; a long-running
        // read must not make an in-flight lecture disappear between ticks.
        if (panel.state.kind !== 'ready') panel.state = { kind: 'loading' }
      },
      loaded(draft, tabId, modules) {
        bucket(draft, tabId).state = { kind: 'ready', modules: [...modules] }
      },
      failed(draft, tabId, failure) {
        bucket(draft, tabId).state = { kind: 'failed', failure }
      },
      toggled(draft, tabId, moduleId) {
        const panel = bucket(draft, tabId)
        const at = panel.collapsed.indexOf(moduleId)
        if (at === -1) panel.collapsed.push(moduleId)
        else panel.collapsed.splice(at, 1)
      },
      forget(draft, tabId) {
        draft.byTab = Object.fromEntries(
          Object.entries(draft.byTab).filter(([id]) => id !== tabId),
        )
      },
    },
  })
}
