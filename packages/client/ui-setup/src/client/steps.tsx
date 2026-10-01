/**
 * The last first-run step: where the student lands. The library has been
 * reading the workspace since the app opened; this step reports what it found
 * and opens it.
 */
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, SetupStage, SetupStageActions, type SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/** What the library step needs. */
export interface LibraryInjected {
  readonly progress: SetupProgress | undefined
  /** The workspace and how many modules it holds, once read. */
  readonly workspace: ObservableSnapshot<{ readonly path?: string; readonly modules?: number }>
  readonly openLibrary: () => void
}

/** The step's props. */
export type LibraryStepProps = PropsRuntime<'settings.onboarding'> & LibraryInjected & PropsLocale<'setup'>

/**
 * Where the student lands: the library, with what was found in the workspace.
 * @param props - owner share, injected face and copy.
 */
export function LibraryStep({ complete, progress, workspace, openLibrary, t }: LibraryStepProps): ReactNode {
  const found = useSyncExternalStore(workspace.subscribe.bind(workspace), workspace.getSnapshot.bind(workspace))
  // A path reads left to right inside Arabic copy; isolated, its slashes stay put.
  const path = found.path === undefined ? '' : `\u2066${found.path}\u2069`
  const lead = found.modules === undefined
    ? t('library.lead.reading')
    : found.modules === 0
      ? t('library.lead.empty', { workspace: path })
      : t('library.lead.found', { workspace: path, count: String(found.modules) })
  return (
    <SetupStage
      label={t('library.label')}
      progress={progress}
      eyebrow={t('library.eyebrow')}
      title={t('library.title')}
      lead={<span dir="auto">{lead}</span>}
      footer={(
        <SetupStageActions>
          <Button
            variant="primary"
            onClick={() => {
              openLibrary()
              complete()
            }}
          >
            {t('library.open')}
          </Button>
        </SetupStageActions>
      )}
    />
  )
}
