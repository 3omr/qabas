/**
 * The last first-run step: where the student lands. The library has been
 * reading the workspace since the app opened; this step reports what it found
 * and opens it.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, SetupStage, SetupStageActions, type SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'
import css from './steps.module.css'

/** What the library step needs. */
export interface LibraryInjected {
  readonly progress: SetupProgress | undefined
  /** The workspace and how many modules it holds, once read. */
  readonly workspace: ObservableSnapshot<{ readonly path?: string; readonly modules?: number }>
  readonly openLibrary: () => void
  /** Move the library to another folder (made when missing). */
  readonly setFolder: (path: string) => Promise<{ readonly ok: boolean; readonly message?: string }>
  /** Whether the Host can move the library at all. */
  readonly canSetFolder: ObservableSnapshot<boolean>
}

/** The step's props. */
export type LibraryStepProps = PropsRuntime<'settings.onboarding'> & LibraryInjected & PropsLocale<'setup'>

/**
 * Where the student lands: the library, with what was found in the workspace.
 * @param props - owner share, injected face and copy.
 */
export function LibraryStep({ complete, progress, workspace, openLibrary, setFolder, canSetFolder, t }: LibraryStepProps): ReactNode {
  const found = useSyncExternalStore(workspace.subscribe.bind(workspace), workspace.getSnapshot.bind(workspace))
  const movable = useSyncExternalStore(canSetFolder.subscribe.bind(canSetFolder), canSetFolder.getSnapshot.bind(canSetFolder))
  const [editing, setEditing] = useState(false)
  const [typed, setTyped] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const lead = found.modules === undefined
    ? t('library.lead.reading')
    : found.modules === 0
      ? t('library.lead.empty')
      : t('library.lead.found', { count: String(found.modules) })
  const save = (): void => {
    setSaving(true)
    setError(undefined)
    void setFolder(typed.trim()).then((answer) => {
      setSaving(false)
      if (answer.ok) setEditing(false)
      else setError(answer.message)
    })
  }
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
    >
      <div className={css.folder}>
        <span className={css.folderLabel}>{t('library.folder')}</span>
        {/* A path reads left to right inside Arabic copy. */}
        <bdi className={css.path} dir="ltr">{found.path ?? '…'}</bdi>
        {movable && !editing && (
          <Button size="sm" variant="ghost" onClick={() => { setTyped(found.path ?? ''); setEditing(true) }}>{t('library.folder.change')}</Button>
        )}
      </div>
      {editing && (
        <div className={css.edit}>
          <Input dir="ltr" value={typed} aria-label={t('library.folder')} onChange={(event) => { setTyped(event.currentTarget.value) }} />
          <p className={css.hint}>{t('library.folder.hint')}</p>
          {error !== undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}
          <div className={css.editActions}>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false) }}>{t('library.folder.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={saving || typed.trim() === ''} onClick={save}>{t('library.folder.use')}</Button>
          </div>
        </div>
      )}
    </SetupStage>
  )
}
