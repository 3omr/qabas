/**
 * The readiness page as a first-run setup step: the same section, in the
 * setup frame, so a student installs the tools and connects NotebookLM before
 * the library ever needs them. Deployments that run a setup sequence enable
 * it with their step position; without one it is not registered.
 */
import type { ReactNode } from 'react'
import { Button, SetupStage, SetupStageActions, type SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TranscriberEngineSection, type TranscriberEngineSectionInjected } from './TranscriberEngineSection.tsx'
import type {} from './locales.ts'
import css from './TranscriberEngineSection.module.css'

/** What the step is handed besides its copy. */
export interface SetupStepInjected extends TranscriberEngineSectionInjected {
  readonly progress: SetupProgress | undefined
}

/** The step's props. */
export type SetupStepProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<SetupStepInjected> & PropsLocale<'settings.transcriberEngine'>

/**
 * The tools step.
 * @param props - owner share, injected face and copy.
 */
export function SetupStep(props: SetupStepProps): ReactNode {
  const { complete, engine, progress, t } = props
  return (
    <SetupStage
      label={t('setup.label')}
      progress={progress}
      eyebrow={t('setup.eyebrow')}
      title={t('setup.title')}
      lead={t('setup.lead')}
      footer={(
        <SetupStageActions>
          <Button variant="ghost" onClick={complete}>{t('setup.later')}</Button>
          <Button variant="primary" onClick={complete}>{t('setup.continue')}</Button>
        </SetupStageActions>
      )}
    >
      <div className={css.setupCard}>
        {/* Closing the section from inside setup means this step is done. */}
        <TranscriberEngineSection {...props} close={complete} engine={engine} t={t} />
      </div>
    </SetupStage>
  )
}
