/**
 * Browser half: the study library as the app's main panel.
 *
 * The library is where the app starts. The conversation is still one click
 * away — the sessions list, New Session, "ask the assistant" — but a student
 * opening the app sees their modules and lectures, not an empty chat box.
 *
 * Wiring only: what a lecture is (`model.ts`), what the library keeps and
 * lets others extend (`service.ts`), what its buttons do until a background
 * runner replaces them (`chat-actions.ts`), what it draws (`LibraryPanel.tsx`
 * and `views/`), and what it says (`locales.ts`).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { chatActions, conversationStarter } from './chat-actions.ts'
import { IconLibrary } from './icons.tsx'
import { LibraryPanel, type LibraryPanelInjected } from './LibraryPanel.tsx'
import { LibraryTree, type LibraryTreeInjected } from './LibraryTree.tsx'
import { en, zh } from './locales.ts'
import { LibraryService, type LibraryEngine } from './service.ts'

export type { LibraryKey } from './locales.ts'
export type {
  LibraryAction, LibraryEngine, LibraryOpener, LibraryRoute, LibraryState, LibraryTarget, Loadable,
} from './service.ts'
export { LibraryService } from './service.ts'
export type {
  LectureState, LibraryLecture, LibraryMaterial, LibraryModule, ModuleContents, StateCounts,
} from './model.ts'
export { canTranscribe, countStates, displayTitle, LECTURE_STATES, lectureFromEngine } from './model.ts'
export { TRANSCRIBER_PRESET } from './chat-actions.ts'

/** This package's copy namespace. */
const NS = 'library'

/** The library's key in the layout's `main` slot and the sidebar's panel list. */
export const LIBRARY_PANEL = 'library' as MainPanelId

/** Library runtime configuration. */
export interface Config {
  /** The main panel the app opens on: the library, or the conversation as before. */
  startupPanel?: 'library' | 'conversation'
}

/** Validated library configuration. */
export const Config: z<Config> = z.object({
  startupPanel: z.union(['library', 'conversation'] as const).default('library'),
})

/** Required browser services. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'remote', 'remote.transcriberEngine']

/**
 * Register the library panel, its sidebar entry, its copy and its fallback actions.
 * @param ctx - client root context.
 * @param config - validated configuration.
 */
export function apply(ctx: ClientContext, config: Config): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-library: dictionaries')

  const library = new LibraryService(ctx, ctx.remote.transcriberEngine as unknown as LibraryEngine)
  const start = conversationStarter(ctx, () => library.state.getSnapshot().workspace)
  for (const action of chatActions(t, start)) {
    ctx.effect(() => library.registerAction(action), `ui-library: ${action.id} action`)
  }

  const injected = (): LibraryPanelInjected => ({
    library,
    ask: () => { void start(undefined) },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: LIBRARY_PANEL,
    locale: NS,
    inject: injected,
  }, LibraryPanel))
  const treeInjected = (): LibraryTreeInjected => ({
    library,
    show: () => { ctx.layout.selectPanel(LIBRARY_PANEL) },
  })
  ctx.slots.inject('sidebar.library', () => ctx.slots.register({
    name: 'sidebar.library',
    locale: NS,
    inject: treeInjected,
  }, LibraryTree))
  // The panel and the sidebar tree both draw the module list, and the tree is
  // on screen even when the app opens on a conversation.
  void library.loadModules()
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: LIBRARY_PANEL,
    order: -100,
    label: () => t('panel.label'),
  }, IconLibrary))

  if (config.startupPanel === 'library') {
    // Selection fails loud for an unregistered key, so it waits for the panel's
    // own registration to land on the ledger.
    let selected = false
    const selectOnce = (): void => {
      if (selected || !ctx.slots.entries('main').some(entry => entry.options.key === LIBRARY_PANEL)) return
      selected = true
      ctx.layout.selectPanel(LIBRARY_PANEL)
    }
    ctx.effect(() => ctx.slots.subscribe('main', selectOnce), 'ui-library: startup panel')
    selectOnce()
  }
}
