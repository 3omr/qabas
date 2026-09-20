/**
 * The transcriber panel's body: the workspace's modules, and inside each one
 * the lectures that are transcribed and the lectures still waiting.
 *
 * Everything the panel keeps lives in its store, keyed by tab; everything it
 * asks for goes through its injected face. The component itself only decides
 * what to draw: one row per module, and under an open module the lecture sections
 * a lecture can be in. A section with nothing in it is not drawn — an empty
 * "Waiting" heading says less than its absence does.
 *
 * Nothing here starts a transcription. The panel is the answer to "where do
 * things stand"; asking for a run is what the chat is for, and a tool that
 * writes to the user's study material should be fired from a sentence they
 * typed rather than a button they brushed past.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  TranscriberImportDestination, TranscriberImportRejectionCode, TranscriberRejectedFile,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconClockOutline16, IconFolderClose16, IconFolderOpen16, IconRefreshOutline16,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriberInjected } from './face.ts'
import { dropTargetAt, listenForDesktopFileDrops } from './desktop-drops.ts'
import { titleContainsLecture, type LectureUnit } from './lectures.ts'
import type {} from './locales.ts'
import { shouldPollRuns, type TranscriberDropState, type createTranscriberStore } from './store.ts'
import type { ModuleView } from './workspace.ts'
import type { TranscriberRun } from './runs.ts'
import css from './TranscriberBody.module.css'

/** Six glyphs keeps the compact bar readable while the count names five phases. */
const PROGRESS_SLOTS = 6

/** The body's composed props: the tab it draws, its store, its face, and its copy. */
export type TranscriberBodyProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<ReturnType<typeof createTranscriberStore>>
  & TranscriberInjected
  & PropsLocale<'transcriber'>

/**
 * Say why the workspace could not be read, in terms of the workspace.
 * @param t - namespace-bound translate.
 * @param failure - the settled Remote failure.
 * @returns the line to show in place of the modules.
 */
export function failureLine(t: TranslateNS<'transcriber'>, failure: RemoteFailure): string {
  switch (failure.code) {
    case 'workspace-file/not-found': return t('error.notFound')
    // Carrier and unclassified host failures reach the reader as themselves:
    // this panel knows nothing useful to add to a transport-level message.
    default: return t('error.unavailable', { message: failure.message })
  }
}

/**
 * Split one module's lectures into the standings the panel draws.
 * @param lectures - the module's recording-derived lecture units.
 * @param run - the module's newest run, when one exists.
 * @returns lectures grouped into transcribed, failed, and waiting rows.
 */
export function splitLectures(lectures: readonly LectureUnit[], run?: TranscriberRun): {
  transcribed: LectureUnit[]
  failed: LectureUnit[]
  pending: LectureUnit[]
} {
  const transcribed: LectureUnit[] = []
  const failed: LectureUnit[] = []
  const pending: LectureUnit[] = []
  for (const lecture of lectures) {
    const matchedRun = runForLecture(run, lecture)
    if (matchedRun?.status === 'failed') failed.push(lecture)
    else if (lecture.transcribed) transcribed.push(lecture)
    else pending.push(lecture)
  }
  return { transcribed, failed, pending }
}

/** Find the module's latest run when its title names this lecture. */
function runForLecture(run: TranscriberRun | undefined, lecture: LectureUnit): TranscriberRun | undefined {
  return run !== undefined && titleContainsLecture(run.title, lecture.title) ? run : undefined
}

function phaseLabels(run: TranscriberRun, names: readonly string[]): string {
  const labels = names.map(name => run.phases.find(phase => phase.name === name)?.label ?? name)
  return labels.join(', ')
}

function runDescription(run: TranscriberRun, t: TranslateNS<'transcriber'>): string {
  if (run.status === 'failed') {
    return t('run.failed', { phase: phaseLabels(run, run.failed) || t('run.resultFailed') })
  }
  if (run.finished) return t('run.completed')
  return t('run.running', { phase: phaseLabels(run, run.running) || t('run.preparing') })
}

function runBar(run: TranscriberRun): string {
  const completed = Math.min(run.done.length, PROGRESS_SLOTS)
  return '▓'.repeat(completed) + '░'.repeat(PROGRESS_SLOTS - completed)
}

function destinationTitle(destination: TranscriberImportDestination): 'drop.lecture.title' | 'drop.questions.title' {
  return destination === 'Lecture' ? 'drop.lecture.title' : 'drop.questions.title'
}

function rejectionReason(
  t: TranslateNS<'transcriber'>,
  reason: TranscriberImportRejectionCode,
): string {
  switch (reason) {
    case 'source-not-absolute': return t('drop.reason.sourceNotAbsolute')
    case 'unsupported-extension': return t('drop.reason.unsupportedExtension')
    case 'source-not-found': return t('drop.reason.sourceNotFound')
    case 'source-not-file': return t('drop.reason.sourceNotFile')
    case 'source-unreadable': return t('drop.reason.sourceUnreadable')
    case 'name-collision': return t('drop.reason.nameCollision')
    case 'copy-failed': return t('drop.reason.copyFailed')
    default: return assertNever(reason)
  }
}

function assertNever(value: never): never {
  throw new Error(`ui-transcriber: unknown import rejection ${String(value)}`)
}

function rejectedLine(t: TranslateNS<'transcriber'>, file: TranscriberRejectedFile): ReactNode {
  const reason = rejectionReason(t, file.reason)
  return file.detail === undefined
    ? reason
    : <>{reason} <span dir="ltr">({file.detail})</span></>
}

function ImportOutcome({ state, t }: {
  state: Exclude<TranscriberDropState, { kind: 'importing' }>
  t: TranslateNS<'transcriber'>
}): ReactNode {
  if (state.kind === 'failed') {
    return <p className={css.dropFailure} data-transcriber-row="import-result" role="alert">{t('drop.failed', { message: state.failure.message })}</p>
  }
  const { filed, rejected } = state.report
  return (
    <div className={css.dropOutcome} data-transcriber-row="import-result" role="status">
      {filed.length > 0 && <p className={css.dropFiled}>{t('drop.filed', { count: String(filed.length) })}</p>}
      {filed.length > 0 && (
        <ul className={css.dropFiles}>
          {filed.map(file => <li key={file.destination} dir="ltr" title={file.destination}>{file.destination}</li>)}
        </ul>
      )}
      {rejected.length > 0 && <p className={css.dropRejected}>{t('drop.rejected', { count: String(rejected.length) })}</p>}
      {rejected.length > 0 && (
        <ul className={css.dropFiles}>
          {rejected.map(file => (
            <li key={`${file.source}:${file.reason}`}>
              <span dir="ltr" title={file.source}>{file.name}</span>
              {' — '}
              <span>{rejectedLine(t, file)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DropTarget({ moduleId, destination, t }: {
  moduleId: string
  destination: TranscriberImportDestination
  t: TranslateNS<'transcriber'>
}): ReactNode {
  const title = destinationTitle(destination)
  return (
    <div
      className={css.dropTarget}
      data-transcriber-drop-module={moduleId}
      data-transcriber-drop-destination={destination}
      role="button"
      tabIndex={0}
      aria-label={t(title)}
    >
      <span className={css.dropTargetTitle}>{t(title)}</span>
      <span className={css.dropTargetDescription}>
        {t(destination === 'Lecture' ? 'drop.lecture.description' : 'drop.questions.description')}
      </span>
    </div>
  )
}

/** The compact phase progress shown beside a lecture whose run is current. */
function RunProgress({ run, t }: { run: TranscriberRun; t: TranslateNS<'transcriber'> }): ReactNode {
  const description = runDescription(run, t)
  return (
    <span
      className={`${css.progress} ${run.status === 'failed' ? css.progressFailed : ''}`}
      data-transcriber-run-state={run.status}
      data-transcriber-progress={`${run.done.length}/${run.phases.length}`}
      role="status"
      aria-label={description}
    >
      <span className={css.progressBar} aria-hidden="true">{runBar(run)}</span>
      <span className={css.progressCount}>{t('run.progress', {
        done: String(run.done.length),
        total: String(run.phases.length),
      })}</span>
      <span className={css.progressLabel}>{description}</span>
    </span>
  )
}

/** One lecture's row: its title, and the file count when it took more than one. */
function Lecture({ lecture, run, t }: {
  lecture: LectureUnit
  run: TranscriberRun | undefined
  t: TranslateNS<'transcriber'>
}): ReactNode {
  const failed = run?.status === 'failed'
  const progress = run !== undefined && (!lecture.transcribed || !run.finished || failed) ? run : undefined
  return (
    <li
      className={css.lecture}
      data-transcriber-row="lecture"
      data-transcriber-transcribed={lecture.transcribed && !failed ? '' : undefined}
      data-transcriber-run-state={run?.status}
      data-transcriber-progress={run === undefined ? undefined : `${run.done.length}/${run.phases.length}`}
    >
      {failed
        ? <IconWarningOutline16 className={css.failed} />
        : lecture.transcribed
          ? <IconCheckOutline16 className={css.done} />
          : <IconClockOutline16 className={css.waiting} />}
      <span className={css.lectureTitle} title={lecture.title}>{lecture.title}</span>
      {lecture.sources.length > 1 && (
        <span className={css.parts}>{t('lecture.parts', { count: String(lecture.sources.length) })}</span>
      )}
      {progress !== undefined && <RunProgress run={progress} t={t} />}
    </li>
  )
}

/** One module's row, and its two sections while it is open. */
function Module({ module: view, open, onToggle, drop, t }: {
  module: ModuleView
  open: boolean
  onToggle: () => void
  drop?: TranscriberDropState
  t: TranslateNS<'transcriber'>
}): ReactNode {
  const { transcribed, failed, pending } = splitLectures(view.lectures, view.run)
  const lectureRun = (lecture: LectureUnit): TranscriberRun | undefined => runForLecture(view.run, lecture)
  return (
    <li data-transcriber-row="module" data-transcriber-module={view.id}>
      <button type="button" className={css.moduleRow} aria-expanded={open} onClick={onToggle}>
        {open ? <IconFolderOpen16 className={css.icon} /> : <IconFolderClose16 className={css.icon} />}
        <span className={css.moduleName} title={view.id}>{view.displayName}</span>
        <span className={css.count}>
          {t('module.lectureCount', { done: String(transcribed.length), total: String(view.lectures.length) })}
        </span>
      </button>
      <div className={css.dropTargets}>
        <DropTarget moduleId={view.id} destination="Lecture" t={t} />
        <DropTarget moduleId={view.id} destination="Questions" t={t} />
      </div>
      {drop?.kind === 'importing' && <p className={css.dropProgress} data-transcriber-row="import-result" role="status">{t('drop.importing')}</p>}
      {drop !== undefined && drop.kind !== 'importing' && <ImportOutcome state={drop} t={t} />}
      {view.notebookStatus === 'pending' && (
        <p className={css.note} role="status">{t('notebook.pending')}</p>
      )}
      {view.notebookStatus === 'failed' && (
        <p className={css.note} role="alert">
          {t('notebook.failed', { message: view.notebookWarning ?? '' })}
        </p>
      )}
      {view.notebookStatus === 'unavailable' && (
        <p className={css.note} role="status">{t('notebook.unavailable')}</p>
      )}
      {open && (
        <ul className={css.list}>
          {view.lectures.length === 0 && (
            <li className={css.note} data-transcriber-row="empty">{t('empty.lectures')}</li>
          )}
          {transcribed.length > 0 && (
            <li className={css.section} data-transcriber-section="transcribed">{t('section.transcribed')}</li>
          )}
          {transcribed.map(lecture => <Lecture key={lecture.title} lecture={lecture} run={lectureRun(lecture)} t={t} />)}
          {failed.length > 0 && (
            <li className={css.section} data-transcriber-section="failed">{t('section.failed')}</li>
          )}
          {failed.map(lecture => <Lecture key={lecture.title} lecture={lecture} run={lectureRun(lecture)} t={t} />)}
          {pending.length > 0 && (
            <li className={css.section} data-transcriber-section="pending">{t('section.pending')}</li>
          )}
          {pending.map(lecture => <Lecture key={lecture.title} lecture={lecture} run={lectureRun(lecture)} t={t} />)}
        </ul>
      )}
    </li>
  )
}

/** The panel's body: every module in the session's workspace. */
export function TranscriberBody({
  useTabInfo, sessionId, useSessions, useStore, start, refresh, watch, drop, actions, t,
}: TranscriberBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const panel = useStore(store => store.byTab[tab.id])
  const pollRuns = shouldPollRuns(panel, tab.visible)
  const wasVisible = useRef(false)
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (panel !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, signal)
  }, [panel, cwd, tab.id, signal, start])
  useEffect(() => {
    const opened = tab.visible && !wasVisible.current
    wasVisible.current = tab.visible
    if (!opened || cwd === undefined || panel === undefined || signal.aborted) return
    refresh(tab.id, signal)
  }, [cwd, panel, refresh, signal, tab.id, tab.visible])
  useEffect(() => {
    watch(tab.id, signal, cwd !== undefined && pollRuns)
    return () => { watch(tab.id, signal, false) }
  }, [cwd, pollRuns, signal, tab.id, watch])
  useEffect(() => listenForDesktopFileDrops((nativeDrop) => {
    const target = dropTargetAt(nativeDrop.position)
    const tabRoot = target?.closest<HTMLElement>('[data-transcriber-tab]')
    if (tabRoot?.dataset.transcriberTab !== String(tab.id)) return
    const moduleId = target?.dataset.transcriberDropModule
    const destination = target?.dataset.transcriberDropDestination
    if (moduleId === undefined || (destination !== 'Lecture' && destination !== 'Questions')) return
    drop(tab.id, signal, moduleId, destination, nativeDrop.paths)
  }), [drop, signal, tab.id])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-transcriber-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (panel === undefined) return null

  return (
    <div className={css.root} data-transcriber-state={panel.state.kind} data-transcriber-tab={String(tab.id)}>
      <div className={css.header}>
        <span className={css.headerLabel}>{t('type.label')}</span>
        <button
          type="button"
          className={css.tool}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { refresh(tab.id, signal) }}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      <div className={css.scroller}>
        {panel.state.kind === 'loading' && (
          <p className={css.note} data-transcriber-row="loading">{t('loading')}</p>
        )}
        {panel.state.kind === 'failed' && (
          <p className={css.note} data-transcriber-row="failed" data-transcriber-code={panel.state.failure.code}>
            {failureLine(t, panel.state.failure)}
          </p>
        )}
        {panel.state.kind === 'ready' && panel.state.modules.length === 0 && (
          <p className={css.note} data-transcriber-row="no-modules">{t('empty.modules')}</p>
        )}
        {panel.state.kind === 'ready' && (
          <ul className={css.list}>
            {panel.state.modules.map(view => (
              <Module
                key={view.id}
                module={view}
                open={!panel.collapsed.includes(view.id)}
                onToggle={() => { actions.toggled(tab.id, view.id) }}
                {...panel.drop?.moduleId === view.id ? { drop: panel.drop } : {}}
                t={t}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
