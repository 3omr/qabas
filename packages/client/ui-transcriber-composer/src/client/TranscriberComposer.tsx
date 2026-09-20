import { useEffect, useMemo } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { LectureUnit, ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TranscriberComposerInjected } from './face.ts'
import { sentenceFor, type ComposerAction } from './sentences.ts'
import type { createTranscriberComposerStore, TranscriberComposerState } from './store.ts'
import css from './TranscriberComposer.module.css'

/** Full props of the session-scoped composer strip. */
export type TranscriberComposerProps =
  & PropsRuntime<'conversation.input.dock'>
  & PropsStore<ReturnType<typeof createTranscriberComposerStore>>
  & TranscriberComposerInjected
  & PropsLocale<'transcriberComposer'>

function selectedModuleOf(state: TranscriberComposerState): ModuleView | undefined {
  return state.modules.find(module => module.id === state.moduleId)
}

function selectedLectureOf(state: TranscriberComposerState): LectureUnit | undefined {
  return selectedModuleOf(state)?.lectures.find(lecture => lecture.title === state.lectureTitle)
}

function actionDisabled(action: ComposerAction, module: ModuleView | undefined, lecture: LectureUnit | undefined): boolean {
  if (module === undefined) return true
  return (action === 'transcribe' || action === 'review') && lecture === undefined
}

function setDraftFor(
  action: ComposerAction,
  module: ModuleView | undefined,
  lecture: LectureUnit | undefined,
  inputActions: InputActions,
): void {
  if (module === undefined || actionDisabled(action, module, lecture)) return
  inputActions.setDraft(sentenceFor(action, module, lecture))
}

/** Render one shared-workspace choice strip above the resident composer. */
export function TranscriberComposer({ useStore, actions, start, inputActions, t }: TranscriberComposerProps): React.ReactNode {
  const state = useStore(snapshot => snapshot)
  useEffect(() => {
    const controller = new AbortController()
    start(controller.signal)
    return () => { controller.abort() }
  }, [start])

  const selectedModule = selectedModuleOf(state)
  const selectedLecture = selectedLectureOf(state)
  const actionLabels: readonly [ComposerAction, string][] = useMemo(() => [
    ['transcribe', t('action.transcribe')],
    ['review', t('action.review')],
    ['audit', t('action.audit')],
    ['readiness', t('action.readiness')],
  ], [t])

  return (
    <section className={css.root} dir="rtl" data-transcriber-composer="">
      <div className={css.title}>{t('title')}</div>
      {state.phase === 'loading' && <p className={css.note}>{t('loading')}</p>}
      {state.phase === 'failed' && <p className={css.note} role="alert">{t('error.read', { message: state.failure?.message ?? '' })}</p>}
      {state.phase === 'ready' && state.modules.length === 0 && <p className={css.note}>{t('empty.modules')}</p>}
      {state.phase === 'ready' && state.modules.length > 0 && (
        <>
          <label className={css.choiceRow}>
            <span className={css.label}>{t('module.label')}</span>
            <select
              className={css.select}
              aria-label={t('module.label')}
              value={state.moduleId ?? ''}
              onChange={(event) => { actions.selectModule(event.target.value) }}
            >
              <option value="">{t('module.placeholder')}</option>
              {state.modules.map(module => <option key={module.id} value={module.id}>{module.displayName}</option>)}
            </select>
          </label>
          {selectedModule !== undefined && (
            selectedModule.lectures.length === 0
              ? <p className={css.note}>{t('empty.lectures')}</p>
              : (
                <label className={css.choiceRow}>
                  <span className={css.label}>{t('lecture.label')}</span>
                  <select
                    className={css.select}
                    aria-label={t('lecture.label')}
                    value={state.lectureTitle ?? ''}
                    onChange={(event) => { actions.selectLecture(event.target.value) }}
                  >
                    <option value="">{t('lecture.placeholder')}</option>
                    {selectedModule.lectures.map(lecture => (
                      <option key={lecture.title} value={lecture.title}>
                        {lecture.title} — {lecture.transcribed ? t('status.transcribed') : t('status.waiting')}
                      </option>
                    ))}
                  </select>
                </label>
              )
          )}
          {selectedLecture !== undefined && selectedLecture.sources.length > 0 && (
            <ul className={css.sourceList} aria-label={t('source.label')}>
              {selectedLecture.sources.map(source => <li key={source.path} className={css.source} dir="ltr">{source.path}</li>)}
            </ul>
          )}
          <div className={css.actions} role="group" aria-label={t('actions.aria')}>
            {actionLabels.map(([action, label]) => (
              <button
                key={action}
                type="button"
                className={css.action}
                disabled={actionDisabled(action, selectedModule, selectedLecture)}
                onClick={() => { setDraftFor(action, selectedModule, selectedLecture, inputActions) }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
