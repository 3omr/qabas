/** Browser assembly of the study library, background jobs, and explicit assistant navigation. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { conversationStarter } from './chat-actions.ts'
import { jobActions, LibraryJobs } from './jobs.ts'
import { IconLibrary } from './icons.tsx'
import { JobsTray, type JobsTrayInjected } from './JobsTray.tsx'
import { LibraryPanel, type LibraryPanelInjected } from './LibraryPanel.tsx'
import { LibraryTree, type LibraryTreeInjected } from './LibraryTree.tsx'
import { registerTranscriberTitles } from './tool-titles.ts'
import { en, zh } from './locales.ts'
import { LibraryService } from './service.ts'

export type { LibraryKey } from './locales.ts'
export type {
  LibraryAction, LibraryEngine, LibraryOpener, LibraryRoute, LibraryService, LibraryState, LibraryTarget, Loadable,
} from './service.ts'
export type { JobKind, JobStatus, JobStep, LibraryJob } from './jobs.ts'
export type {
  LectureState, LibraryLecture, LibraryMaterial, LibraryModule, ModuleContents, StateCounts,
} from './model.ts'

/** This package's copy namespace. */
const NS = 'library'

/** The library's key in the layout's `main` slot and the sidebar's panel list. */
const LIBRARY_PANEL = 'library' as MainPanelId

/** Library runtime configuration. */
export interface Config {
  /** Maximum simultaneous background jobs, including jobs waiting for answers. */
  jobConcurrency?: number
  /** The main panel the app opens on. */
  startupPanel?: 'library' | 'conversation'
}

/** Validated library configuration. */
export const Config: z<Config> = z.object({
  jobConcurrency: z.number().step(1).min(1).default(2),
  startupPanel: z.union(['library', 'conversation'] as const).default('library'),
})

/** Required browser services. */
export const inject = [
  'slots', 'locale', 'layout', 'sessions', 'uiSession', 'uiConversation', 'conversation', 'remote', 'remote.transcriberEngine',
]

/**
 * Register the library panel, its sidebar entry, its copy and its background actions.
 * @param ctx - client root context.
 * @param config - validated configuration.
 */
export function apply(ctx: ClientContext, config: Config): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-library: dictionaries')

  ctx.inject(['toolTitles'], (scope) => { registerTranscriberTitles(scope, t) })

  const library = new LibraryService(ctx, ctx.remote.transcriberEngine)
  const start = conversationStarter(ctx, () => library.state.getSnapshot().workspace)
  const jobs = new LibraryJobs(ctx, config.jobConcurrency ?? 2)
  for (const action of jobActions(t, jobs)) {
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

  const trayInjected = (): JobsTrayInjected => ({
    jobs,
    reveal: (job) => {
      library.navigate(job.lecture === undefined
        ? { kind: 'module', module: job.module }
        : { kind: 'lecture', module: job.module, lecture: job.lecture })
      ctx.layout.selectPanel(LIBRARY_PANEL)
    },
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'library-jobs',
    locale: NS,
    inject: trayInjected,
  }, JobsTray))

  if ((config.startupPanel ?? 'library') === 'library') {
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
