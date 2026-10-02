/**
 * The module's lectures and files, in the student's hands. Each lecture is a
 * card holding its recordings in part order and its slides and books; files
 * no lecture uses wait in a side column. A file moves by dragging it onto a
 * card (or picking the lecture from its menu), leaves a lecture by its ×, and
 * every change is a lecture definition the engine stores. The full file list,
 * with rename and bin, sits folded under the board.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  definitionOf, definitionProblem, kindOfName, moved, readableSize, withFile, withoutFile,
  type EditOutcome, type LectureDefinition, type LectureEditing, type ModuleFile, type ModuleFileKind,
} from '../editing.ts'
import { displayTitle, type LibraryLecture, type LibraryModule } from '../model.ts'
import type {} from '../locales.ts'
import css from './Manage.module.css'
import { ProposalReview, type ProposalState } from './Proposal.tsx'

type Files = { readonly status: 'loading' } | { readonly status: 'ready'; readonly files: readonly ModuleFile[] } | { readonly status: 'failed'; readonly message: string }

/** A file on the move: what it is and the lecture it leaves, if any. */
interface Carried {
  readonly name: string
  readonly kind: ModuleFileKind
  readonly from?: string
}

/** The drag payload's type; nothing outside this page reads it. */
const CARRIED = 'application/x-qabas-file'

function carry(event: DragEvent, file: Carried): void {
  event.dataTransfer.setData(CARRIED, JSON.stringify(file))
  event.dataTransfer.effectAllowed = 'move'
}

function carried(event: DragEvent): Carried | undefined {
  const raw = event.dataTransfer.getData(CARRIED)
  if (raw === '') return undefined
  try {
    const value = JSON.parse(raw) as Partial<Carried>
    if (typeof value.name !== 'string' || (value.kind !== 'recording' && value.kind !== 'material')) return undefined
    return { name: value.name, kind: value.kind, ...typeof value.from === 'string' ? { from: value.from } : {} }
  } catch {
    return undefined
  }
}

function carrying(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(CARRIED)
}

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
  const [proposal, setProposal] = useState<ProposalState | undefined>(undefined)

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
  const unassigned = list.filter(file => file.kind !== 'question' && file.lecture === undefined)
  const uploaded = (name: string): boolean | undefined => recordings.find(file => file.name === name)?.inNotebook
  const notUploaded = (lecture: LibraryLecture): readonly string[] =>
    lecture.sources.filter(name => uploaded(name) === false)

  const importFiles = (picked: readonly File[]): void => {
    void (async () => {
      for (const file of picked) {
        const ok = await write(`import:${file.name}`, () => editing.importFile(module.id, file, kindOfName(file.name)))
        if (!ok) return
      }
    })()
  }

  /** Save a lecture without one file; a lecture left with no recording is refused here, not by the engine. */
  const without = (lecture: LibraryLecture, name: string): LectureDefinition | string => {
    const next = withoutFile(definitionOf(lecture), name)
    return next.recordings.length === 0 ? t('manage.problem.lastRecording', { title: displayTitle(lecture.title) }) : next
  }

  const place = (file: Carried, to: LibraryLecture | undefined): void => {
    const from = file.from === undefined ? undefined : lectures.find(lecture => lecture.title === file.from)
    if (from?.title === to?.title) return
    void write(`place:${file.name}`, async (): Promise<EditOutcome<unknown>> => {
      // A manual lecture keeps its files until told otherwise, so leave it first;
      // a guessed one gives the file up as soon as a definition claims it.
      if (from !== undefined && (from.origin === 'manual' || to === undefined)) {
        const rest = without(from, file.name)
        if (typeof rest === 'string') return { ok: false, message: rest }
        const left = await editing.define(module.id, rest)
        if (!left.ok) return left
      }
      return to === undefined ? { ok: true, value: null } : editing.define(module.id, withFile(definitionOf(to), file))
    })
  }

  const propose = editing.propose === undefined || editing.applyProposal === undefined
    ? undefined
    : (refresh: boolean): void => {
      setProposal({ status: 'loading' })
      setError(undefined)
      void (editing.propose as NonNullable<LectureEditing['propose']>)(module.id, refresh).then((outcome) => {
        setProposal(outcome.ok ? { status: 'ready', value: outcome.value } : { status: 'failed', message: outcome.message })
      })
    }

  const remove = (lecture: LibraryLecture, name: string): void => {
    const rest = without(lecture, name)
    if (typeof rest === 'string') { setError(rest); return }
    void write(`remove:${name}`, () => editing.define(module.id, rest))
  }

  return (
    <div className={css.manage}>
      <header className={css.head}>
        <div>
          <h2 className={css.title}>{t('manage.title')}</h2>
          <p className={css.hint}>{t('manage.hint')}</p>
        </div>
        <div className={css.headActions}>
          {propose !== undefined && (
            <Button variant="primary" onClick={() => { propose(false) }}>{t('manage.organize')}</Button>
          )}
          <Button
            variant={propose === undefined ? 'primary' : 'outline'}
            onClick={() => { setEditingLecture({ title: '', recordings: [], materials: [] }) }}
          >
            {t('manage.new')}
          </Button>
          <Button variant="outline" onClick={done}>{t('manage.done')}</Button>
        </div>
      </header>

      {error !== undefined && editingLecture === undefined && proposal === undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}

      <div className={css.board}>
        <section className={css.lectures} aria-labelledby="manage-lectures">
          <h3 id="manage-lectures" className={css.sectionTitle}>
            {t('manage.lectures')}
            <span className={css.count}>{lectures.length}</span>
          </h3>
          <ul className={css.cards}>
            {lectures.map(lecture => (
              <LectureCard
                key={lecture.title}
                lecture={lecture}
                uploaded={uploaded}
                pending={notUploaded(lecture)}
                busy={busy}
                drop={(file) => { place(file, lecture) }}
                remove={(name) => { remove(lecture, name) }}
                upload={(pending) => { void write(`upload:${lecture.title}`, () => editing.upload(module.id, pending)) }}
                edit={() => { setEditingLecture(definitionOf(lecture)) }}
                undefine={() => {
                  if (lecture.id !== undefined && window.confirm(t('manage.undefine.confirm', { title: displayTitle(lecture.title) }))) {
                    void write(`undefine:${lecture.title}`, () => editing.undefine(module.id, lecture.id as string))
                  }
                }}
                t={t}
              />
            ))}
          </ul>
        </section>

        <Unassigned
          files={unassigned}
          loading={files.status === 'loading'}
          lectures={lectures}
          busy={busy !== undefined}
          place={place}
          importFiles={importFiles}
          t={t}
        />
      </div>

      <AllFiles
        files={files}
        busy={busy !== undefined}
        rename={(file, name) => write(`rename:${file.path}`, () => editing.renameFile(module.id, file.path, name))}
        trash={(file) => {
          if (window.confirm(t('manage.trash.confirm', { name: file.name }))) {
            void write(`trash:${file.path}`, () => editing.trashFile(module.id, file.path))
          }
        }}
        t={t}
      />

      {proposal !== undefined && propose !== undefined && (
        <ProposalReview
          state={proposal}
          saving={busy === 'organize'}
          error={error}
          again={() => { propose(true) }}
          save={(lectures) => {
            void write('organize', () => (editing.applyProposal as NonNullable<LectureEditing['applyProposal']>)(module.id, lectures, false))
              .then((ok) => { if (ok) setProposal(undefined) })
          }}
          close={() => { setProposal(undefined) }}
          t={t}
        />
      )}

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

/** Where a drop lands: highlights while a file hovers it. */
function useDropTarget(accept: (file: Carried) => void): {
  readonly over: boolean
  readonly handlers: {
    readonly onDragOver: (event: DragEvent) => void
    readonly onDragLeave: (event: DragEvent) => void
    readonly onDrop: (event: DragEvent) => void
  }
} {
  const [over, setOver] = useState(false)
  return {
    over,
    handlers: {
      onDragOver: (event) => {
        if (!carrying(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setOver(true)
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      },
      onDrop: (event) => {
        setOver(false)
        const file = carried(event)
        if (file === undefined) return
        event.preventDefault()
        accept(file)
      },
    },
  }
}

function LectureCard({ lecture, uploaded, pending, busy, drop, remove, upload, edit, undefine, t }: {
  readonly lecture: LibraryLecture
  readonly uploaded: (name: string) => boolean | undefined
  readonly pending: readonly string[]
  readonly busy: string | undefined
  readonly drop: (file: Carried) => void
  readonly remove: (name: string) => void
  readonly upload: (pending: readonly string[]) => void
  readonly edit: () => void
  readonly undefine: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const manual = lecture.origin === 'manual'
  const target = useDropTarget(drop)
  const materials = lecture.materials ?? []
  return (
    <li className={clsx(css.card, target.over && css.cardOver)} data-origin={lecture.origin ?? 'auto'} {...target.handlers}>
      <div className={css.cardHead}>
        <div className={css.cardTitleRow}>
          <span className={css.cardTitle} dir="auto">{displayTitle(lecture.title)}</span>
          <span className={clsx(css.badge, manual && css.badgeManual)}>
            {t(manual ? 'manage.origin.manual' : 'manage.origin.auto')}
          </span>
        </div>
        <div className={css.cardActions}>
          <Button size="sm" variant="ghost" onClick={edit}>{t(manual ? 'manage.edit' : 'manage.pin')}</Button>
          {manual && lecture.id !== undefined && (
            <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={undefine}>{t('manage.undefine')}</Button>
          )}
        </div>
      </div>

      <ol className={css.parts} aria-label={t('manage.editor.recordings')}>
        {lecture.sources.map((source, index) => {
          const inNotebook = uploaded(source)
          return (
            <li
              key={source}
              className={css.part}
              draggable
              onDragStart={(event) => { carry(event, { name: source, kind: 'recording', from: lecture.title }) }}
            >
              <span className={css.partNumber}>{t('manage.editor.part', { part: String(index + 1) })}</span>
              <span className={css.partName} dir="ltr" title={source}>{source}</span>
              {inNotebook !== undefined && (
                <span
                  className={clsx(css.dot, inNotebook && css.dotOn)}
                  role="img"
                  aria-label={t(inNotebook ? 'manage.inNotebook' : 'manage.notInNotebook')}
                  title={t(inNotebook ? 'manage.inNotebook' : 'manage.notInNotebook')}
                />
              )}
              <button
                type="button"
                className={css.remove}
                disabled={busy !== undefined}
                aria-label={t('manage.removeFrom', { name: source })}
                onClick={() => { remove(source) }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ol>

      {materials.length > 0 && (
        <ul className={css.materials} aria-label={t('manage.editor.materials')}>
          {materials.map(name => (
            <li
              key={name}
              className={css.material}
              draggable
              onDragStart={(event) => { carry(event, { name, kind: 'material', from: lecture.title }) }}
            >
              <span className={css.materialName} dir="ltr" title={name}>{name}</span>
              <button
                type="button"
                className={css.remove}
                disabled={busy !== undefined}
                aria-label={t('manage.removeFrom', { name })}
                onClick={() => { remove(name) }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <div className={css.cardFoot}>
          <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => { upload(pending) }}>
            {busy === `upload:${lecture.title}` ? t('manage.uploading') : t('manage.upload', { count: String(pending.length) })}
          </Button>
        </div>
      )}
      {target.over && <p className={css.dropHint}>{t('manage.dropOnLecture')}</p>}
    </li>
  )
}

function Unassigned({ files, loading, lectures, busy, place, importFiles, t }: {
  readonly files: readonly ModuleFile[]
  readonly loading: boolean
  readonly lectures: readonly LibraryLecture[]
  readonly busy: boolean
  readonly place: (file: Carried, to: LibraryLecture | undefined) => void
  readonly importFiles: (files: readonly File[]) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const target = useDropTarget((file) => { place(file, undefined) })
  return (
    <aside className={clsx(css.side, target.over && css.sideOver)} aria-labelledby="manage-unassigned" {...target.handlers}>
      <h3 id="manage-unassigned" className={css.sectionTitle}>
        {t('manage.unassigned')}
        <span className={css.count}>{files.length}</span>
      </h3>
      <p className={css.hint}>{t('manage.unassigned.hint')}</p>
      {loading && <p className={css.hint} role="status">{t('loading')}</p>}
      {!loading && files.length === 0 && <p className={css.empty}>{t('manage.unassigned.empty')}</p>}
      <ul className={css.loose}>
        {files.map(file => (
          <li
            key={file.path}
            className={css.looseFile}
            data-kind={file.kind}
            draggable
            onDragStart={(event) => { carry(event, { name: file.name, kind: file.kind }) }}
          >
            <span className={css.looseName} dir="ltr" title={file.name}>{file.name}</span>
            <span className={css.looseMeta}>
              <span>{t(`manage.kind.${file.kind}`)}</span>
              {file.size !== undefined && <span dir="ltr">{readableSize(file.size)}</span>}
            </span>
            {lectures.length > 0 && (
              <select
                className={css.assign}
                aria-label={t('manage.assign', { name: file.name })}
                disabled={busy}
                value=""
                onChange={(event) => {
                  const to = lectures.find(lecture => lecture.title === event.currentTarget.value)
                  if (to !== undefined) place({ name: file.name, kind: file.kind }, to)
                }}
              >
                <option value="" disabled>{t('manage.assign.placeholder')}</option>
                {lectures.map(lecture => <option key={lecture.title} value={lecture.title}>{displayTitle(lecture.title)}</option>)}
              </select>
            )}
          </li>
        ))}
      </ul>
      <DropZone busy={busy} onFiles={importFiles} t={t} />
    </aside>
  )
}

function AllFiles({ files, busy, rename, trash, t }: {
  readonly files: Files
  readonly busy: boolean
  readonly rename: (file: ModuleFile, name: string) => Promise<boolean>
  readonly trash: (file: ModuleFile) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const list = files.status === 'ready' ? files.files : []
  return (
    <section className={css.section} aria-labelledby="manage-files">
      <button
        id="manage-files"
        type="button"
        className={css.disclosure}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.chevron} data-open={open} aria-hidden>›</span>
        {t('manage.files')}
        <span className={css.count}>{list.length}</span>
      </button>
      {open && files.status === 'failed' && <p className={css.error} role="alert" dir="auto">{files.message}</p>}
      {open && files.status === 'ready' && (
        <ul className={css.list}>
          {list.map(file => (
            <FileRow
              key={file.path}
              file={file}
              busy={busy}
              rename={name => rename(file, name)}
              trash={() => { trash(file) }}
              t={t}
            />
          ))}
        </ul>
      )}
    </section>
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
    if (event.dataTransfer.files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    setOver(false)
    if (!busy) onFiles([...event.dataTransfer.files])
  }
  return (
    <div
      className={clsx(css.drop, over && css.dropOver)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setOver(true)
      }}
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
          {file.size !== undefined && <span dir="ltr">{readableSize(file.size)}</span>}
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
                  <span className={css.partNumber}>{t('manage.editor.part', { part: String(index + 1) })}</span>
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
