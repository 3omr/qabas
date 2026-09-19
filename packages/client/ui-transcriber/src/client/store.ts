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
        bucket(draft, tabId).state = { kind: 'loading' }
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
