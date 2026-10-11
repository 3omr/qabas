/** Compact grouped lecture rows, ordered editing and reversible file management. */
import { useRef, useState, useId, useEffect } from 'react'
import type { DragEvent, ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal, Menu, IconEllipsisOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { StateBadge } from '../parts.tsx'
import { useInventory, useWrites, WriteFeedback, LoadingRows, useFileDrop, useIntake, UploadRows, useUndo } from './management.tsx'
import { IconMaterial, IconRecording } from '../icons.tsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  definitionOf, definitionProblem, kindOfName, moved, readableSize, withFile, withoutFile,
  type LectureDefinition, type LectureEditing, type ModuleFile, type ModuleFileKind,
} from '../editing.ts'
import { displayTitle, groupBySubject, type LibraryLecture, type LibraryModule, type LibrarySubject } from '../model.ts'
import type {} from '../locales.ts'
import css from './Manage.module.css'
import { ProposalReview, type ProposalState } from './Proposal.tsx'
import { PageHeader } from './PageHeader.tsx'
import { useConfirm } from './Confirm.tsx'

type Files = { readonly status: 'loading' } | { readonly status: 'ready'
  readonly files: readonly ModuleFile[] } | { readonly status: 'failed'
    readonly message: string }

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
  readonly t: TranslateNS<'library'>
  /** Optional grouped list inputs; omitted renders all lectures in one section. */
  readonly sections?: readonly { readonly id: string
    readonly title?: string
    readonly lectures: readonly LibraryLecture[] }[]
  /** The module's ordered subjects; lectures are grouped under them when present. */
  readonly subjects?: readonly LibrarySubject[]
}

/**
 * The lecture manager.
 * @param props - see {@link ManageViewProps}.
 */
export function ManageView({ module, lectures, editing, changed, t, sections, subjects = [] }: ManageViewProps): ReactNode {
  const setGeneralMaterials = editing.setGeneral?.bind(editing)
  const proposeOrganization = editing.propose?.bind(editing)
  const applyOrganization = editing.applyProposal?.bind(editing)
  const hideLecture = editing.hideLecture?.bind(editing)
  const restoreRecordings = editing.restoreRecordings?.bind(editing)
  const restoreTrash = editing.restoreTrash?.bind(editing)
  const inventory = useInventory(editing, module.id)
  const writes = useWrites(async () => { await inventory.reload()
    changed() })
  const confirm = useConfirm(t)
  const undo = useUndo(t)
  const input = useRef<HTMLInputElement>(null)
  const [editingLecture, setEditingLecture] = useState<LectureDefinition>()
  const [proposal, setProposal] = useState<ProposalState>()
  const [editorError, setEditorError] = useState<string>()
  const [addingSubject, setAddingSubject] = useState(false)
  const [menu, setMenu] = useState(false)
  const createSubject = editing.createSubject?.bind(editing)
  const renameSubject = editing.renameSubject?.bind(editing)
  const deleteSubject = editing.deleteSubject?.bind(editing)
  const setLectureSubject = editing.setLectureSubject?.bind(editing)
  const list = inventory.files.filter(file => !file.hidden && file.kind !== 'question')
  const files: Files = inventory.loading ? { status: 'loading' } : { status: 'ready', files: list }
  const recordings = list.filter(file => file.kind === 'recording')
  const materials = list.filter(file => file.kind === 'material')
  const general = list.filter(file => file.general)
  const used = new Set(lectures.flatMap(lecture => [...lecture.sources, ...lecture.materials ?? []]))
  const unassigned = list.filter(file => !file.lecture && !file.general && !used.has(file.name))
  const intake = useIntake(editing, module.id, file => kindOfName(file.name), (file) => { inventory.imported(file)
    changed() })
  const drop = useFileDrop(intake.add)
  const keyOf = (lecture: LibraryLecture): string => `lecture:${lecture.id ?? lecture.title}`
  const save = async (key: string, definition: LectureDefinition): Promise<boolean> => {
    const result = await writes.run(key, () => editing.define(module.id, definition))
    return result?.ok === true
  }
  const place = (file: Carried, to: LibraryLecture | undefined): void => {
    const from = lectures.find(lecture => lecture.title === file.from)
    if (from?.title === to?.title) return
    void writes.run<unknown>(from === undefined ? to === undefined ? file.name : keyOf(to) : keyOf(from), async () => {
      if (from !== undefined) {
        const rest = withoutFile(definitionOf(from), file.name)
        if (rest.recordings.length === 0) return { ok: false, message: t('manage.problem.lastRecording', { title: from.title }) }
        const left = await editing.define(module.id, rest)
        if (!left.ok) return left
      }
      return to === undefined ? { ok: true, value: null } : editing.define(module.id, withFile(definitionOf(to), file))
    }, [`file:Lecture/${file.name}`, ...to === undefined ? [] : [keyOf(to)]])
  }
  const setGeneral = setGeneralMaterials === undefined ? undefined : (names: readonly string[]): void => {
    void writes.run('general', () => setGeneralMaterials(module.id, names))
  }
  const trash = (file: ModuleFile, key = `file:${file.path}`): void => {
    void confirm.ask({ title: t('manage.trash.title'), body: t('manage.trash.confirm', { name: file.name }), confirm: t('manage.trash'), danger: true }).then(async (yes) => {
      if (!yes) return
      const result = await writes.run(key, () => editing.trashFile(module.id, file.path), key === `file:${file.path}` ? [] : [`file:${file.path}`])
      const restore = restoreTrash
      if (result?.ok && result.value?.id !== undefined && restore !== undefined) {
        const id = result.value.id
        undo.show(async () => { const restored = await restore(module.id, id)
          if (restored.ok) { await inventory.reload()
            changed() }
          return restored })
      }
    })
  }
  const propose = proposeOrganization === undefined || applyOrganization === undefined ? undefined : (refresh: boolean): void => {
    setProposal({ status: 'loading' })
    void writes.run('proposal', () => proposeOrganization(module.id, refresh)).then((result) => {
      if (result !== undefined) setProposal(result.ok ? { status: 'ready', value: result.value } : { status: 'failed', message: result.message })
    })
  }
  const groups: readonly {
    readonly id: string
    readonly title?: string
    readonly subject?: LibrarySubject
    readonly lectures: readonly LibraryLecture[]
  }[] = sections ?? (subjects.length === 0
    ? [{ id: 'lectures', lectures }]
    : groupBySubject(lectures, subjects).map(group => ({
      id: group.subject === undefined ? 'unassigned' : `subject:${group.subject.id}`,
      title: group.subject?.title ?? t('subjects.none'), ...group.subject === undefined ? {} : { subject: group.subject },
      lectures: group.lectures })))
  // A defined lecture moves by id; an automatic one is pinned with its subject in one definition.
  const moveTo = (lecture: LibraryLecture, subject: string | null): void => {
    const key = keyOf(lecture)
    void writes.run(key, () => lecture.id !== undefined && setLectureSubject !== undefined
      ? setLectureSubject(module.id, lecture.id, subject)
      : editing.define(module.id, { ...definitionOf(lecture), subject }))
  }
  const removeSubject = (subject: LibrarySubject): void => {
    if (deleteSubject === undefined) return
    void confirm.ask({ title: t('subjects.delete.title'), body: t('subjects.delete.confirm', { title: subject.title }), confirm: t('subjects.delete'), danger: true }).then((yes) => {
      if (yes) void writes.run(`subject:${subject.id}`, () => deleteSubject(module.id, subject.id))
    })
  }
  return <div className={css.manage} {...drop.handlers}>
    <PageHeader title={t('manage.title')} facts={t('home.fact.lectures', { count: String(lectures.length) })}>
      <Button variant="primary" onClick={() => { setEditorError(undefined)
        setEditingLecture({ title: '', recordings: [], materials: [] }) }}>{t('manage.new')}</Button>
      <Menu open={menu} autoFocus portal align="end" items={[
        { id: 'add', label: t('manage.add') },
        ...createSubject === undefined ? [] : [{ id: 'subject', label: t('subjects.add') }],
        ...propose === undefined ? [] : [{ id: 'organize', label: t('manage.organize'), disabled: writes.pending.has('proposal') }],
      ]} onSelect={(action) => { setMenu(false)
        if (action === 'add') input.current?.click()
        if (action === 'subject') setAddingSubject(true)
        if (action === 'organize') propose?.(false) }} onClose={() => { setMenu(false) }}
      anchor={<button type="button" className={css.pageMenu} aria-haspopup="menu" aria-expanded={menu} aria-label={t('manage.pageMenu')}
        onClick={() => { setMenu(!menu) }}><IconEllipsisOutline16 /></button>} />
    </PageHeader>
    {addingSubject && createSubject !== undefined && <SubjectNameForm label={t('subjects.add')} busy={writes.pending.has('subject:new')}
      save={async (title) => { const result = await writes.run('subject:new', () => createSubject(module.id, title))
        if (result?.ok) setAddingSubject(false)
        return result?.ok === true }}
      cancel={() => { setAddingSubject(false) }} t={t} />}
    <WriteFeedback pending={writes.pending.has('subject:new')} feedback={writes.feedback.get('subject:new')} t={t} />
    <input ref={input} hidden type="file" multiple aria-label={t('manage.add')} onChange={(event) => { intake.add([...event.currentTarget.files ?? []])
      event.currentTarget.value = '' }} />
    {drop.over && <div className={css.dropOverlay} role="status">{t('manage.drop')}</div>}
    <UploadRows intake={intake} t={t} />
    {inventory.refreshing && !inventory.loading && <span role="status">{t('management.refreshing')}</span>}
    {inventory.error !== undefined && <div role="alert"><span dir="auto">{inventory.error}</span><Button variant="ghost" onClick={() => { void inventory.reload() }}>{t('retry')}</Button></div>}
    {inventory.loading ? <LoadingRows t={t} /> : <>
      {unassigned.length > 0 && <Unassigned files={unassigned} loading={false} lectures={lectures} busy={false} place={place}
        importFiles={intake.add}
        {...setGeneral === undefined ? {} : {
          makeGeneral: (name: string) => { setGeneral([...general.map(file => file.name), name]) },
        }} t={t} />}
      {groups.map(group => <section key={group.id} className={css.lectures} aria-label={group.title ?? t('manage.lectures')}>
        <SubjectHeading title={group.title ?? t('manage.lectures')} count={group.lectures.length}
          busy={group.subject !== undefined && writes.pending.has(`subject:${group.subject.id}`)}
          {...group.subject === undefined || renameSubject === undefined ? {} : { rename: async (title: string) => {
            const subject = group.subject as LibrarySubject
            const result = await writes.run(`subject:${subject.id}`, () => renameSubject(module.id, subject.id, title))
            return result?.ok === true } }}
          {...group.subject === undefined || deleteSubject === undefined ? {} : {
            remove: () => { removeSubject(group.subject as LibrarySubject) } }}
          t={t} />
        {group.subject !== undefined && <WriteFeedback pending={writes.pending.has(`subject:${group.subject.id}`)} feedback={writes.feedback.get(`subject:${group.subject.id}`)} t={t} />}
        {group.lectures.length === 0 && <p className={css.hint}>{t('subjects.empty')}</p>}
        <ul className={css.cards}>{group.lectures.map((lecture) => {
          const key = keyOf(lecture)
          return <LectureCard key={lecture.id ?? lecture.title} lecture={lecture}
            uploaded={name => recordings.find(file => file.name === name)?.inNotebook}
            pending={lecture.sources.filter(name => recordings.find(file => file.name === name)?.inNotebook === false)}
            busy={writes.pending.has(key) ? key : undefined} drop={(file) => { place(file, lecture) }}
            remove={(name) => { place({ name, kind: recordings.some(file => file.name === name) ? 'recording' : 'material', from: lecture.title }, undefined) }}
            rename={title => save(key, { ...definitionOf(lecture), title })}
            subjects={subjects}
            {...subjects.length === 0 ? {} : { move: (subject: string | null) => { moveTo(lecture, subject) } }}
            upload={(names) => { void writes.run(key, () => editing.upload(module.id, names)) }}
            {...hideLecture === undefined ? {} : { hide: () => {
              void confirm.ask({ title: t('manage.hide.title'), body: t('manage.hide.confirm', { title: lecture.title }), confirm: t('management.hide') }).then(async (yes) => {
                if (!yes) return
                const result = await writes.run(key, () => hideLecture(module.id, lecture.id ?? lecture.title))
                if (result?.ok && restoreRecordings !== undefined) {
                  const names = result.value
                  undo.show(async () => { const restored = await restoreRecordings(module.id, names)
                    if (restored.ok) { await inventory.reload()
                      changed() }
                    return restored })
                }
              })
            } }} t={t} feedback={<WriteFeedback pending={writes.pending.has(key)} feedback={writes.feedback.get(key)} t={t} />} />
        })}</ul>
      </section>)}
      {setGeneral !== undefined && <details className={css.section}><summary>{t('manage.general')} · {general.length}</summary>
        <GeneralSources files={general} busy={writes.pending.has('general')} add={(name) => { if (!general.some(file => file.name === name)) setGeneral([...general.map(file => file.name), name]) }} remove={(name) => { setGeneral(general.map(file => file.name).filter(item => item !== name)) }} t={t} />
        <WriteFeedback pending={writes.pending.has('general')} feedback={writes.feedback.get('general')} t={t} />
      </details>}
      <AllFiles files={files} pending={writes.pending} feedback={writes.feedback} rename={(file, name) => writes.run(`file:${file.path}`, () => editing.renameFile(module.id, file.path, name)).then(result => result?.ok === true)} trash={(file) => { trash(file) }} t={t} />
    </>}
    {proposal !== undefined && propose !== undefined && <ProposalReview state={proposal} saving={writes.pending.has('organize')} error={writes.feedback.get('organize')?.error} again={() => { propose(true) }} close={() => { setProposal(undefined) }}
      save={(chosen, chosenGeneral) => {
        void writes.run('organize', () => (applyOrganization as NonNullable<LectureEditing['applyProposal']>)(
          module.id, chosen, false, chosenGeneral,
        )).then((result) => { if (result?.ok) setProposal(undefined) })
      }} t={t} />}
    {editingLecture !== undefined && <LectureEditor initial={editingLecture} subjects={subjects}
      recordings={recordings.filter(file => editingLecture.recordings.includes(file.name) || (!file.lecture && !used.has(file.name)))}
      materials={materials.filter(file => editingLecture.materials.includes(file.name) || (!file.lecture && !file.general && !used.has(file.name)))} saving={writes.pending.has('editor')} error={editorError}
      save={async (definition) => { const result = await writes.run('editor', () => editing.define(module.id, definition),
        editingLecture.title === '' ? [] : [`lecture:${editingLecture.id ?? editingLecture.title}`])
      if (result?.ok) setEditingLecture(undefined)
      else if (result !== undefined) setEditorError(result.message) }}
      close={() => { if (!writes.pending.has('editor')) setEditingLecture(undefined) }}
      {...editingLecture.id === undefined ? {} : { reset: () => {
        void confirm.ask({ title: t('manage.undefine.title'), body: t('manage.undefine.confirm', { title: editingLecture.title }), confirm: t('manage.undefine.button') }).then(async (yes) => {
          if (yes && (await writes.run('editor', () => editing.undefine(module.id, editingLecture.id as string)))?.ok) setEditingLecture(undefined)
        })
      } }} t={t} />}
    {confirm.dialog}{undo.toast}
  </div>
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

function LectureCard({
  lecture, uploaded, pending, busy, drop, remove, rename, upload, hide, feedback, t, subjects = [], move,
}: {
  readonly lecture: LibraryLecture
  readonly subjects?: readonly LibrarySubject[]
  /** Move the lecture to a subject, or out of its subject with null. */
  readonly move?: ((subject: string | null) => void) | undefined
  readonly uploaded: (name: string) => boolean | undefined
  readonly pending: readonly string[]
  readonly busy: string | undefined
  readonly drop: (file: Carried) => void
  readonly remove: (name: string) => void
  readonly rename: (title: string) => Promise<boolean>
  readonly upload: (names: readonly string[]) => void
  readonly hide?: (() => void) | undefined
  readonly feedback: ReactNode
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const [name, setName] = useState<string>()
  const [savedTitle, setSavedTitle] = useState<string>()
  useEffect(() => { setSavedTitle(undefined) }, [lecture.title])
  const target = useDropTarget(drop)
  const id = useId()
  const title = savedTitle ?? displayTitle(lecture.title)
  return <li className={clsx(css.card, target.over && css.cardOver)} data-origin={lecture.origin ?? 'auto'} {...target.handlers}>
    <div className={css.cardHead}>
      <div className={css.cardTitleRow}>
        {name === undefined ? <button type="button" className={css.expand} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(!open) }}><span aria-hidden>{open ? '⌄' : '›'}</span><bdi>{title}</bdi></button>
          : <form className={css.renameForm} onSubmit={(event) => { event.preventDefault()
            if (name.trim() !== '') void rename(name.trim()).then((ok) => { if (ok) { setSavedTitle(name.trim())
              setName(undefined) } }) }}>
            <Input autoFocus dir="auto" value={name} aria-label={t('manage.editor.title')} disabled={busy !== undefined} onChange={(event) => { setName(event.currentTarget.value) }} onKeyDown={(event) => { if (event.key === 'Escape') setName(undefined) }} />
            <Button size="sm" type="submit" disabled={busy !== undefined || name.trim() === ''}>{t('manage.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setName(undefined) }}>{t('manage.editor.cancel')}</Button>
          </form>}
        <span className={css.counts} aria-label={t('management.counts', { recordings: lecture.sources.length, materials: lecture.materials?.length ?? 0 })}>
          <span aria-hidden><IconRecording />{lecture.sources.length}</span>
          {(lecture.materials?.length ?? 0) > 0 && <span aria-hidden><IconMaterial />{lecture.materials?.length}</span>}
        </span>
        <StateBadge state={lecture.state} t={t} />
      </div>
      <Menu open={menu} autoFocus portal align="end" onClose={() => { setMenu(false) }} items={[
        { id: 'rename', label: t('manage.rename') },
        ...move === undefined ? [] : subjects.filter(subject => subject.id !== lecture.subject)
          .map(subject => ({ id: `move:${subject.id}`, label: t('subjects.moveTo', { title: subject.title }) })),
        ...move === undefined || lecture.subject === undefined ? [] : [{ id: 'move:', label: t('subjects.moveOut') }],
        ...hide === undefined ? [] : [{ id: 'hide', label: t('management.hide') }],
      ]} onSelect={(action) => { setMenu(false)
        if (action === 'rename') setName(title)
        if (action.startsWith('move:')) move?.(action.slice(5) === '' ? null : action.slice(5))
        if (action === 'hide') hide?.() }}
      anchor={<button type="button" className={css.iconButton} disabled={busy !== undefined} aria-label={t('management.more', { title })} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(!menu) }}><IconEllipsisOutline16 /></button>} />
    </div>
    {feedback}
    {open && <div id={id}>
      <ol className={css.parts}>{[...lecture.sources, ...lecture.materials ?? []].map((source, index) => <li
        key={source} className={css.fileRow}
        draggable={!busy}
        onDragStart={(event) => {
          carry(event, { name: source, kind: lecture.sources.includes(source) ? 'recording' : 'material', from: lecture.title })
        }}>
        {lecture.sources.includes(source)
          ? <><IconRecording aria-hidden /><span className={css.partNumber}>{index + 1}</span></>
          : <IconMaterial aria-hidden />}

        <bdi className={css.fileRowName}>{source}</bdi>
        {uploaded(source) !== undefined && <span className={css.hint}>{t(uploaded(source) ? 'manage.inNotebook' : 'manage.notInNotebook')}</span>}
        <Button size="sm" variant="ghost" disabled={busy !== undefined} onClick={() => { remove(source) }}>{t('management.unassign')}</Button>
      </li>)}</ol>
      {pending.length > 0 && <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => { upload(pending) }}>{t('manage.upload', { count: String(pending.length) })}</Button>}
    </div>}
    {target.over && <p className={css.dropHint}>{t('manage.dropOnLecture')}</p>}
  </li>
}

function Unassigned({ files, loading, lectures, busy, place, makeGeneral, t }: {
  readonly files: readonly ModuleFile[]
  readonly loading: boolean
  readonly lectures: readonly LibraryLecture[]
  readonly busy: boolean
  readonly place: (file: Carried, to: LibraryLecture | undefined) => void
  /** File a material as a source for the whole module. */
  readonly makeGeneral?: ((name: string) => void) | undefined
  readonly importFiles: (files: readonly File[]) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const target = useDropTarget((file) => { place(file, undefined) })
  return (
    <aside className={clsx(css.side, target.over && css.sideOver)} aria-labelledby="manage-unassigned" {...target.handlers}>
      <div className={css.sideHead}>
        <span className={css.sideIcon} aria-hidden><IconRecording /></span>
        <h3 id="manage-unassigned" className={css.sectionTitle}>{t('manage.unassigned')}</h3>
        <span className={css.count}>{files.length}</span>
      </div>
      <p className={css.hint}>{t('manage.unassigned.hint')}</p>
      {loading && <p className={css.hint} role="status">{t('loading')}</p>}
      {!loading && files.length === 0 && <p className={css.empty}>{t('manage.unassigned.empty')}</p>}
      <ul className={css.loose}>
        {files.map(file => (
          <li
            key={file.path}
            className={clsx(css.fileRow, css.fileRowWrap)}
            data-kind={file.kind}
            draggable
            onDragStart={(event) => { carry(event, { name: file.name, kind: file.kind }) }}
          >
            {file.kind === 'recording' ? <IconRecording aria-hidden /> : <IconMaterial aria-hidden />}
            <span className={css.fileRowName} dir="auto" title={file.name}>{file.name}</span>
            <span className={css.looseMeta}>
              <span>{t(`manage.kind.${file.kind}`)}</span>
              {file.size !== undefined && <span dir="ltr">{readableSize(file.size)}</span>}
            </span>
            {(lectures.length > 0 || (makeGeneral !== undefined && file.kind === 'material')) && (
              <select
                className={css.assign}
                aria-label={t('manage.assign', { name: file.name })}
                disabled={busy}
                value=""
                onChange={(event) => {
                  if (event.currentTarget.value === GENERAL && makeGeneral !== undefined) {
                    makeGeneral(file.name)
                    return
                  }
                  const to = lectures.find(lecture => lecture.title === event.currentTarget.value)
                  if (to !== undefined) place({ name: file.name, kind: file.kind }, to)
                }}
              >
                <option value="" disabled>{t('manage.assign.placeholder')}</option>
                {makeGeneral !== undefined && file.kind === 'material' && <option value={GENERAL}>{t('manage.general.option')}</option>}
                {lectures.map(lecture => <option key={lecture.title} value={lecture.title}>{displayTitle(lecture.title)}</option>)}
              </select>
            )}
          </li>
        ))}
      </ul>

    </aside>
  )
}

/** The assign menu's value for "the whole module"; no lecture title starts with NUL. */
const GENERAL = '\u0000general'

/**
 * The module's own books and references: dropped here (or picked from a
 * file's menu) they serve every lecture and stop waiting as unassigned.
 */
function GeneralSources({ files, busy, add, remove, t }: {
  readonly files: readonly ModuleFile[]
  readonly busy: boolean
  readonly add: (name: string) => void
  readonly remove: (name: string) => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const target = useDropTarget((file) => { if (file.kind === 'material') add(file.name) })
  return (
    <section className={clsx(css.side, target.over && css.sideOver)} aria-labelledby="manage-general" {...target.handlers}>
      <div className={css.sideHead}>
        <span className={css.sideIcon} aria-hidden><IconMaterial /></span>
        <h3 id="manage-general" className={css.sectionTitle}>{t('manage.general')}</h3>
        <span className={css.count}>{files.length}</span>
      </div>
      <p className={css.hint}>{t('manage.general.hint')}</p>
      {files.length > 0 && (
        <ul className={css.loose}>
          {files.map(file => (
            <li
              key={file.path}
              className={css.fileRow}
              draggable
              onDragStart={(event) => { carry(event, { name: file.name, kind: 'material' }) }}
            >
              <IconMaterial aria-hidden />
              <span className={css.fileRowName} dir="auto" title={file.name}>{file.name}</span>
              <Button size="sm" variant="ghost" disabled={busy} aria-label={t('manage.general.remove', { name: file.name })}
                onClick={() => { remove(file.name) }}>{t('manage.general.unassign')}</Button>
            </li>
          ))}
        </ul>
      )}
      {/* Empty or not, the place to drop a book is always visible. */}
      <p className={clsx(css.dropSlot, target.over && css.dropSlotOver)}>{t('manage.general.drop')}</p>
    </section>
  )
}

function AllFiles({ files, pending, feedback, rename, trash, t }: {
  readonly files: Files
  readonly pending: ReadonlySet<string>
  readonly feedback: ReadonlyMap<string, { readonly error?: string
    readonly retry?: () => void }>
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
              busy={pending.has(`file:${file.path}`)}
              feedback={feedback.get(`file:${file.path}`)}
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

function FileRow({ file, busy, feedback, rename, trash, t }: {
  readonly file: ModuleFile
  readonly busy: boolean
  readonly feedback: { readonly error?: string
    readonly retry?: () => void } | undefined
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
                if (name === '' || name === file.name) { setNaming(undefined)
                  return }
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
        <WriteFeedback pending={busy} feedback={feedback} t={t} />
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

function LectureEditor({ initial, recordings, materials, saving, error, save, close, reset, t, subjects = [] }: {
  readonly initial: LectureDefinition
  /** Subjects the lecture can belong to; the selector is hidden when there are none. */
  readonly subjects?: readonly LibrarySubject[]
  readonly recordings: readonly ModuleFile[]
  readonly materials: readonly ModuleFile[]
  readonly saving: boolean
  /** The engine's refusal of the last save, shown where the student is looking. */
  readonly error: string | undefined
  readonly save: (lecture: LectureDefinition) => Promise<void>
  readonly close: () => void
  /**
   * Drop the student's definition so the recordings group by their file names
   * again. Kept here, beside the definition it undoes, rather than on the card
   * where it read like removing the lecture.
   */
  readonly reset?: (() => void) | undefined
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
      className={clsx(css.editorDialog)}
      closeLabel={t('manage.editor.close')}
      footer={(
        <div className={css.editorFooter}>
          {reset !== undefined && (
            <button type="button" className={css.resetLink} disabled={saving} onClick={reset}>{t('manage.undefine')}</button>
          )}

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
      <div className={css.editor} aria-busy={saving}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('manage.editor.title')}</span>
          <Input
            autoFocus
            disabled={saving}
            aria-invalid={tried && problem === 'title'}
            dir="auto"
            value={draft.title}
            placeholder={t('manage.editor.titlePlaceholder')}
            onChange={(event) => { setDraft({ ...draft, title: event.currentTarget.value }) }}
          />
          {tried && problem === 'title' && <span className={css.error} role="alert">{t('manage.problem.title')}</span>}
        </label>
        {subjects.length > 0 && (
          <label className={css.field}>
            <span className={css.fieldLabel}>{t('subjects.field')}</span>
            <select className={css.select} disabled={saving} value={draft.subject ?? ''}
              onChange={(event) => { setDraft({ ...draft, subject: event.currentTarget.value === '' ? null : event.currentTarget.value }) }}>
              <option value="">{t('subjects.none')}</option>
              {subjects.map(subject => <option key={subject.id} value={subject.id}>{subject.title}</option>)}
            </select>
          </label>
        )}

        <fieldset className={css.fieldset} disabled={saving}>
          <legend className={css.fieldLabel}>{t('manage.editor.recordings')}</legend>
          <p className={css.hint}>{t('manage.editor.recordingsHint')}</p>
          {tried && problem === 'recordings' && <span className={css.error} role="alert">{t('manage.problem.recordings')}</span>}
          {draft.recordings.length > 0 && (
            <ol className={css.order}>
              {draft.recordings.map((name, index) => (
                <li key={name} className={css.orderItem} draggable={!saving} onDragStart={(event) => { event.dataTransfer.setData('application/x-qabas-part', String(index)) }}
                  onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-qabas-part')) event.preventDefault() }}
                  onDrop={(event) => { event.preventDefault()
                    const raw = event.dataTransfer.getData('application/x-qabas-part')
                    if (raw === '' || saving) return
                    const from = Number(raw)
                    if (!Number.isInteger(from) || from < 0 || from >= draft.recordings.length) return
                    const next = [...draft.recordings]
                    const [part] = next.splice(from, 1)
                    if (part === undefined) return
                    next.splice(index, 0, part)
                    setDraft({ ...draft, recordings: next }) }}>
                  <span className={css.partNumber}>{t('manage.editor.part', { part: String(index + 1) })}</span>
                  <span className={css.orderName} dir="auto">{name}</span>
                  <button type="button" className={css.iconButton} aria-label={t('manage.editor.earlier')} disabled={saving || index === 0} onClick={() => { setDraft({ ...draft, recordings: moved(draft.recordings, index, -1) }) }}>↑</button>
                  <button type="button" className={css.iconButton} aria-label={t('manage.editor.later')} disabled={saving || index === draft.recordings.length - 1} onClick={() => { setDraft({ ...draft, recordings: moved(draft.recordings, index, 1) }) }}>↓</button>
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

        <fieldset className={css.fieldset} disabled={saving}>
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

/**
 * A lecture section heading; a subject heading also renames inline and deletes.
 * @param props.title - section title.
 * @param props.count - lectures in the section.
 * @param props.busy - a write on this subject is running.
 * @param props.rename - save a new subject title; absent for non-subject sections.
 * @param props.remove - ask to delete the subject; absent for non-subject sections.
 * @param props.t - translate.
 */
function SubjectHeading({ title, count, busy, rename, remove, t }: {
  readonly title: string
  readonly count: number
  readonly busy: boolean
  readonly rename?: ((title: string) => Promise<boolean>) | undefined
  readonly remove?: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [naming, setNaming] = useState(false)
  if (naming && rename !== undefined) {
    return <SubjectNameForm label={t('subjects.rename')} initial={title} busy={busy}
      save={async (next) => { const ok = await rename(next)
        if (ok) setNaming(false)
        return ok }}
      cancel={() => { setNaming(false) }} t={t} />
  }
  return <div className={css.subjectHead}>
    <h3 className={css.sectionTitle}><bdi>{title}</bdi><span className={css.count}>{count}</span></h3>
    {rename !== undefined && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setNaming(true) }}>{t('subjects.rename')}</Button>}
    {remove !== undefined && <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>{t('subjects.delete')}</Button>}
  </div>
}

/**
 * Inline subject title form: Enter saves, Escape cancels.
 * @param props.label - accessible name of the field and the form's purpose.
 * @param props.initial - current title when renaming.
 * @param props.busy - the save is running.
 * @param props.save - persist the trimmed title; resolves whether it was saved.
 * @param props.cancel - leave the form without saving.
 * @param props.t - translate.
 */
function SubjectNameForm({ label, initial = '', busy, save, cancel, t }: {
  readonly label: string
  readonly initial?: string
  readonly busy: boolean
  readonly save: (title: string) => Promise<boolean>
  readonly cancel: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [value, setValue] = useState(initial)
  return <form className={css.renameForm} onSubmit={(event) => { event.preventDefault()
    if (value.trim() !== '') void save(value.trim()) }}>
    <Input autoFocus dir="auto" value={value} aria-label={label} placeholder={t('subjects.placeholder')} disabled={busy}
      onChange={(event) => { setValue(event.currentTarget.value) }} onKeyDown={(event) => { if (event.key === 'Escape') cancel() }} />
    <Button size="sm" type="submit" disabled={busy || value.trim() === ''}>{t('manage.save')}</Button>
    <Button size="sm" variant="ghost" onClick={cancel}>{t('manage.editor.cancel')}</Button>
  </form>
}
