/**
 * Setting a library up from the library itself: a new module in it, and the
 * one line saying where it lives. The folder is always ~/Qabas Library, so
 * there is nothing to choose; a module used to need a terminal or a chat.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { moduleSlug, type LibrarySetup } from '../editing.ts'
import type {} from '../locales.ts'
import css from './Setup.module.css'

/** The engine's rule for a module folder name. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/u

/**
 * Where the library lives, as one quiet line. It is fixed, so the line only
 * tells a student where to find their files.
 * @param props.path - the folder the library was read from.
 * @param props.t - translate.
 */
export function LibraryPath({ path, t }: {
  readonly path: string | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  return (
    <p className={css.folderLine}>
      <span>{t('folder.line')}</span>
      {/* A path reads left to right inside Arabic copy. */}
      <bdi className={css.path} dir="ltr">{path ?? '…'}</bdi>
    </p>
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
      className={clsx(css.dialog)}
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
