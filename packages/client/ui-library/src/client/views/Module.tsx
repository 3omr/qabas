/**
 * One module: its lectures with their state and the one thing to do next on
 * each, the module's own actions, and the material its lectures are taught
 * with.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCheckOutline14, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconMaterial, IconRecording, IconTranscript } from '../icons.tsx'
import {
  countStates, displayTitle, lectureHeading, type LibraryLecture, type LibraryModule, type ModuleContents,
} from '../model.ts'
import { ActionButtons, StateBadge, StateLegend, StateProgress } from '../parts.tsx'
import type { LibraryAction, LibraryRoute } from '../service.ts'
import type { LibraryJob } from '../jobs.ts'
import { JobChip } from '../JobsTray.tsx'
import type { EditOutcome, LectureEditing, TrashEntry } from '../editing.ts'
import { ManageView } from './Manage.tsx'
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
  const where = lecture.inNotebookOnly ? `${parts} · ${t('lecture.notebookOnly')}` : parts
  // Under a transcript's own title, name the recordings it came from.
  // Isolated: an English file name inside Arabic copy would reorder its neighbours.
  // (Not when the transcript's title is the unit's own name with an emoji.)
  return lecture.transcriptTitle === undefined || displayTitle(lecture.transcriptTitle) === displayTitle(lecture.title)
    ? where
    : `\u2068${displayTitle(lecture.title)}\u2069 · ${where}`
}

function LectureRow({ module, lecture, actions, job, onOpen, t }: {
  readonly module: LibraryModule
  readonly lecture: LibraryLecture
  readonly actions: readonly LibraryAction[]
  readonly job: LibraryJob | undefined
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
          <span className={css.rowTitle} dir="auto">{lectureHeading(lecture)}</span>
          <span className={css.rowMeta}>{lectureMeta(lecture, t)}</span>
        </span>
        <StateBadge state={lecture.state} t={t} />
      </button>
      <span className={css.rowActions}>
        {job === undefined
          ? <ActionButtons actions={actions} target={{ module, lecture }} compact primaryOnly />
          : <JobChip job={job} t={t} />}
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
 * @param props.removeModule - send the whole module to the library's trash; absent on an older engine.
 * @param props.t - translate.
 */
export function ModuleView({ module, contents, actions, running, editing, navigate, retry, removeModule, t }: {
  readonly module: LibraryModule
  readonly contents: ModuleContents | undefined
  readonly actions: readonly LibraryAction[]
  /** The active job on a lecture of this module, if any. */
  readonly running?: ((lecture: string) => LibraryJob | undefined) | undefined
  /** The calls that let the student edit lectures and files; absent hides the manager. */
  readonly editing?: LectureEditing | undefined
  readonly navigate: (route: LibraryRoute) => void
  readonly retry: () => void
  readonly removeModule?: (() => Promise<EditOutcome<unknown>>) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [filter, setFilter] = useState<LectureFilter>('all')
  const [removeError, setRemoveError] = useState<string | undefined>(undefined)
  const busy = lecturesOf(contents).some(lecture => running?.(lecture.title) !== undefined)
  const remove = removeModule === undefined || busy ? undefined : (): void => {
    if (!window.confirm(t('module.remove.confirm', { module: module.displayName }))) return
    setRemoveError(undefined)
    void removeModule().then((answer) => {
      if (answer.ok) navigate({ kind: 'home' })
      else setRemoveError(answer.message)
    })
  }
  const [managing, setManaging] = useState(false)
  const lectures = contents?.lectures ?? []
  const counts = countStates(lectures)
  const shown = lectures.filter(lecture => inFilter(filter, lecture))
  const lectureActions = actions.filter(action => action.scope === 'lecture')
  const buildIndex = editing?.buildQuestionIndex === undefined
    ? undefined
    : () => (editing.buildQuestionIndex as NonNullable<LectureEditing['buildQuestionIndex']>)(module.id)
  // The index is built on this machine with no AI request; a chat job for it
  // would spend the student's quota on what one engine call does.
  const moduleActions = actions.filter(action => action.scope === 'module' && !(action.id === 'questions' && buildIndex !== undefined))
  const indexBuilt = contents?.questionIndex?.state === 'built'
  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <div className={css.pageTitles}>
          <h1 className={css.pageTitle}><bdi>{module.displayName}</bdi></h1>
          <p className={css.pageSubtitle}>
            {t('home.card.lectures', { count: String(lectures.length) })}
            {' · '}
            {module.notebooks.length > 0 ? t('module.notebook.linked') : t('module.notebook.none')}
          </p>
          {buildIndex !== undefined && indexBuilt && <IndexReady build={buildIndex} done={retry} t={t} />}
        </div>
        <div className={css.pageActions}>
          {editing !== undefined && !managing && (
            <Button variant="outline" onClick={() => { setManaging(true) }}>{t('manage.open')}</Button>
          )}
          <ActionButtons actions={moduleActions} target={{ module }} />
          {remove !== undefined && !managing && (
            <Button variant="ghost" className={css.dangerGhost} onClick={remove}>{t('module.remove')}</Button>
          )}
        </div>
      </header>
      {removeError !== undefined && <p className={css.calloutError} role="alert" dir="auto">{removeError}</p>}

      {contents?.questionIndex !== undefined && contents.questionIndex.state !== 'built' && contents.questionIndex.files > 0 && (
        <QuestionIndexCard
          state={contents.questionIndex.state}
          files={contents.questionIndex.files}
          build={buildIndex}
          fallback={moduleActions.find(action => action.id === 'questions')}
          module={module}
          done={retry}
          t={t}
        />
      )}
      {contents?.questionIndex?.files === 0 && editing !== undefined && (
        <NoExamsCard module={module} editing={editing} done={retry} t={t} />
      )}
      {managing && editing !== undefined && (
        <ManageView
          module={module}
          lectures={lectures}
          editing={editing}
          changed={retry}
          done={() => { setManaging(false) }}
          t={t}
        />
      )}
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
      {!managing && <section className={css.section} aria-labelledby="library-lectures">
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
                    job={running?.(lecture.title)}
                    onOpen={() => { navigate({ kind: 'lecture', module: module.id, lecture: lecture.title }) }}
                    t={t}
                  />
                ))}
              </ul>
            )}
      </section>}
      {!managing && contents?.general !== undefined && contents.general.length > 0 && (
        <section className={css.section} aria-labelledby="library-general">
          <h2 id="library-general" className={css.sectionTitle}>{t('module.general')}</h2>
          <p className={css.sectionHint}>{t('module.general.hint')}</p>
          <ul className={css.materials}>
            {contents.general.map(name => (
              <li key={name} className={css.material}>
                <IconMaterial aria-hidden />
                <span dir="auto">{name.split('/').pop() ?? name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!managing && contents !== undefined && contents.materials.some(material => !(contents.general ?? []).includes(material.name)) && (
        <section className={css.section} aria-labelledby="library-materials">
          <h2 id="library-materials" className={css.sectionTitle}>{t('module.materials')}</h2>
          <p className={css.sectionHint}>{t('module.materials.hint')}</p>
          <ul className={css.materials}>
            {contents.materials.filter(material => !(contents.general ?? []).includes(material.name)).map(material => (
              <li key={material.path} className={css.material}>
                <IconMaterial aria-hidden />
                <span dir="auto">{material.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!managing && editing?.listTrash !== undefined && editing.restoreTrash !== undefined && (
        <ModuleTrash
          module={module}
          list={editing.listTrash.bind(editing)}
          restore={editing.restoreTrash.bind(editing)}
          version={contents}
          restored={retry}
          t={t}
        />
      )}
    </div>
  )
}

/** A module's lectures, or none before it is read. */
function lecturesOf(contents: ModuleContents | undefined): readonly LibraryLecture[] {
  return contents?.lectures ?? []
}

/**
 * What was removed from this module, newest first, each with a way back:
 * files, transcripts and lectures taken out of the library. Nothing removed is
 * deleted, so this is the other half of every remove button; it stays out of
 * sight while the trash is empty.
 * @param props.module - the module.
 * @param props.list - read the trash.
 * @param props.restore - restore one entry.
 * @param props.version - the module's contents, so the list is read again after any change.
 * @param props.restored - read the module again after a restore.
 * @param props.t - translate.
 */
function ModuleTrash({ module, list, restore, version, restored, t }: {
  readonly module: LibraryModule
  readonly list: NonNullable<LectureEditing['listTrash']>
  readonly restore: NonNullable<LectureEditing['restoreTrash']>
  readonly version: unknown
  readonly restored: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [entries, setEntries] = useState<readonly TrashEntry[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    let live = true
    void list(module.id).then((answer) => { if (live && answer.ok) setEntries(answer.value) })
    return () => { live = false }
  }, [list, module.id, version])
  if (entries.length === 0) return null
  const bringBack = (entry: TrashEntry): void => {
    setBusy(entry.id)
    setError(undefined)
    void restore(module.id, entry.id).then((answer) => {
      setBusy(undefined)
      if (!answer.ok) { setError(answer.message); return }
      setEntries(entries.filter(item => item.id !== entry.id))
      restored()
    })
  }
  return (
    <section className={css.section} aria-labelledby="library-trash">
      <button type="button" className={css.trashToggle} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <h2 id="library-trash" className={css.sectionTitle}>{t('trash.title', { count: String(entries.length) })}</h2>
        <span className={css.trashChevron} data-open={open} aria-hidden>›</span>
      </button>
      {open && (
        <ul className={css.removedList}>
          {entries.map(entry => (
            <li key={entry.id} className={css.removedRow}>
              <span className={css.chip}>{t(`trash.kind.${entry.kind}`)}</span>
              <span className={css.removedName} dir="auto">{entry.label}</span>
              <span className={css.removedWhen}>{shortDate(entry.removedAt)}</span>
              <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => { bringBack(entry) }}>
                {busy === entry.id ? t('trash.restoring') : t('trash.restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && <p className={css.calloutError} role="alert" dir="auto">{error}</p>}
    </section>
  )
}

/**
 * A removal time as a short local date.
 * @param iso - the engine's timestamp.
 * @returns e.g. "3 Oct, 12:14", or the raw text when it is not a date.
 */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const lang = typeof document === 'undefined' ? undefined : document.documentElement.lang || undefined
  return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(date)
}

/**
 * Ask for the question index before anything else: without it no question can
 * carry an honest exam-year badge. Building it reads the papers on this
 * machine and costs no AI request.
 */
function QuestionIndexCard({ state, files, build, fallback, module, done, t }: {
  readonly state: 'missing' | 'stale'
  readonly files: number
  readonly build: (() => Promise<EditOutcome<null>>) | undefined
  readonly fallback: LibraryAction | undefined
  readonly module: LibraryModule
  readonly done: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  if (build === undefined && fallback === undefined) return null
  const start = (): void => {
    if (build === undefined) {
      void fallback?.run({ module })
      return
    }
    setRunning(true)
    setError(undefined)
    void build().then((outcome) => {
      setRunning(false)
      if (outcome.ok) done()
      else setError(outcome.message)
    })
  }
  return (
    <section className={css.callout} data-tone={state} aria-labelledby="question-index">
      <div className={css.calloutText}>
        <h2 id="question-index" className={css.calloutTitle}>{t(`qindex.${state}.title`)}</h2>
        <p className={css.calloutBody}>{t(`qindex.${state}.body`, { count: String(files) })}</p>
        {error !== undefined && <p className={css.calloutError} role="alert" dir="auto">{error}</p>}
      </div>
      <Button variant="primary" disabled={running} onClick={start}>
        {running ? t('qindex.building') : t('qindex.build')}
      </Button>
    </section>
  )
}

/** What a past paper can arrive as: the formats the engine reads questions from. */
const EXAM_FORMATS = '.pdf,.docx,.doc,.txt,.md,.odt,.rtf,.xls,.xlsx,.ppt,.pptx,.pps,.ppsx'

/**
 * A module with no past papers at all. Without them a transcript has no
 * question of its own lecture to badge with a year, and nothing on the page
 * said so or offered a way to add them: the index card only appears once
 * there is something to index. The papers go to the module's Questions
 * folder and the index is built straight after, in one step.
 * @param props.module - the module.
 * @param props.editing - the file calls.
 * @param props.done - read the module again.
 * @param props.t - translate.
 */
function NoExamsCard({ module, editing, done, t }: {
  readonly module: LibraryModule
  readonly editing: LectureEditing
  readonly done: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<{ readonly at: number; readonly of: number } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const add = (files: readonly File[]): void => {
    if (files.length === 0) return
    setError(undefined)
    void (async () => {
      for (const [index, file] of files.entries()) {
        setProgress({ at: index + 1, of: files.length })
        const imported = await editing.importFile(module.id, file, 'question')
        if (!imported.ok) {
          setProgress(undefined)
          setError(imported.message)
          return
        }
      }
      const built = await editing.buildQuestionIndex?.(module.id)
      setProgress(undefined)
      if (built !== undefined && !built.ok) setError(built.message)
      done()
    })()
  }
  return (
    <section className={css.callout} data-tone="empty" aria-labelledby="no-exams">
      <div className={css.calloutText}>
        <h2 id="no-exams" className={css.calloutTitle}>{t('exams.none.title')}</h2>
        <p className={css.calloutBody}>{t('exams.none.body')}</p>
        {error !== undefined && <p className={css.calloutError} role="alert" dir="auto">{error}</p>}
      </div>
      <Button variant="outline" disabled={progress !== undefined} onClick={() => { input.current?.click() }}>
        {progress === undefined
          ? t('exams.none.add')
          : t('exams.none.adding', { at: String(progress.at), of: String(progress.of) })}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={EXAM_FORMATS}
        aria-label={t('exams.none.add')}
        onChange={(event) => {
          add([...event.currentTarget.files ?? []])
          event.currentTarget.value = ''
        }}
      />
    </section>
  )
}

/**
 * A built index is a fact, not a task: one quiet line saying so, with a link
 * to build it again (new papers, a better parser). The big call to action is
 * only for a module whose index is missing or stale.
 */
function IndexReady({ build, done, t }: {
  readonly build: () => Promise<EditOutcome<null>>
  readonly done: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const start = (): void => {
    setRunning(true)
    setError(undefined)
    void build().then((outcome) => {
      setRunning(false)
      if (outcome.ok) done()
      else setError(outcome.message)
    })
  }
  return (
    <p className={css.indexReady} role="status">
      <IconCheckOutline14 aria-hidden />
      <span>{t('qindex.ready')}</span>
      <button type="button" className={css.linkButton} disabled={running} onClick={start} data-library-action="questions">
        {running ? t('qindex.building') : t('qindex.rebuild')}
      </button>
      {error !== undefined && <span className={css.calloutError} role="alert" dir="auto">{error}</span>}
    </p>
  )
}
