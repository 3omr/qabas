/** The ordered, re-openable first-run frame for medical transcription. */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the Conversation hero SlotMap and current-session-optional
// standard props into this independently compiled occupant.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: supplies sessionId and inputActions for a session-maybe slot.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { FirstRunObservation, FirstRunSnapshot, FirstRunStepId } from './first-run.ts'
import { firstIncompleteStep, firstRunStepState, workspaceObservation } from './first-run.ts'
import type { TranscriberKey } from './locales.ts'
import css from './FirstRunGuide.module.css'

/** Callbacks and the live observation source owned by the transcriber plugin. */
export interface FirstRunInjected {
  readonly hooks: { readonly firstRun: { getSnapshot(): FirstRunSnapshot; subscribe(listener: () => void): () => void } }
  readonly refresh: () => void
  readonly openSettings: (section: 'models' | 'transcriber-engine') => void
  readonly openTranscriber: () => void
}

/** Props for the hero's optional first-run slot. */
export type FirstRunGuideProps =
  & PropsRuntime<'conversation.hero.firstRun'>
  & InjectFace<FirstRunInjected>
  & PropsLocale<'transcriber'>

const STEP_IDS: readonly FirstRunStepId[] = [
  'workspace', 'provider', 'readiness', 'notebook', 'module', 'files', 'sync', 'transcript',
]

type FirstRunCopyKey = Extract<TranscriberKey, `firstRun.${string}`>

const STEP_KEYS: Readonly<Record<FirstRunStepId, FirstRunCopyKey>> = {
  workspace: 'firstRun.step.workspace',
  provider: 'firstRun.step.provider',
  readiness: 'firstRun.step.readiness',
  notebook: 'firstRun.step.notebook',
  module: 'firstRun.step.module',
  files: 'firstRun.step.files',
  sync: 'firstRun.step.sync',
  transcript: 'firstRun.step.transcript',
}

function dotState(observation: FirstRunObservation, current: boolean): StateDotState {
  if (observation === 'complete') return 'done'
  if (observation === 'unknown') return 'warning'
  return current ? 'ongoing' : 'idle'
}

function statusKey(observation: FirstRunObservation, current: boolean): FirstRunCopyKey {
  if (observation === 'complete') return 'firstRun.status.done'
  if (observation === 'unknown') return 'firstRun.status.unknown'
  return current ? 'firstRun.status.next' : 'firstRun.status.waiting'
}

function draftFor(
  step: FirstRunStepId,
  snapshot: FirstRunSnapshot,
  moduleName: string,
  t: FirstRunGuideProps['t'],
): string | undefined {
  const selectedModule = moduleName.trim() || snapshot.moduleName
  if (selectedModule === undefined || selectedModule.trim() === '') return undefined
  if (step === 'sync') return t('firstRun.draft.sync', { module: selectedModule.trim() })
  if (step !== 'transcript' || snapshot.lectureTitle === undefined) return undefined
  return t('firstRun.draft.transcript', {
    lecture: snapshot.lectureTitle,
    module: selectedModule.trim(),
  })
}

function currentAction(
  step: FirstRunStepId,
  props: Pick<FirstRunGuideProps, 'inputActions' | 'openSettings' | 'openTranscriber' | 'sessionId' | 't'>,
  snapshot: FirstRunSnapshot,
  moduleName: string,
  setModuleName: (value: string) => void,
): ReactNode {
  const { inputActions, openSettings, openTranscriber, sessionId, t } = props
  if (step === 'workspace') return <p className={css.currentDescription}>{t('firstRun.current.workspace')}</p>
  if (step === 'provider') {
    return <Button size="sm" onClick={() => { openSettings('models') }}>{t('firstRun.action.openModels')}</Button>
  }
  if (step === 'readiness') {
    return <Button size="sm" onClick={() => { openSettings('transcriber-engine') }}>{t('firstRun.action.openReadiness')}</Button>
  }
  if (step === 'notebook') {
    return <Button size="sm" onClick={() => { openSettings('transcriber-engine') }}>{t('firstRun.action.openNotebook')}</Button>
  }
  if (step === 'module') {
    return (
      <div className={css.moduleForm}>
        <input
          className={css.moduleInput}
          dir="auto"
          value={moduleName}
          placeholder={t('firstRun.moduleNamePlaceholder')}
          aria-label={t('firstRun.moduleName')}
          onChange={(event) => { setModuleName(event.target.value) }}
        />
        <Button
          size="sm"
          disabled={inputActions === undefined || moduleName.trim() === ''}
          onClick={() => {
            if (inputActions !== undefined) inputActions.setDraft(t('firstRun.draft.createModule', { module: moduleName.trim() }))
          }}
        >
          {t('firstRun.action.createModule')}
        </Button>
      </div>
    )
  }
  if (step === 'files') {
    return (
      <Button size="sm" disabled={sessionId === undefined} onClick={openTranscriber}>
        {t('firstRun.action.openLectures')}
      </Button>
    )
  }
  const draft = draftFor(step, snapshot, moduleName, t)
  return (
    <>
      <p className={css.currentDescription}>
        {t(step === 'sync' ? 'firstRun.current.sync' : 'firstRun.current.transcript')}
      </p>
      <div className={css.currentActions}>
        <Button size="sm" disabled={inputActions === undefined || draft === undefined} onClick={() => {
          if (inputActions !== undefined && draft !== undefined) inputActions.setDraft(draft)
        }}>
          {t(step === 'sync' ? 'firstRun.action.prepareSync' : 'firstRun.action.prepareTranscript')}
        </Button>
      </div>
    </>
  )
}

function stepState(snapshot: FirstRunSnapshot, sessionId: SessionId | undefined, cwd: string | undefined) {
  return firstRunStepState(snapshot, workspaceObservation(sessionId, cwd))
}

/** Render the ordered first-run workflow without persisting completion state. */
export function FirstRunGuide({
  inputActions, openSettings, openTranscriber, refresh, sessionId, useFirstRun, useSessions, t,
}: FirstRunGuideProps): ReactNode {
  const snapshot = useFirstRun(state => state)
  const cwd = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId]?.cwd)
  const states = useMemo(() => stepState(snapshot, sessionId, cwd), [cwd, sessionId, snapshot])
  const current = firstIncompleteStep(states)
  const [hidden, setHidden] = useState(false)
  const [moduleName, setModuleName] = useState('')

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  if (hidden) {
    return (
      <div className={css.collapsed} data-first-run-collapsed="">
        <Button size="sm" variant="outline" onClick={() => { setHidden(false) }}>
          {t('firstRun.reopen')}
        </Button>
      </div>
    )
  }

  return (
    <section className={css.root} dir="rtl" data-first-run="" aria-label={t('firstRun.title')}>
      <div className={css.header}>
        <div>
          <h2 className={css.heading}>{t('firstRun.title')}</h2>
          <p className={css.description}>{t('firstRun.description')}</p>
        </div>
        <div className={css.headerActions}>
          <Button size="sm" variant="ghost" onClick={refresh}>{t('firstRun.refresh')}</Button>
          <Button size="sm" variant="outline" onClick={() => { setHidden(true) }}>{t('firstRun.skip')}</Button>
        </div>
      </div>
      <ol className={css.steps}>
        {/* Before a Session exists there is no workspace path to observe from,
            so every step after the first can only answer "cannot tell". Seven
            rows of that is noise, not information, and it reads as a broken
            setup to a student who has one. The list opens at the step they can
            actually act on and grows once there is something to look at. */}
        {(sessionId === undefined ? STEP_IDS.slice(0, 1) : STEP_IDS).map((step) => {
          const observation = states[step]
          const active = current === step
          return (
            <li
              key={step}
              className={`${css.step} ${active ? css.stepCurrent : ''}`}
              data-first-run-step={step}
              data-first-run-state={observation}
              aria-current={active ? 'step' : undefined}
            >
              <StateDot state={dotState(observation, active)} size={10} />
              <span className={css.stepLabel}>{t(STEP_KEYS[step])}</span>
              <span className={css.stepStatus}>{t(statusKey(observation, active))}</span>
            </li>
          )
        })}
      </ol>
      {current === undefined ? (
        <p className={css.completed}>{t('firstRun.completed')}</p>
      ) : (
        <div className={css.current} data-first-run-current={current}>
          {currentAction(current, {
            inputActions, openSettings, openTranscriber, sessionId, t,
          }, snapshot, moduleName, setModuleName)}
          {snapshot.loading && <p className={css.hint} role="status">{t('firstRun.loading')}</p>}
        </div>
      )}
    </section>
  )
}
