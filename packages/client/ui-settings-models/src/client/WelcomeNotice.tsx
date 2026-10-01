/** Product-wide, versioned internal-testing notice. */

import { useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, SetupStage, SetupStageActions, type SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WelcomeNoticeState, WelcomeNoticeStore } from './welcome-store.ts'
import type { en } from './locales.ts'
import css from './WelcomeNotice.module.css'

/** Registration-side dependencies of {@link WelcomeNotice}. */
export interface WelcomeNoticeInjected {
  hooks: {
    /** Durable or process-local acknowledgement state. */
    welcome: SnapshotStore<WelcomeNoticeState>
  }
  /** Welcome acknowledgement controller. */
  controller: WelcomeNoticeStore
  /** Onboarding copy. */
  t: (key: keyof typeof en) => string
  /** This step's place in first-run setup. */
  progress?: SetupProgress | undefined
}

/** Coordinator owner props plus this step's injected face. */
export type WelcomeNoticeProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<WelcomeNoticeInjected>
  & Partial<PropsRenderSlots<'settings.onboarding.mark'>>

/**
 * Render the current notice until its exact copy version is acknowledged.
 * @param props - settings-shell owner state and welcome dependencies.
 * @returns the welcome modal or null while the step decides not to show.
 */
export function WelcomeNotice(props: WelcomeNoticeProps): ReactNode {
  const { complete, controller, useWelcome, t, progress, renderSlot } = props
  const state = useWelcome(snapshot => snapshot)
  const finished = useRef(false)
  const finish = useCallback((): void => {
    if (finished.current) return
    finished.current = true
    complete()
  }, [complete])

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (state.acknowledged) finish()
  }, [finish, state.acknowledged])

  if (state.status === 'idle' || state.status === 'loading' || state.acknowledged) return null

  const acknowledge = async (): Promise<void> => {
    if (await controller.acknowledge()) finish()
  }
  const paragraphs = t('welcomeBody').split('\n\n')

  // The first paragraph introduces the product; the rest is the testing
  // notice, set apart in the footer.
  const [lead, ...notes] = paragraphs
  return (
    <SetupStage
      label={t('welcomeTitle')}
      mark={renderSlot?.('settings.onboarding.mark', { size: 44 })}
      progress={progress}
      title={t('welcomeTitle')}
      lead={lead}
      footer={(
        <>
          <div className={css.copy}>
            {notes.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
            {state.error === null ? null : <p className={css.error} role="alert">{t('welcomeError')}</p>}
          </div>
          <SetupStageActions>
            <Button
              variant="primary"
              className={css.primary}
              disabled={state.status === 'saving'}
              onClick={() => { void acknowledge() }}
            >
              {t('welcomeContinue')}
            </Button>
          </SetupStageActions>
        </>
      )}
    />
  )
}
