/**
 * The transcriber panel's body: the workspace's modules, and inside each one
 * the lectures that are transcribed and the lectures still waiting.
 *
 * Everything the panel keeps lives in its store, keyed by tab; everything it
 * asks for goes through its injected face. The component itself only decides
 * what to draw: one row per module, and under an open module the two sections
 * a lecture can be in. A section with nothing in it is not drawn — an empty
 * "Waiting" heading says less than its absence does.
 *
 * Nothing here starts a transcription. The panel is the answer to "where do
 * things stand"; asking for a run is what the chat is for, and a tool that
 * writes to the user's study material should be fired from a sentence they
 * typed rather than a button they brushed past.
 */
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconClockOutline16, IconFolderClose16, IconFolderOpen16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriberInjected } from './face.ts'
import type { LectureUnit } from './lectures.ts'
import type {} from './locales.ts'
import type { createTranscriberStore } from './store.ts'
import type { ModuleView } from './workspace.ts'
import css from './TranscriberBody.module.css'

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

/** One module's lectures, split into the two standings the panel draws. */
export function splitLectures(lectures: readonly LectureUnit[]): {
  transcribed: LectureUnit[]
  pending: LectureUnit[]
} {
  return {
    transcribed: lectures.filter(lecture => lecture.transcribed),
    pending: lectures.filter(lecture => !lecture.transcribed),
  }
}

/** One lecture's row: its title, and the file count when it took more than one. */
function Lecture({ lecture, t }: { lecture: LectureUnit; t: TranslateNS<'transcriber'> }): ReactNode {
  return (
    <li
      className={css.lecture}
      data-transcriber-row="lecture"
      data-transcriber-transcribed={lecture.transcribed ? '' : undefined}
    >
      {lecture.transcribed
        ? <IconCheckOutline16 className={css.done} />
        : <IconClockOutline16 className={css.waiting} />}
      <span className={css.lectureTitle} title={lecture.title}>{lecture.title}</span>
      {lecture.sources.length > 1 && (
        <span className={css.parts}>{t('lecture.parts', { count: String(lecture.sources.length) })}</span>
      )}
    </li>
  )
}

/** One module's row, and its two sections while it is open. */
function Module({ module: view, open, onToggle, t }: {
  module: ModuleView
  open: boolean
  onToggle: () => void
  t: TranslateNS<'transcriber'>
}): ReactNode {
  const { transcribed, pending } = splitLectures(view.lectures)
  return (
    <li data-transcriber-row="module" data-transcriber-module={view.id}>
      <button type="button" className={css.moduleRow} aria-expanded={open} onClick={onToggle}>
        {open ? <IconFolderOpen16 className={css.icon} /> : <IconFolderClose16 className={css.icon} />}
        <span className={css.moduleName} title={view.id}>{view.displayName}</span>
        <span className={css.count}>
          {t('module.lectureCount', { done: String(transcribed.length), total: String(view.lectures.length) })}
        </span>
      </button>
      {open && (
        <ul className={css.list}>
          {view.lectures.length === 0 && (
            <li className={css.note} data-transcriber-row="empty">{t('empty.lectures')}</li>
          )}
          {transcribed.length > 0 && (
            <li className={css.section} data-transcriber-section="transcribed">{t('section.transcribed')}</li>
          )}
          {transcribed.map(lecture => <Lecture key={lecture.title} lecture={lecture} t={t} />)}
          {pending.length > 0 && (
            <li className={css.section} data-transcriber-section="pending">{t('section.pending')}</li>
          )}
          {pending.map(lecture => <Lecture key={lecture.title} lecture={lecture} t={t} />)}
        </ul>
      )}
    </li>
  )
}

/** The panel's body: every module in the session's workspace. */
export function TranscriberBody({
  useTabInfo, sessionId, useSessions, useStore, start, refresh, actions, t,
}: TranscriberBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const { signal } = tab
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const panel = useStore(store => store.byTab[tab.id])
  useEffect(() => {
    // A bucket gone because the record aborted must not be re-seeded by a
    // component that has not unmounted yet.
    if (panel !== undefined || cwd === undefined || signal.aborted) return
    start(tab.id, signal)
  }, [panel, cwd, tab.id, signal, start])

  if (cwd === undefined) {
    return (
      <div className={css.status} data-transcriber-state="no-workspace">
        <p className={css.statusLine}>{t('noWorkspace')}</p>
      </div>
    )
  }
  if (panel === undefined) return null

  return (
    <div className={css.root} data-transcriber-state={panel.state.kind}>
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
                t={t}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
