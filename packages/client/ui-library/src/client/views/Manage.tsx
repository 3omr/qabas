/**
 * The module's lectures and files, in the student's hands: define a lecture
 * (title, recordings in part order, its slides and books), pin a guessed one,
 * forget a definition, add, rename or bin files, and send recordings to
 * NotebookLM. Every write goes through the engine; the page re-reads after it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  definitionProblem, kindOfName, moved, readableSize,
  type EditOutcome, type LectureDefinition, type LectureEditing, type ModuleFile,
} from '../editing.ts'
import { displayTitle, type LibraryLecture, type LibraryModule } from '../model.ts'
import type {} from '../locales.ts'
import css from './Manage.module.css'

type Files = { readonly status: 'loading' } | { readonly status: 'ready'; readonly files: readonly ModuleFile[] } | { readonly status: 'failed'; readonly message: string }

/** The lecture manager's props. */
export interface ManageViewProps {
  readonly module: LibraryModule
  readonly lectures: readonly LibraryLecture[]
  readonly editing: LectureEditing
  /** Read the module's lectures again after a change. */
  readonly changed: () => void
  /** Leave the manager. */
  readonly done: () => void
  readonly t: TranslateNS<'library'>
}

/**
 * The lecture manager.
 * @param props - see {@link ManageViewProps}.
 */
export function ManageView({ module, lectures, editing, changed, done, t }: ManageViewProps): ReactNode {
  const [files, setFiles] = useState<Files>({ status: 'loading' })
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [editingLecture, setEditingLecture] = useState<LectureDefinition | undefined>(undefined)

  const reload = useCallback(async (): Promise<void> => {
    const read = await editing.listFiles(module.id)
    setFiles(read.ok ? { status: 'ready', files: read.value } : { status: 'failed', message: read.message })
  }, [editing, module.id])
  useEffect(() => { void reload() }, [reload])

  /** Run one write, then re-read the files and the module's lectures. */
  const write = async <T,>(key: string, call: () => Promise<EditOutcome<T>>): Promise<boolean> => {
    setBusy(key)
    setError(undefined)
    try {
      const outcome = await call()
      if (!outcome.ok) {
        setError(outcome.message)
        return false
      }
      await reload()
      changed()
      return true
    } finally {
      setBusy(undefined)
    }
  }

  const list = files.status === 'ready' ? files.files : []
  const recordings = list.filter(file => file.kind === 'recording')
  const materials = list.filter(file => file.kind === 'material')
  const notUploaded = (lecture: LibraryLecture): readonly string[] =>
    lecture.sources.filter(name => recordings.some(file => file.name === name && !file.inNotebook))

  const importFiles = (picked: readonly File[]): void => {
    void (async () => {
      for (const file of picked) {
        const ok = await write(`import:${file.name}`, () => editing.importFile(module.id, file, kindOfName(file.name)))
        if (!ok) return
      }
    })()
  }

  return (
    <div className={css.manage}>
      <header className={css.head}>
        <div>
          <h2 className={css.title}>{t('manage.title')}</h2>
          <p className={css.hint}>{t('manage.hint')}</p>
        </div>
        <div className={css.headActions}>
          <Button variant="primary" onClick={() => { setEditingLecture({ title: '', recordings: [], materials: [] }) }}>
            {t('manage.new')}
          </Button>
          <Button variant="outline" onClick={done}>{t('manage.done')}</Button>
        </div>
      </header>

      {error !== undefined && editingLecture === undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}

      <section className={css.section} aria-labelledby="manage-lectures">
        <h3 id="manage-lectures" className={css.sectionTitle}>{t('manage.lectures')}</h3>
        <ul className={css.list}>
          {lectures.map((lecture) => {
            const pending = notUploaded(lecture)
            const manual = lecture.origin === 'manual'
            return (
              <li key={lecture.title} className={css.item} data-origin={lecture.origin ?? 'auto'}>
                <div className={css.itemMain}>
                  <span className={css.itemTitle} dir="auto">{displayTitle(lecture.title)}</span>
                  <span className={css.itemMeta} dir="auto">
                    <span className={clsx(css.badge, manual && css.badgeManual)}>
                      {t(manual ? 'manage.origin.manual' : 'manage.origin.auto')}
                    </span>
                    {lecture.sources.map(source => `⁨${source}⁩`).join(' · ')}
                  </span>
                </div>
                <div className={css.itemActions}>
                  {pending.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== undefined}
                      onClick={() => { void write(`upload:${lecture.title}`, () => editing.upload(module.id, pending)) }}
                    >
                      {busy === `upload:${lecture.title}` ? t('manage.uploading') : t('manage.upload', { count: String(pending.length) })}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingLecture({
                        ...lecture.id === undefined ? {} : { id: lecture.id },
                        title: lecture.title,
                        recordings: lecture.sources,
                        materials: lecture.materials ?? [],
                      })
                    }}
                  >
                    {t(manual ? 'manage.edit' : 'manage.pin')}
                  </Button>
                  {manual && lecture.id !== undefined && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== undefined}
                      onClick={() => {
                        if (window.confirm(t('manage.undefine.confirm', { title: displayTitle(lecture.title) }))) {
                          void write(`undefine:${lecture.title}`, () => editing.undefine(module.id, lecture.id as string))
                        }
                      }}
                    >
                      {t('manage.undefine')}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className={css.section} aria-labelledby="manage-files">
        <h3 id="manage-files" className={css.sectionTitle}>{t('manage.files')}</h3>
        <DropZone busy={busy !== undefined} onFiles={importFiles} t={t} />
        {files.status === 'loading' && <p className={css.hint} role="status">{t('loading')}</p>}
        {files.status === 'failed' && <p className={css.error} role="alert" dir="auto">{files.message}</p>}
        {files.status === 'ready' && (
          <ul className={css.list}>
            {list.map(file => (
              <FileRow
                key={file.path}
                file={file}
                busy={busy !== undefined}
                rename={name => write(`rename:${file.path}`, () => editing.renameFile(module.id, file.path, name))}
                trash={() => {
                  if (window.confirm(t('manage.trash.confirm', { name: file.name }))) {
                    void write(`trash:${file.path}`, () => editing.trashFile(module.id, file.path))
                  }
                }}
                t={t}
              />
            ))}
          </ul>
        )}
      </section>

      {editingLecture !== undefined && (
        <LectureEditor
          initial={editingLecture}
          recordings={recordings}
          materials={materials}
          saving={busy === 'define'}
          error={error}
          save={async (lecture) => {
            if (await write('define', () => editing.define(module.id, lecture))) setEditingLecture(undefined)
          }}
          close={() => { setEditingLecture(undefined) }}
          t={t}
        />
      )}
    </div>
  )
}

function DropZone({ busy, onFiles, t }: {
  readonly busy: boolean
  readonly onFiles: (files: readonly File[]) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setOver(false)
    if (!busy) onFiles([...event.dataTransfer.files])
  }
  return (
    <div
      className={clsx(css.drop, over && css.dropOver)}
      onDragOver={(event) => { event.preventDefault(); setOver(true) }}
      onDragLeave={() => { setOver(false) }}
      onDrop={drop}
    >
      <span>{t('manage.drop')}</span>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { input.current?.click() }}>{t('manage.add')}</Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={t('manage.add')}
        onChange={(event) => {
          onFiles([...event.currentTarget.files ?? []])
          event.currentTarget.value = ''
        }}
      />
    </div>
  )
}

function FileRow({ file, busy, rename, trash, t }: {
  readonly file: ModuleFile
  readonly busy: boolean
  readonly rename: (name: string) => Promise<boolean>
  readonly trash: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [naming, setNaming] = useState<string | undefined>(undefined)
  return (
    <li className={css.item} data-kind={file.kind}>
      <div className={css.itemMain}>
        {naming === undefined
          ? <span className={css.itemTitle} dir="auto">{file.name}</span>
          : (
            <form
              className={css.renameForm}
              onSubmit={(event) => {
                event.preventDefault()
                const name = naming.trim()
                if (name === '' || name === file.name) { setNaming(undefined); return }
                void rename(name).then((ok) => { if (ok) setNaming(undefined) })
              }}
            >
              <Input
                autoFocus
                dir="auto"
                aria-label={t('manage.rename')}
                value={naming}
                onChange={(event) => { setNaming(event.currentTarget.value) }}
                onKeyDown={(event) => { if (event.key === 'Escape') setNaming(undefined) }}
              />
              <Button size="sm" variant="primary" type="submit" disabled={busy}>{t('manage.save')}</Button>
            </form>
          )}
        <span className={css.itemMeta}>
          <span className={css.badge}>{t(`manage.kind.${file.kind}`)}</span>
          {file.size !== undefined && <span>{readableSize(file.size)}</span>}
          {file.lecture !== undefined && <span dir="auto">{t('manage.usedBy', { title: displayTitle(file.lecture) })}</span>}
          {file.kind === 'recording' && (
            <span className={clsx(css.notebook, file.inNotebook && css.notebookOn)}>
              {t(file.inNotebook ? 'manage.inNotebook' : 'manage.notInNotebook')}
            </span>
          )}
        </span>
      </div>
      {naming === undefined && (
        <div className={css.itemActions}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setNaming(file.name) }}>{t('manage.rename')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={trash}>{t('manage.trash')}</Button>
        </div>
      )}
    </li>
  )
}

function LectureEditor({ initial, recordings, materials, saving, error, save, close, t }: {
  readonly initial: LectureDefinition
  readonly recordings: readonly ModuleFile[]
  readonly materials: readonly ModuleFile[]
  readonly saving: boolean
  /** The engine's refusal of the last save, shown where the student is looking. */
  readonly error: string | undefined
  readonly save: (lecture: LectureDefinition) => Promise<void>
  readonly close: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [draft, setDraft] = useState<LectureDefinition>(initial)
  const [tried, setTried] = useState(false)
  const problem = definitionProblem(draft)
  const toggle = (key: 'recordings' | 'materials', name: string): void => {
    const list = draft[key]
    setDraft({ ...draft, [key]: list.includes(name) ? list.filter(item => item !== name) : [...list, name] })
  }
  return (
    <Modal
      open
      onClose={close}
      title={t(initial.id === undefined && initial.title === '' ? 'manage.editor.new' : 'manage.editor.edit')}
      closeLabel={t('manage.editor.close')}
      footer={(
        <div className={css.editorFooter}>
          {tried && problem !== undefined && <span className={css.error} role="alert">{t(`manage.problem.${problem}`)}</span>}
          {problem === undefined && error !== undefined && <span className={css.error} role="alert" dir="auto">{error}</span>}
          <Button variant="ghost" onClick={close}>{t('manage.editor.cancel')}</Button>
          <Button
            variant="primary"
            disabled={saving}
            onClick={() => {
              setTried(true)
              if (problem === undefined) void save({ ...draft, title: draft.title.trim() })
            }}
          >
            {saving ? t('manage.saving') : t('manage.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.editor}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manage.editor.title')}</span>
          <Input
            autoFocus
            dir="auto"
            value={draft.title}
            placeholder={t('manage.editor.titlePlaceholder')}
            onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }) }}
          />
        </label>

        <fieldset className={css.fieldset}>
          <legend className={css.fieldLabel}>{t('manage.editor.recordings')}</legend>
          <p className={css.hint}>{t('manage.editor.recordingsHint')}</p>
          {draft.recordings.length > 0 && (
            <ol className={css.order}>
              {draft.recordings.map((name, index) => (
                <li key={name} className={css.orderItem}>
                  <span className={css.part}>{t('manage.editor.part', { part: String(index + 1) })}</span>
                  <span className={css.orderName} dir="auto">{name}</span>
                  <button type="button" className={css.iconButton} aria-label={t('manage.editor.earlier')} disabled={index === 0} onClick={() => { setDraft({ ...draft, recordings: moved(draft.recordings, index, -1) }) }}>↑</button>
                  <button type="button" className={css.iconButton} aria-label={t('manage.editor.later')} disabled={index === draft.recordings.length - 1} onClick={() => { setDraft({ ...draft, recordings: moved(draft.recordings, index, 1) }) }}>↓</button>
                </li>
              ))}
            </ol>
          )}
          <div className={css.choices}>
            {recordings.map(file => (
              <label key={file.path} className={css.choice}>
                <input type="checkbox" checked={draft.recordings.includes(file.name)} onChange={() => { toggle('recordings', file.name) }} />
                <span dir="auto">{file.name}</span>
                {file.lecture !== undefined && file.lecture !== initial.title && (
                  <span className={css.taken} dir="auto">{t('manage.usedBy', { title: displayTitle(file.lecture) })}</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={css.fieldset}>
          <legend className={css.fieldLabel}>{t('manage.editor.materials')}</legend>
          <div className={css.choices}>
            {materials.map(file => (
              <label key={file.path} className={css.choice}>
                <input type="checkbox" checked={draft.materials.includes(file.name)} onChange={() => { toggle('materials', file.name) }} />
                <span dir="auto">{file.name}</span>
              </label>
            ))}
            {materials.length === 0 && <p className={css.hint}>{t('manage.editor.noMaterials')}</p>}
          </div>
        </fieldset>
      </div>
    </Modal>
  )
}
