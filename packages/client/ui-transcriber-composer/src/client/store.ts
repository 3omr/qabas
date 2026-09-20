import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'

/** Current workspace-read state and the two choices visible in the strip. */
export interface TranscriberComposerState {
  phase: 'loading' | 'ready' | 'failed'
  modules: readonly ModuleView[]
  moduleId: string | undefined
  lectureTitle: string | undefined
  failure: RemoteFailure | undefined
}

type TranscriberComposerActions = {
  loading: (draft: TranscriberComposerState) => void
  loaded: (draft: TranscriberComposerState, modules: readonly ModuleView[]) => void
  failed: (draft: TranscriberComposerState, failure: RemoteFailure) => void
  selectModule: (draft: TranscriberComposerState, moduleId: string) => void
  selectLecture: (draft: TranscriberComposerState, title: string) => void
}

function firstLectureOf(module: ModuleView | undefined): string | undefined {
  return module?.lectures[0]?.title
}

function moduleOf(state: TranscriberComposerState, moduleId: string): ModuleView | undefined {
  return state.modules.find(module => module.id === moduleId)
}

/**
 * Create one session-scoped store for the composer strip.
 * @returns the store definition and bound actions.
 */
export function createTranscriberComposerStore(): EngineStoreHandle<TranscriberComposerState, TranscriberComposerActions> {
  return defineStore({
    init: (): TranscriberComposerState => ({
      phase: 'loading',
      modules: [],
      moduleId: undefined,
      lectureTitle: undefined,
      failure: undefined,
    }),
    actions: {
      loading(draft) {
        draft.phase = 'loading'
        draft.failure = undefined
      },
      loaded(draft, modules) {
        const firstModule = modules[0]
        draft.phase = 'ready'
        draft.modules = [...modules]
        draft.moduleId = firstModule?.id
        draft.lectureTitle = firstLectureOf(firstModule)
        draft.failure = undefined
      },
      failed(draft, failure) {
        draft.phase = 'failed'
        draft.failure = failure
      },
      selectModule(draft, moduleId) {
        const selected = moduleOf(draft, moduleId)
        draft.moduleId = selected?.id
        draft.lectureTitle = firstLectureOf(selected)
      },
      selectLecture(draft, title) {
        const selected = moduleOf(draft, draft.moduleId ?? '')
        if (selected?.lectures.some(lecture => lecture.title === title)) draft.lectureTitle = title
      },
    },
  })
}
