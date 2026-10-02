/**
 * Setting a library up from the library itself: which folder it lives in,
 * and a new module in it. Both used to need a terminal or a chat; a student
 * who installed the app had neither.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { moduleSlug, type FolderLevel, type LibrarySetup, type WorkspaceInfo } from '../editing.ts'
import type {} from '../locales.ts'
import css from './Setup.module.css'

/** The engine's rule for a module folder name. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/u

/**
 * The library folder as one line, with the way to change it. The path is
 * the one the engine last answered from, so it follows a change made
 * anywhere (the first-run step, this line) once the library is read again.
 * @param props.path - the folder the library was read from.
 * @param props.setup - the setup calls.
 * @param props.changed - read the library again after the folder changed.
 * @param props.t - translate.
 */
export function LibraryFolder({ path, setup, changed, t }: {
  readonly path: string | undefined
  readonly setup: LibrarySetup
  readonly changed: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [choosing, setChoosing] = useState(false)
  return (
    <p className={css.folderLine}>
      <span>{t('folder.line')}</span>
      {/* A path reads left to right inside Arabic copy. */}
      <bdi className={css.path} dir="ltr">{path ?? '…'}</bdi>
      <button type="button" className={css.link} onClick={() => { setChoosing(true) }}>{t('folder.change')}</button>
      {choosing && (
        <FolderDialog
          setup={setup}
          initial={path}
          close={() => { setChoosing(false) }}
          saved={() => {
            setChoosing(false)
            changed()
          }}
          t={t}
        />
      )}
    </p>
  )
}

/**
 * Choose the library folder: browse this machine's folders when the Host can
 * list them, or type the path.
 * @param props.setup - the setup calls.
 * @param props.initial - the folder in use now.
 * @param props.close - leave without changing anything.
 * @param props.saved - the folder was changed.
 * @param props.t - translate.
 */
export function FolderDialog({ setup, initial, close, saved, t }: {
  readonly setup: LibrarySetup
  readonly initial: string | undefined
  readonly close: () => void
  readonly saved: (info: WorkspaceInfo) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [path, setPath] = useState(initial ?? '')
  const [level, setLevel] = useState<FolderLevel | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const browse = (target: string | undefined): void => {
    if (setup.listFolder === undefined) return
    void setup.listFolder(target).then((answer) => {
      if (answer.ok) {
        setLevel(answer.value)
        setPath(answer.value.path)
      } else {
        setError(answer.message)
      }
    })
  }
  useEffect(() => {
    if (initial !== undefined) {
      browse(initial)
      return
    }
    // Opened without a folder in hand: start from the one in use now.
    void setup.workspace().then((answer) => {
      if (!answer.ok) return
      setPath(answer.value.path)
      browse(answer.value.path)
    })
  }, [])
  const save = (): void => {
    setSaving(true)
    setError(undefined)
    void setup.setWorkspace(path.trim(), true).then((answer) => {
      setSaving(false)
      if (answer.ok) saved(answer.value)
      else setError(answer.message)
    })
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('folder.title')}
      className={css.dialog}
      closeLabel={t('manage.editor.close')}
      footer={(
        <div className={css.footer}>
          <Button variant="ghost" onClick={close}>{t('manage.editor.cancel')}</Button>
          <Button variant="primary" disabled={saving || path.trim() === ''} onClick={save}>
            {saving ? t('manage.saving') : t('folder.use')}
          </Button>
        </div>
      )}
    >
      <div className={css.body}>
        <p className={css.lead}>{t('folder.lead')}</p>
        <Input dir="ltr" value={path} aria-label={t('folder.path')} onChange={(event) => { setPath(event.currentTarget.value) }} />
        {level !== undefined && (
          <ul className={css.folders} aria-label={t('folder.inside')}>
            {level.parent !== undefined && (
              <li>
                <button type="button" className={css.folder} onClick={() => { browse(level.parent) }}>{t('folder.up')}</button>
              </li>
            )}
            {level.folders.map(folder => (
              <li key={folder.path}>
                <button type="button" className={css.folder} dir="auto" onClick={() => { browse(folder.path) }}>{folder.name}</button>
              </li>
            ))}
            {level.folders.length === 0 && <li className={css.muted}>{t('folder.none')}</li>}
          </ul>
        )}
        {error !== undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}
      </div>
    </Modal>
  )
}

/**
 * Add a module: its name, and the folder name the engine files it under.
 * @param props.setup - the setup calls.
 * @param props.close - leave without creating anything.
 * @param props.created - the module exists; open it.
 * @param props.t - translate.
 */
export function AddModuleDialog({ setup, close, created, t }: {
  readonly setup: LibrarySetup
  readonly close: () => void
  readonly created: (id: string) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idTouched, setIdTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const folder = idTouched ? id : moduleSlug(name)
  const valid = name.trim() !== '' && SLUG.test(folder)
  const create = (): void => {
    setSaving(true)
    setError(undefined)
    void setup.createModule(folder, name.trim()).then((answer) => {
      setSaving(false)
      if (answer.ok) created(folder)
      else setError(answer.message)
    })
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('addModule.title')}
      className={css.dialog}
      closeLabel={t('manage.editor.close')}
      footer={(
        <div className={css.footer}>
          <Button variant="ghost" onClick={close}>{t('manage.editor.cancel')}</Button>
          <Button variant="primary" disabled={saving || !valid} onClick={create}>
            {saving ? t('addModule.creating') : t('addModule.create')}
          </Button>
        </div>
      )}
    >
      <div className={css.body}>
        <label className={css.field}>
          <span>{t('addModule.name')}</span>
          <Input dir="auto" value={name} placeholder={t('addModule.namePlaceholder')} onChange={(event) => { setName(event.currentTarget.value) }} />
        </label>
        <label className={css.field}>
          <span>{t('addModule.id')}</span>
          <Input
            dir="ltr"
            value={folder}
            onChange={(event) => {
              setIdTouched(true)
              setId(event.currentTarget.value.toLowerCase())
            }}
          />
        </label>
        <p className={css.muted}>{folder !== '' && !SLUG.test(folder) ? t('addModule.badId') : t('addModule.hint')}</p>
        {error !== undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}
      </div>
    </Modal>
  )
}
