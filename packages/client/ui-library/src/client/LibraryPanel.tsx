/**
 * The library as the app's main panel: a header that says where the student
 * is, and the page for that place.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button, IconChevronRightOutline14, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconLibrary } from './icons.tsx'
import { displayTitle, lectureHeading, type LibraryModule } from './model.ts'
import { useSnapshot } from './parts.tsx'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { LibraryJob } from './jobs.ts'
import type { LectureEditing, TranscriptKind } from './editing.ts'
import { isActive } from './JobsTray.tsx'
import type { LibraryRoute, LibraryService, LibraryState } from './service.ts'
import { HomeView } from './views/Home.tsx'
import { LectureView } from './views/Lecture.tsx'
import { ModuleView } from './views/Module.tsx'
import type {} from './locales.ts'
import css from './LibraryPanel.module.css'

/** What the panel is handed besides its copy. */
export interface LibraryPanelInjected {
  readonly library: LibraryService
  /** Background jobs, so a lecture shows the work running on it. */
  readonly jobs?: ObservableSnapshot<readonly LibraryJob[]> | undefined
  /** Open a conversation with the assistant, scoped to nothing in particular. */
  readonly ask: () => void
}

/** The panel's props. */
export type LibraryPanelProps = LibraryPanelInjected & PropsLocale<'library'>

interface Crumb {
  readonly label: string
  readonly route?: LibraryRoute
}

/**
 * The trail from the library's front page to where the student is; the last
 * crumb is the current page and is not a link.
 * @param state - library state.
 * @param t - translate.
 * @returns the crumbs.
 */
/** The lecture's heading when its module is loaded, else its unit title. */
function crumbHeading(state: LibraryState, module: string, lecture: string): string {
  const read = state.contents[module]
  const found = read?.status === 'ready' ? read.value.lectures.find(item => item.title === lecture) : undefined
  return found === undefined ? displayTitle(lecture) : lectureHeading(found)
}

export function crumbsOf(state: LibraryState, t: TranslateNS<'library'>): Crumb[] {
  const { route, modules } = state
  if (route.kind === 'home') return [{ label: t('panel.home') }]
  const module = modules.status === 'ready' ? modules.value.find(item => item.id === route.module) : undefined
  const moduleLabel = module?.displayName ?? route.module
  if (route.kind === 'module') return [{ label: t('panel.home'), route: { kind: 'home' } }, { label: moduleLabel }]
  return [
    { label: t('panel.home'), route: { kind: 'home' } },
    { label: moduleLabel, route: { kind: 'module', module: route.module } },
    { label: crumbHeading(state, route.module, route.lecture) },
  ]
}

function Page({ state, library, jobs, t }: {
  readonly state: LibraryState
  readonly library: LibraryService
  readonly jobs: ObservableSnapshot<readonly LibraryJob[]>
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const actions = useSnapshot(library.actions)
  const editing = useSnapshot(library.editing)
  const setup = useSnapshot(library.setup)
  const jobList = useSnapshot(jobs)
  const runningIn = (moduleId: string) => (lecture: string): LibraryJob | undefined =>
    jobList.find(job => isActive(job) && job.module === moduleId && job.lecture === lecture)
  const navigate = (route: LibraryRoute): void => { library.navigate(route) }
  const { route, modules, contents } = state
  const home = (): ReactNode => (
    <HomeView
      modules={modules.status === 'ready' ? modules.value : []}
      contents={contents}
      navigate={navigate}
      setup={setup}
      changed={() => { void library.refresh() }}
      t={t}
    />
  )
  if (modules.status === 'loading') return <p className={css.status} role="status">{t('loading')}</p>
  if (modules.status === 'failed') {
    return (
      <div className={css.status} role="alert">
        <p>{t('failed', { message: modules.message })}</p>
        <Button variant="outline" onClick={() => { void library.loadModules() }}>{t('retry')}</Button>
      </div>
    )
  }
  if (route.kind === 'home') {
    return home()
  }
  const module: LibraryModule | undefined = modules.value.find(item => item.id === route.module)
  if (module === undefined) return home()
  const read = contents[module.id]
  if (read === undefined || read.status === 'loading') return <p className={css.status} role="status">{t('loading')}</p>
  if (read.status === 'failed') {
    return (
      <div className={css.status} role="alert">
        <p>{t('failed', { message: read.message })}</p>
        <Button variant="outline" onClick={() => { void library.loadModule(module.id) }}>{t('retry')}</Button>
      </div>
    )
  }
  const lecture = route.kind === 'module' ? undefined : read.value.lectures.find(item => item.title === route.lecture)
  if (lecture === undefined) {
    return (
      <ModuleView
        module={module}
        contents={read.value}
        actions={actions}
        running={runningIn(module.id)}
        editing={editing}
        navigate={navigate}
        retry={() => { void library.loadModule(module.id) }}
        t={t}
      />
    )
  }
  return (
    <LectureView
      module={module}
      lecture={lecture}
      actions={actions}
      job={runningIn(module.id)(lecture.title)}
      open={(path) => { library.open(path) }}
      canOpen={library.canOpen}
      {...editing?.removeTranscript === undefined ? {} : {
        removeTranscript: (kind: TranscriptKind) => (editing.removeTranscript as NonNullable<LectureEditing['removeTranscript']>)(
          module.id, lecture.title, [kind]),
      }}
      changed={() => { void library.loadModule(module.id) }}
      t={t}
    />
  )
}

/**
 * The main panel.
 * @param props.library - the library service.
 * @param props.ask - open a conversation with the assistant.
 * @param props.t - translate.
 */
/** No jobs service: nothing runs, nothing changes. */
const NO_JOBS: ObservableSnapshot<readonly LibraryJob[]> = { getSnapshot: () => NONE, subscribe: () => () => {} }
const NONE: readonly LibraryJob[] = []

export function LibraryPanel({ library, jobs, ask, t }: LibraryPanelProps): ReactNode {
  const state = useSnapshot(library.state)
  // Every module's card shows its progress, so the front page reads them all.
  const moduleIds = state.modules.status === 'ready' ? state.modules.value.map(module => module.id).join('\n') : ''
  useEffect(() => {
    if (state.route.kind !== 'home' || moduleIds === '') return
    for (const id of moduleIds.split('\n')) {
      if (library.state.getSnapshot().contents[id] === undefined) void library.loadModule(id)
    }
  }, [library, moduleIds, state.route.kind])
  const crumbs = crumbsOf(state, t)
  const refreshing = state.modules.status === 'ready' && state.modules.refreshing
  return (
    <div className={css.root} data-library-route={state.route.kind}>
      <header className={css.bar}>
        <nav className={css.crumbs} aria-label={t('panel.label')}>
          <span className={css.crumbMark} aria-hidden><IconLibrary size={18} /></span>
          {crumbs.map((crumb, index) => (
            <span key={`${index}:${crumb.label}`} className={css.crumb}>
              {index > 0 && <span className={css.crumbSep} aria-hidden><IconChevronRightOutline14 /></span>}
              {crumb.route === undefined
                ? <span className={css.crumbCurrent} aria-current="page">{crumb.label}</span>
                : (
                  <button type="button" className={css.crumbLink} onClick={() => { library.navigate(crumb.route as LibraryRoute) }}>
                    {crumb.label}
                  </button>
                )}
            </span>
          ))}
        </nav>
        <div className={css.barActions}>
          <button
            type="button"
            className={css.iconButton}
            onClick={() => { void library.refresh() }}
            aria-label={t('panel.refresh')}
            title={t('panel.refresh')}
            aria-busy={refreshing}
            data-spinning={refreshing}
          >
            <IconRefreshOutline16 />
          </button>
          <Button variant="outline" size="sm" onClick={ask}>{t('panel.ask')}</Button>
        </div>
      </header>
      <main className={css.scroller}>
        <Page state={state} library={library} jobs={jobs ?? NO_JOBS} t={t} />
      </main>
    </div>
  )
}
