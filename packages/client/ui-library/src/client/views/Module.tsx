/**
 * One module: its lectures with their state and the one thing to do next on
 * each, the module's own actions, and the material its lectures are taught
 * with.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconMaterial, IconRecording, IconTranscript } from '../icons.tsx'
import {
  countStates, displayTitle, type LibraryLecture, type LibraryModule, type ModuleContents,
} from '../model.ts'
import { ActionButtons, StateBadge, StateLegend, StateProgress } from '../parts.tsx'
import type { LibraryAction, LibraryRoute } from '../service.ts'
import type {} from '../locales.ts'
import css from '../LibraryPanel.module.css'

/** Which lectures the list shows. */
export type LectureFilter = 'all' | 'todo' | 'progress' | 'done'

const FILTERS: readonly LectureFilter[] = ['all', 'todo', 'progress', 'done']

/**
 * Whether a lecture belongs under a filter.
 * @param filter - the filter.
 * @param lecture - the lecture.
 * @returns whether to list it.
 */
export function inFilter(filter: LectureFilter, lecture: LibraryLecture): boolean {
  switch (filter) {
    case 'all': return true
    case 'todo': return lecture.state === 'pending'
    case 'progress': return lecture.state === 'verbatim' || lecture.state === 'draft'
    case 'done': return lecture.state === 'final'
  }
}

/**
 * The line under a lecture's title: where its recording lives.
 * @param lecture - the lecture.
 * @param t - translate.
 * @returns the line.
 */
export function lectureMeta(lecture: LibraryLecture, t: TranslateNS<'library'>): string {
  if (lecture.parts === 0) return t('lecture.noRecording')
  const parts = lecture.parts === 1 ? t('lecture.parts.one') : t('lecture.parts.many', { count: String(lecture.parts) })
  return lecture.inNotebookOnly ? `${parts} · ${t('lecture.notebookOnly')}` : parts
}

function LectureRow({ module, lecture, actions, onOpen, t }: {
  readonly module: LibraryModule
  readonly lecture: LibraryLecture
  readonly actions: readonly LibraryAction[]
  readonly onOpen: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  return (
    <li
      className={css.row}
      data-library-lecture={lecture.title}
      data-state={lecture.state}
    >
      <button type="button" className={css.rowMain} onClick={onOpen}>
        <span className={css.rowIcon} aria-hidden>
          {lecture.state === 'final' ? <IconTranscript /> : <IconRecording />}
        </span>
        <span className={css.rowTitles}>
          <span className={css.rowTitle} dir="auto">{displayTitle(lecture.title)}</span>
          <span className={css.rowMeta}>{lectureMeta(lecture, t)}</span>
        </span>
        <StateBadge state={lecture.state} t={t} />
      </button>
      <span className={css.rowActions}>
        <ActionButtons actions={actions} target={{ module, lecture }} compact primaryOnly />
        <button type="button" className={css.rowChevron} onClick={onOpen} aria-label={t('lecture.open')}>
          <IconChevronRightOutline14 />
        </button>
      </span>
    </li>
  )
}

/**
 * The module page.
 * @param props.module - the module.
 * @param props.contents - its contents.
 * @param props.actions - registered actions.
 * @param props.navigate - library navigation.
 * @param props.retry - read the module again.
 * @param props.t - translate.
 */
export function ModuleView({ module, contents, actions, navigate, retry, t }: {
  readonly module: LibraryModule
  readonly contents: ModuleContents | undefined
  readonly actions: readonly LibraryAction[]
  readonly navigate: (route: LibraryRoute) => void
  readonly retry: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [filter, setFilter] = useState<LectureFilter>('all')
  const lectures = contents?.lectures ?? []
  const counts = countStates(lectures)
  const shown = lectures.filter(lecture => inFilter(filter, lecture))
  const lectureActions = actions.filter(action => action.scope === 'lecture')
  const moduleActions = actions.filter(action => action.scope === 'module')
  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <div className={css.pageTitles}>
          <h1 className={css.pageTitle} dir="auto">{module.displayName}</h1>
          <p className={css.pageSubtitle}>
            {t('home.card.lectures', { count: String(lectures.length) })}
            {' · '}
            {module.notebooks.length > 0 ? t('module.notebook.linked') : t('module.notebook.none')}
          </p>
        </div>
        <ActionButtons actions={moduleActions} target={{ module }} />
      </header>
      {contents !== undefined && (
        <div className={css.pageProgress}>
          <StateProgress counts={counts} t={t} />
          <StateLegend counts={counts} t={t} />
        </div>
      )}
      {contents?.warning !== undefined && (
        <p className={css.notice} role="status">
          {t('module.warning')}
          <button type="button" className={css.linkButton} onClick={retry}>{t('retry')}</button>
        </p>
      )}
      <section className={css.section} aria-labelledby="library-lectures">
        <div className={css.sectionBar}>
          <h2 id="library-lectures" className={css.sectionTitle}>{t('module.lectures')}</h2>
          <div className={css.filters} role="tablist" aria-label={t('module.lectures')}>
            {FILTERS.map(item => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={filter === item}
                className={clsx(css.filter, filter === item && css.filterActive)}
                onClick={() => { setFilter(item) }}
              >
                {t(`module.filter.${item}`)}
              </button>
            ))}
          </div>
        </div>
        {lectures.length === 0
          ? <p className={css.muted}>{t('module.empty')}</p>
          : shown.length === 0
            ? <p className={css.muted}>{t('module.filterEmpty')}</p>
            : (
              <ul className={css.rows}>
                {shown.map(lecture => (
                  <LectureRow
                    key={lecture.title}
                    module={module}
                    lecture={lecture}
                    actions={lectureActions}
                    onOpen={() => { navigate({ kind: 'lecture', module: module.id, lecture: lecture.title }) }}
                    t={t}
                  />
                ))}
              </ul>
            )}
      </section>
      {contents !== undefined && contents.materials.length > 0 && (
        <section className={css.section} aria-labelledby="library-materials">
          <h2 id="library-materials" className={css.sectionTitle}>{t('module.materials')}</h2>
          <p className={css.sectionHint}>{t('module.materials.hint')}</p>
          <ul className={css.materials}>
            {contents.materials.map(material => (
              <li key={material.path} className={css.material}>
                <IconMaterial aria-hidden />
                <span dir="auto">{material.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
