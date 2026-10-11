/**
 * One module: its lectures with their state and the one thing to do next on
 * each, the module's own actions, and the material its lectures are taught
 * with.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, IconChevronRightOutline14, IconEllipsisOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconMaterial, IconRecording, IconTranscript } from '../icons.tsx'
import {
  countStates, groupBySubject, lectureHeading, type LibraryLecture, type LibraryModule, type ModuleContents,
} from '../model.ts'
import { ActionButtons, StateBadge, StateLegend, StateProgress } from '../parts.tsx'
import type { LibraryAction, LibraryRoute } from '../service.ts'
import type { LibraryJob } from '../jobs.ts'
import { JobChip } from '../JobsTray.tsx'
import type { LectureEditing, ModuleFile, TrashEntry } from '../editing.ts'
import { LoadingRows, useIndexProgress, IndexProgress } from './management.tsx'
import { ManageView } from './Manage.tsx'
import { prepareExam } from '../prepare-exam.ts'
import { ModuleHeading } from './ModuleHeading.tsx'
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
 * @param props.t - translate.
 */
export function ModuleView({ module, contents, actions, running, editing, navigate, retry, t, refreshing, refreshError }: {
  readonly module: LibraryModule
  readonly refreshing?: boolean | undefined
  readonly refreshError?: string | undefined
  readonly contents: ModuleContents | undefined
  readonly actions: readonly LibraryAction[]
  /** The active job on a lecture of this module, if any. */
  readonly running?: ((lecture: string) => LibraryJob | undefined) | undefined
  /** The calls that let the student edit lectures and files; absent hides the manager. */
  readonly editing?: LectureEditing | undefined
  readonly navigate: (route: LibraryRoute) => void
  readonly retry: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [filter, setFilter] = useState<LectureFilter>('all')
  const [managing, setManaging] = useState(false)
  const lectures = contents?.lectures ?? []
  const counts = countStates(lectures)
  const shown = lectures.filter(lecture => inFilter(filter, lecture))
  const lectureActions = actions.filter(action => action.scope === 'lecture')
  const indexProgress = useIndexProgress(editing, module.id, t)
  const buildIndex = editing?.buildQuestionIndex === undefined && editing?.streamQuestionIndex === undefined
    ? undefined
    : async (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (editing.prepareExamFile !== undefined) {
        const files = await editing.listFiles(module.id)
        if (!files.ok) return files
        signal.throwIfAborted()
        const papers = files.value.filter(file => file.kind === 'question')
        for (const [position, paper] of papers.entries()) {
          signal.throwIfAborted()
          setIndexStage(t('exams.reading', { name: paper.name, n: String(position + 1), total: String(papers.length) }))
          const result = await prepareExam(editing, module.id, paper.path, signal, (name) => { setIndexStage(t('exams.installing', { name })) }, t)
          if (!result.ok && result.code === 'ocr_install_failed') return result
        }
      }
      signal.throwIfAborted()
      return indexProgress.run(signal)
    }
  // The engine owns preparation and indexing without creating a chat Session.
  const moduleActions = actions.filter(action => action.scope === 'module' && !(action.id === 'questions' && buildIndex !== undefined))
  const indexBuilt = contents?.questionIndex?.state === 'built'
  const [menu, setMenu] = useState(false)
  const activeIndex = useRef<AbortController | undefined>(undefined)
  const [indexing, setIndexing] = useState(false)
  const [indexStage, setIndexStage] = useState<string | undefined>(undefined)
  const [indexError, setIndexError] = useState<string | undefined>(undefined)
  useEffect(() => {
    setIndexing(false)
    setIndexStage(undefined)
    setIndexError(undefined)
    return () => { activeIndex.current?.abort(); activeIndex.current = undefined }
  }, [module.id])
  const rebuild = (): void => {
    if (buildIndex === undefined || activeIndex.current !== undefined) return
    const controller = new AbortController()
    activeIndex.current = controller
    setIndexing(true)
    setIndexError(undefined)
    void buildIndex(controller.signal).catch((error: unknown) => ({
      ok: false as const, message: error instanceof Error ? error.message : String(error),
    })).then((outcome) => {
      if (activeIndex.current !== controller) return
      activeIndex.current = undefined
      setIndexing(false)
      setIndexStage(undefined)
      if (controller.signal.aborted) { retry(); return }
      if (outcome.ok) retry()
      else setIndexError(outcome.message)
    })
  }
  const more: readonly { readonly id: string; readonly label: string; readonly run: () => void }[] = [
    ...moduleActions
      .filter(action => action.appliesTo({ module }))
      .map(action => ({ id: action.id, label: action.label(), run: () => { void action.run({ module }) } })),
    ...indexBuilt && buildIndex !== undefined ? [{ id: 'rebuild-index', label: t('qindex.rebuild.menu'), run: rebuild }] : [],
  ]
  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <ModuleHeading module={module} contents={contents} indexing={indexing} t={t}>
          {indexStage !== undefined && <p role="status">{indexStage}</p>}
          {indexError !== undefined && <div role="alert">
            <p className={css.calloutError}>{t('exams.failed')}</p>
            <details><summary>{t('exams.details')}</summary><pre dir="auto">{indexError}</pre></details>
          </div>}
        </ModuleHeading>
        <div className={css.pageActions}>
          {editing !== undefined && <Button variant="outline" onClick={() => { navigate({ kind: 'exams', module: module.id }) }}>{t('exams.manage')}</Button>}
          {editing !== undefined && !managing && (
            <Button variant="outline" onClick={() => { setManaging(true) }}>{t('manage.open')}</Button>
          )}
          {/* Used now and then, so they wait behind one button. */}
          {more.length > 0 && (
            <Menu
              open={menu}
              autoFocus
              portal
              align="end"
              items={more.map(item => ({ id: item.id, label: item.label }))}
              onSelect={(id) => { setMenu(false); more.find(item => item.id === id)?.run() }}
              onClose={() => { setMenu(false) }}
              anchor={(
                <button
                  type="button"
                  className={css.cardMenuButton}
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  aria-label={t('module.more')}
                  onClick={() => { setMenu(value => !value) }}
                >
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
          )}
        </div>
      </header>

      {!managing && contents?.questionIndex !== undefined && contents.questionIndex.state !== 'built' && contents.questionIndex.files > 0 && (
        <QuestionIndexCard
          state={contents.questionIndex.state}
          files={contents.questionIndex.files}
          build={buildIndex === undefined ? undefined : rebuild}
          running={indexing}
          progress={indexing ? <IndexProgress progress={indexProgress.progress} started={indexProgress.started}
            stop={() => { activeIndex.current?.abort() }} t={t} /> : undefined}
          fallback={moduleActions.find(action => action.id === 'questions')}
          module={module}
          t={t}
        />
      )}
      {managing && editing !== undefined && (
        <ManageView
          module={module}
          lectures={lectures}
          {...contents?.subjects === undefined ? {} : { subjects: contents.subjects }}
          editing={editing}
          changed={retry}
          done={() => { setManaging(false) }}
          t={t}
        />
      )}

      {contents?.warning !== undefined && (
        <p className={css.notice} role="status">
          {t('module.warning')}
          <button type="button" className={css.linkButton} onClick={retry}>{t('retry')}</button>
        </p>
      )}
      {!managing && indexBuilt && indexing && <IndexProgress progress={indexProgress.progress} started={indexProgress.started}
        stop={() => { activeIndex.current?.abort() }} t={t} />}
      {refreshing && <span role="status">{t('management.refreshing')}</span>}
      {refreshError !== undefined && <div role="alert"><span dir="auto">{refreshError}</span><Button variant="ghost" onClick={retry}>{t('retry')}</Button></div>}
      {!managing && <section className={css.section} aria-labelledby="library-lectures">
        {contents === undefined ? <LoadingRows t={t} /> : <div className={css.pageProgress}>
          <p>{t('management.transcription', { done: counts.final, total: lectures.length })}</p>
          <StateProgress counts={counts} t={t} /><StateLegend counts={counts} t={t} />
        </div>}
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
            : groupBySubject(shown, contents?.subjects).map((group) => {
              const rows = (
                <ul className={css.rows}>
                  {group.lectures.map(lecture => (
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
              )
              if ((contents?.subjects ?? []).length === 0) return <div key="all">{rows}</div>
              // Group counts follow the whole subject, not the active filter.
              const all = groupBySubject(lectures, contents?.subjects)
                .find(item => item.subject?.id === group.subject?.id)?.lectures ?? group.lectures
              const groupCounts = countStates(all)
              if (group.lectures.length === 0 && filter !== 'all') return null
              return (
                <details key={group.subject?.id ?? 'unassigned'} className={css.subjectGroup} open>
                  <summary className={css.subjectSummary}>
                    <bdi className={css.subjectTitle}>{group.subject?.title ?? t('subjects.none')}</bdi>
                    <span className={css.subjectProgress}>{t('subjects.progress', { done: groupCounts.final, total: all.length })}</span>
                  </summary>
                  {group.lectures.length === 0 ? <p className={css.muted}>{t('subjects.empty')}</p> : rows}
                </details>
              )
            })}
      </section>}
      {!managing && editing !== undefined && (
        <ModuleFiles module={module} editing={editing} version={contents} t={t} />
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

/** Module index coverage and the cancellable action that refreshes it. */
function QuestionIndexCard({ state, files, build, running, progress, fallback, module, t }: {
  readonly progress: ReactNode
  readonly state: 'missing' | 'stale' | 'partial' | 'legacy'
  readonly files: number
  readonly build: (() => void) | undefined
  readonly running: boolean
  readonly fallback: LibraryAction | undefined
  readonly module: LibraryModule
  readonly t: TranslateNS<'library'>
}): ReactNode {
  if (build === undefined && fallback === undefined) return null
  return (
    <section className={css.callout} data-tone={state} aria-labelledby="question-index">
      <div className={css.calloutText}>
        <h2 id="question-index" className={css.calloutTitle}>{t(`qindex.${state}.title`)}</h2>
        <p className={css.calloutBody}>{t(`qindex.${state}.body`, { count: String(files) })}</p>
      </div>
      <Button variant="primary" disabled={running} onClick={() => {
        if (build !== undefined) build()
        else void fallback?.run({ module })
      }}>{running ? t('qindex.building') : t('qindex.build')}</Button>
      {progress !== undefined && <div className={css.calloutProgress}>{progress}</div>}
    </section>
  )
}

/**
 * The module's files -- its recordings and its slides and books -- folded
 * away, each with whether NotebookLM already has it. A reference to check
 * when something seems missing, not something to read every visit.
 * @param props.module - the module.
 * @param props.editing - the file calls.
 * @param props.version - the module's contents, so the list is read again after a change.
 * @param props.t - translate.
 */
function ModuleFiles({ module, editing, version, t }: {
  readonly module: LibraryModule
  readonly editing: LectureEditing
  readonly version: unknown
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [shown, setShown] = useState(false)
  const [files, setFiles] = useState<readonly ModuleFile[] | undefined>(undefined)
  useEffect(() => {
    if (!shown) return
    let live = true
    void editing.listFiles(module.id).then((answer) => { if (live && answer.ok) setFiles(answer.value) })
    return () => { live = false }
  }, [shown, editing, module.id, version])
  const groups: readonly { readonly key: 'recording' | 'material'; readonly title: string }[] = [
    { key: 'recording', title: t('module.files.recordings') },
    { key: 'material', title: t('module.files.materials') },
  ]
  return (
    <section className={css.fold} aria-labelledby="module-files">
      <div className={css.foldHead}>
        <button type="button" id="module-files" className={css.foldButton} aria-expanded={shown} onClick={() => { setShown(!shown) }}>
          <span className={css.trashChevron} data-open={shown} aria-hidden>›</span>
          <IconMaterial aria-hidden />
          <span>{t('module.files.title')}</span>
        </button>
      </div>
      {shown && files === undefined && <LoadingRows t={t} />}
      {shown && files !== undefined && (
        <div className={css.sourcesCard}>
          {groups.map((group) => {
            const members = files.filter(file => file.kind === group.key && file.hidden !== true)
            if (members.length === 0) return null
            return (
              <div key={group.key} className={css.sourceGroup}>
                <h3 className={css.sourceGroupTitle}>{group.title} · {members.length}</h3>
                <ul className={css.sourceList}>
                  {members.map(file => (
                    <li key={file.path} className={css.sourceRow}>
                      {file.kind === 'recording' ? <IconRecording aria-hidden /> : <IconMaterial aria-hidden />}
                      <span className={css.sourceName} dir="auto" title={file.lecture === undefined ? file.name : `${file.name} · ${file.lecture}`}>{file.name}</span>
                      {file.general === true && <span className={css.chip}>{t('module.files.general')}</span>}
                      <span className={css.uploadState} data-uploaded={file.inNotebook}>
                        {file.inNotebook ? t('module.files.uploaded') : t('module.files.notUploaded')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
