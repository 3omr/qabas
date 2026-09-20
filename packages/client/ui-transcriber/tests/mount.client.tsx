/**
 * Mount the panel over a real store instance and a scripted workspace read.
 *
 * The component reads a handful of its props; the rest of the standard kit is
 * framework-injected and never touched here, so one documented cast keeps the
 * harness to what is actually exercised.
 */
import { useSyncExternalStore } from 'react'
import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarRightTabActions } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { transcriberFace } from '../src/client/face.ts'
import type { TranscriberInjected } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'
import { createTranscriberStore } from '../src/client/store.ts'
import { TranscriberBody } from '../src/client/TranscriberBody.tsx'
import type { TranscriberBodyProps } from '../src/client/TranscriberBody.tsx'
import type { ModuleView } from '../src/client/workspace.ts'

export const SESSION = 's-test' as SessionId
export const ROOT = '/work/study'
export const TAB = 'tab-1' as TabId

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S {
    return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot))
  }
}

/** A read the spec settles by hand, so nothing depends on timing. */
export interface ScriptedRead {
  readonly read: Mock<(session: SessionId, signal: AbortSignal) => Promise<RemoteResult<ModuleView[]>>>
  /** Settle the read still in flight, and flush the write it makes. */
  readonly settle: (result: RemoteResult<ModuleView[]>) => Promise<void>
}

function scriptedRead(): ScriptedRead {
  const pending: ((result: RemoteResult<ModuleView[]>) => void)[] = []
  const read = vi.fn(() => new Promise<RemoteResult<ModuleView[]>>((resolve) => { pending.push(resolve) }))
  return {
    read,
    settle: async (result) => {
      // Only the newest read is settled: an older one the face has retired
      // would write nothing anyway, and leaving it open proves that.
      pending.pop()?.(result)
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

/** What a spec holds after mounting: the rendered view and every hand on the panel. */
export interface Mounted {
  readonly view: RenderResult
  readonly script: ScriptedRead
  readonly face: TranscriberInjected
  readonly controller: AbortController
  readonly actions: ReturnType<ReturnType<typeof createTranscriberStore>['create']>['actions']
}

/**
 * Mount the panel.
 * @param cwd - the session's working directory as `useSessions` reports it; `null` for a session without one.
 * @param visible - whether the tab is currently visible in its pane.
 */
export function mountBody(cwd: string | null = ROOT, visible = true): Mounted {
  const instance = createTranscriberStore().create()
  const script = scriptedRead()
  const face = transcriberFace(script.read)(SESSION, instance.actions)
  const controller = new AbortController()
  const tabActions = {
    openResource: vi.fn<SidebarRightTabActions['openResource']>(),
    openTab: vi.fn<SidebarRightTabActions['openTab']>(),
    close: vi.fn<SidebarRightTabActions['close']>(),
  }
  const sessions = { byId: cwd === null ? {} : { [SESSION]: { cwd } } } as unknown as SessionListState
  const shared = {
    useTabInfo: () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: TAB, kind: 'transcriber', contentId: 'transcriber', title: zh['type.label'], visible,
        navigation: { address: 'transcriber', params: undefined, revision: 1 },
        signal: controller.signal,
        actions: tabActions,
      },
    }),
    sessionId: SESSION,
    useSessions: <S,>(sel: (s: SessionListState) => S) => sel(sessions),
    useStore: hookOf(instance),
    actions: instance.actions,
    ...face,
    t: makeTranslate(zh),
  }
  const view = render(<TranscriberBody {...shared as unknown as TranscriberBodyProps} />)
  return { view, script, face, controller, actions: instance.actions }
}
