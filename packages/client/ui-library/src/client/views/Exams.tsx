/** Original exam inventory with independent edits, honest uploads and live extraction. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconChevronRightOutline14, IconEllipsisOutline16, IconCheckOutline14, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditOutcome, LectureEditing, ModuleFile } from '../editing.ts'
import { readableSize } from '../editing.ts'
import { prepareExam } from '../prepare-exam.ts'
import { IconTranscript } from '../icons.tsx'
import { useConfirm } from './Confirm.tsx'
import { useInventory, useWrites, WriteFeedback, LoadingRows, useIntake, UploadRows, useFileDrop, useUndo, useIndexProgress, IndexProgress } from './management.tsx'
import type {} from '../locales.ts'
import css from './Manage.module.css'
import board from './Exams.module.css'

const FORMATS = '.pdf,.docx,.doc,.txt,.md,.odt,.rtf,.xls,.xlsx,.ppt,.pptx,.pps,.ppsx,.jpg,.jpeg,.png,.webp,.bmp'
type Choice = 'skip' | 'replace' | 'copy'
function copyName(name: string, names: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot < 0 ? name : name.slice(0, dot)
  const extension = dot < 0 ? '' : name.slice(dot)
  let n = 2
  while (names.has(`${stem} (${n})${extension}`.toLocaleLowerCase())) n++
  return `${stem} (${n})${extension}`
}

/**
 * Manage original exam files independently of lecture assignment.
 * @param props - owning module, injected edits, navigation and localized copy.
 * @returns exam rows with uploads, selection, reversible removal and live indexing.
 */
export function ExamsView({ module, moduleName, editing, changed, done, openQuestions, t }: {
  readonly module: string
  readonly moduleName?: string
  readonly done?: () => void
  readonly openQuestions?: (path: string) => void
  readonly editing: LectureEditing
  readonly changed: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const inventory = useInventory(editing, module)
  const refresh = async (): Promise<void> => { await inventory.reload()
    changed() }
  const writes = useWrites(refresh)
  const confirm = useConfirm(t)
  const undo = useUndo(t)
  const input = useRef<HTMLInputElement>(null)
  const controllers = useRef(new Set<AbortController>())
  const activeIndex = useRef<AbortController>()
  const [installing, setInstalling] = useState<string>()
  const [indexing, setIndexing] = useState(false)
  const indexProgress = useIndexProgress(editing, module, t)
  const preparationAttempts = useRef(new Set<string>())
  const [reading, setReading] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [conflict, setConflict] = useState<string>()
  const answer = useRef<((choice: Choice) => void)>()
  const files = inventory.files.filter(file => file.kind === 'question')
  const known = useRef(files)
  known.current = files
  useEffect(() => () => { for (const owner of controllers.current) owner.abort()
    answer.current?.('skip') }, [])
  const owner = (): AbortController => { const controller = new AbortController()
    controllers.current.add(controller)
    return controller }
  const settle = (choice: Choice): void => { answer.current?.(choice)
    answer.current = undefined
    setConflict(undefined) }
  const prepare = async (paper: ModuleFile, signal: AbortSignal): Promise<EditOutcome<null>> => {
    if (editing.prepareExamFile === undefined) return { ok: true, value: null }
    preparationAttempts.current.add(paper.path)
    setReading(previous => new Set(previous).add(paper.path))
    try { return await prepareExam(editing, module, paper.path, signal, (name) => { setInstalling(name) }, t) }
    finally { setInstalling(undefined)
      setReading((previous) => { const next = new Set(previous)
        next.delete(paper.path)
        return next }) }
  }
  const index = async (signal: AbortSignal): Promise<EditOutcome<null>> => {
    const result = await indexProgress.run(signal)
    return signal.aborted ? { ok: false, message: t('exams.cancelled') } : result
  }
  const collect = (): void => {
    if (activeIndex.current !== undefined) return
    const controller = owner()
    activeIndex.current = controller
    setIndexing(true)
    void writes.run('index', async () => {
      let ready = files.some(file => file.preparation === 'ready')
      let refusal: EditOutcome<null> | undefined
      for (const paper of files.filter(file => !file.indexed && file.preparation !== 'ready')) {
        controller.signal.throwIfAborted()
        const result = await prepare(paper, controller.signal)
        if (result.ok) ready = true
        else { refusal = result
          await inventory.reload() }
      }
      controller.signal.throwIfAborted()
      return ready ? index(controller.signal) : refusal ?? { ok: false, message: t('exams.failed') }
    }).finally(() => { if (controller.signal.aborted) void refresh()
      activeIndex.current = undefined
      controllers.current.delete(controller)
      setIndexing(false) })
  }
  const choose = async (file: File, signal: AbortSignal): Promise<{ readonly name?: string
    readonly replace?: boolean } | null> => {
    const previous = known.current.find(paper => paper.name.toLocaleLowerCase() === file.name.toLocaleLowerCase())
    if (previous === undefined) return { name: file.name }
    if (previous.sha256 !== undefined) {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      signal.throwIfAborted()
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash === previous.sha256) return null
    }
    setConflict(file.name)
    const cancel = (): void => { settle('skip') }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const choice = await new Promise<Choice>((resolve) => { answer.current = resolve
        if (signal.aborted) resolve('skip') })
      signal.throwIfAborted()
      if (choice === 'skip') return null
      return choice === 'replace' ? { name: file.name, replace: true } : { name: copyName(file.name, new Set(known.current.map(paper => paper.name.toLocaleLowerCase()))) }
    } finally { signal.removeEventListener('abort', cancel) }
  }
  const batchReady = useRef(true)
  const batchCancelled = useRef(false)
  const intake = useIntake(editing, module, () => 'question', async (paper, signal) => {
    known.current = [...known.current.filter(item => item.path !== paper.path), paper]
    inventory.imported(paper)
    changed()
    const result = await writes.run(paper.path, () => prepare(paper, signal))
    if (!result?.ok) batchReady.current = false
  }, choose)
  const add = (files: readonly File[]): void => { batchReady.current = true
    batchCancelled.current = false
    intake.add(files) }
  const drop = useFileDrop(add)
  const completedBatch = useRef('')
  useEffect(() => {
    if (intake.entries.length === 0 || intake.entries.some(entry => entry.phase === 'preparing' || entry.phase === 'saving')) return
    const signature = intake.entries.map(entry => `${entry.id}:${entry.phase}`).join(',')
    if (signature === completedBatch.current) return
    completedBatch.current = signature
    if (batchReady.current && !batchCancelled.current && intake.entries.some(entry => entry.phase === 'done')) collect()
  }, [intake.entries])
  const trashPapers = async (papers: readonly ModuleFile[]): Promise<void> => {
    const first = papers[0]
    if (first === undefined) return
    const yes = await confirm.ask({ title: t('manage.trash.title'), body: papers.length === 1 ? t('manage.trash.confirm', { name: first.name }) : t('management.trash.bulkConfirm', { count: papers.length }), confirm: t('manage.trash'), danger: true })
    if (!yes) return
    const ids: string[] = []
    for (const paper of papers) {
      preparationAttempts.current.delete(paper.path)
      const result = await writes.run(paper.path, () => editing.trashFile(module, paper.path))
      if (result?.ok) {
        if (result.value?.id !== undefined) ids.push(result.value.id)
        setSelected((previous) => { const next = new Set(previous)
          next.delete(paper.path)
          return next })
      }
    }
    const restoreTrash = editing.restoreTrash?.bind(editing)
    if (ids.length > 0 && restoreTrash !== undefined) undo.show(async () => {
      while (ids.length > 0) {
        const id = ids[0]
        if (id === undefined) break
        const restored = await restoreTrash(module, id)
        if (!restored.ok) { await refresh()
          return restored }
        ids.shift()
      }
      await refresh()
      return { ok: true, value: null }
    })
  }
  const retry = (paper: ModuleFile): void => {
    if (activeIndex.current !== undefined) return
    const controller = owner()
    activeIndex.current = controller
    setIndexing(true)
    void writes.run(paper.path, async () => { const read = await prepare(paper, controller.signal)
      return read.ok ? index(controller.signal) : read })
      .finally(() => {
        if (controller.signal.aborted) void refresh()
        activeIndex.current = undefined
        controllers.current.delete(controller)
        setIndexing(false)
      })
  }
  const shown = files.filter(file => file.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
  const chosen = shown.filter(file => selected.has(file.path))
  const allSelected = shown.length > 0 && chosen.length === shown.length
  const indexed = files.filter(file => file.indexed).length
  const failed = files.filter(file => !file.indexed && file.indexFailed).length
  return <section className={board.page} aria-label={t('exams.title')} {...drop.handlers}>
    {done !== undefined && <button type="button" className={css.back} onClick={done}><IconChevronRightOutline14 aria-hidden />{t('exams.back', { module: moduleName ?? module })}</button>}
    <header className={css.head}>
      <div><h2 className={css.title}>{t('exams.title')}</h2><p className={css.hint}>{t('exams.hint')}</p></div>
      <div className={css.headActions}>
        <Button variant="primary" onClick={() => { input.current?.click() }}>{t('exams.none.add')}</Button>
        {(editing.buildQuestionIndex !== undefined || editing.streamQuestionIndex !== undefined) && <Button variant="outline" disabled={indexing || files.length === 0} onClick={collect}>{t(indexed === files.length && files.length > 0 ? 'exams.refresh' : 'exams.collect')}</Button>}
      </div>
    </header>
    <input ref={input} type="file" multiple hidden accept={FORMATS} aria-label={t('exams.none.add')} onChange={(event) => { add([...event.currentTarget.files ?? []])
      event.currentTarget.value = '' }} />
    {drop.over && <div className={css.dropOverlay} role="status">{t('exams.drop')}</div>}
    <UploadRows intake={intake} t={t} />
    {!indexing && reading.size > 0 && <Button variant="ghost" onClick={() => { batchCancelled.current = true
      intake.entries.filter(entry => ['preparing', 'saving'].includes(entry.phase)).forEach((entry) => { intake.cancel(entry) }) }}>{t('exams.stop')}</Button>}
    {installing !== undefined && <p role="status">{t('exams.installing')}</p>}
    {indexing && <IndexProgress progress={indexProgress.progress} started={indexProgress.started}
      stop={() => { activeIndex.current?.abort()
        settle('skip') }} t={t} />}
    <WriteFeedback pending={indexing} feedback={writes.feedback.has('index') ? { ...writes.feedback.get('index'), retry: collect } : undefined} t={t} />
    {!inventory.loading && files.length > 0 && <div className={board.bank}><h2 className={board.bankTitle}>{t('exams.bankTitle')}</h2><p>{t('exams.summary', { indexed: String(indexed), total: String(files.length), failed: String(failed), pending: String(files.length - indexed - failed) })}</p></div>}
    <div className={board.toolbar}>
      <Input value={filter} onChange={(event) => { setFilter(event.currentTarget.value) }} placeholder={t('exams.search')} aria-label={t('exams.search')} />
      <span>{t('exams.count', { count: String(files.length) })}</span>
      <label><input type="checkbox" checked={allSelected} onChange={() => { setSelected((previous) => { const next = new Set(previous)
        shown.forEach((file) => { if (allSelected) next.delete(file.path)
        else next.add(file.path) })
        return next }) }} />{t('management.selectAll')}</label>
      {chosen.length > 0 && <Button variant="outline" disabled={chosen.some(paper => writes.pending.has(paper.path))} onClick={() => { void trashPapers(chosen) }}>{t('management.trash.bulk', { count: chosen.length })}</Button>}
    </div>
    {inventory.refreshing && !inventory.loading && <span role="status">{t('management.refreshing')}</span>}
    {inventory.error !== undefined && <div role="alert"><span dir="auto">{inventory.error}</span><Button variant="ghost" onClick={() => { void inventory.reload() }}>{t('retry')}</Button></div>}
    {inventory.loading ? <LoadingRows t={t} /> : shown.length === 0 ? <p>{t(files.length === 0 ? 'exams.empty' : 'module.filterEmpty')}</p> : <ul className={board.rows}>{shown.map(paper => <ExamRow key={paper.path} paper={paper} reading={reading.has(paper.path)} pending={writes.pending.has(paper.path)} readError={preparationAttempts.current.has(paper.path) ? writes.feedback.get(paper.path)?.error : undefined}
      feedback={preparationAttempts.current.has(paper.path) && writes.feedback.has(paper.path)
        ? { ...writes.feedback.get(paper.path), retry: () => { retry(paper) } } : writes.feedback.get(paper.path)}
      selected={selected.has(paper.path)} select={() => { setSelected((previous) => { const next = new Set(previous)
        if (next.has(paper.path)) next.delete(paper.path)
        else next.add(paper.path)
        return next }) }}
      rename={async (name) => {
        preparationAttempts.current.delete(paper.path)
        return (await writes.run(paper.path, () => editing.renameFile(module, paper.path, name)))?.ok === true
      }}
      retry={() => { retry(paper) }} trash={() => { void trashPapers([paper]) }} openQuestions={openQuestions} t={t} />)}</ul>}
    {conflict !== undefined && <Modal open title={t('exams.duplicate.title')} closeLabel={t('manage.editor.close')} onClose={() => { settle('skip') }}>
      <p dir="auto">{t('exams.duplicate.body', { name: conflict })}</p><div className={css.headActions}>
        <Button onClick={() => { settle('copy') }}>{t('exams.duplicate.copy')}</Button><Button variant="outline" onClick={() => { settle('replace') }}>{t('exams.duplicate.replace')}</Button><Button variant="ghost" onClick={() => { settle('skip') }}>{t('exams.duplicate.skip')}</Button>
      </div>
    </Modal>}
    {confirm.dialog}{undo.toast}
  </section>
}

function ExamRow({ paper, reading, pending, feedback, readError, selected, select, rename, retry, trash, openQuestions, t }: {
  readonly paper: ModuleFile
  readonly readError: string | undefined
  readonly reading: boolean
  readonly pending: boolean
  readonly feedback: { readonly error?: string
    readonly retry?: () => void } | undefined
  readonly selected: boolean
  readonly select: () => void
  readonly rename: (name: string) => Promise<boolean>
  readonly retry: () => void
  readonly trash: () => void
  readonly openQuestions: ((path: string) => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [menu, setMenu] = useState(false)
  const [name, setName] = useState<string>()
  useEffect(() => { setName(undefined) }, [paper.name])
  const failure = paper.indexError ?? paper.preparationError ?? readError
  const failed = paper.indexFailed === true || paper.preparation === 'failed' || readError !== undefined
  const state = reading ? 'reading' : paper.indexed ? 'indexed' : failed ? 'failed' : paper.indexLegacy ? 'legacy' : paper.preparation === 'ready' ? 'read' : 'pending'
  return <li className={board.row} data-state={state} data-indexed={paper.indexed === true} data-failed={failed}>
    <input type="checkbox" checked={selected} disabled={pending} onChange={select} aria-label={t('management.select', { name: paper.name })} />
    <span className={board.fileIcon} aria-hidden><IconTranscript /></span>
    <div className={board.fileInfo}>
      {name === undefined ? <h2 className={board.fileName} dir="auto"><bdi>{paper.name}</bdi></h2> : <form className={css.renameForm} onSubmit={(event) => { event.preventDefault()
        if (name.trim()) void rename(name.trim()).then((ok) => { if (ok) setName(undefined) }) }}>
        <Input autoFocus value={name} dir="auto" aria-label={t('manage.rename')} disabled={pending} onChange={(event) => { setName(event.currentTarget.value) }} onKeyDown={(event) => { if (event.key === 'Escape') setName(undefined) }} />
        <Button type="submit" size="sm" disabled={pending || name.trim() === ''}>{t('manage.save')}</Button><Button size="sm" variant="ghost" onClick={() => { setName(undefined) }}>{t('manage.editor.cancel')}</Button>
      </form>}
      <p className={board.meta}><bdi dir="ltr">{paper.size === undefined ? '' : readableSize(paper.size)}</bdi></p>
      {(paper.reviewReasons ?? []).map(reason => <p key={reason} className={board.meta} dir="auto">{paperNote(reason, t)}</p>)}
      <WriteFeedback pending={pending} feedback={feedback} t={t} />
    </div>
    <span className={board.badge} role="status"><span aria-hidden>{state === 'indexed' ? <IconCheckOutline14 /> : state === 'failed' ? '!' : state === 'reading' ? '◌' : state === 'read' ? '✓' : '○'}</span>
      {t(`management.exam.${state}`)}{state === 'indexed' && <> · {t('exams.questions', { count: String(paper.questionCount ?? 0) })}{(paper.questionReviewCount ?? 0) > 0 && <> ({t('exams.reviewCount', { count: String(paper.questionReviewCount) })})</>}</>}
    </span>
    <Menu open={menu} autoFocus portal align="end" items={[
      ...(paper.indexed || paper.indexLegacy) && openQuestions !== undefined ? [{ id: 'questions', label: t('exams.viewQuestions') }] : [],
      { id: 'rename', label: t('manage.rename') }, ...failed ? [{ id: 'retry', label: t('exams.retry') }] : [], { id: 'trash', label: t('manage.trash'), danger: true },
    ]} onSelect={(action) => { setMenu(false)
      if (action === 'questions') openQuestions?.(paper.path)
      if (action === 'rename') setName(paper.name)
      if (action === 'retry') retry()
      if (action === 'trash') trash() }} onClose={() => { setMenu(false) }}
    anchor={<button type="button" className={board.more} disabled={pending} aria-haspopup="menu" aria-expanded={menu} aria-label={t('exams.more', { name: paper.name })} onClick={() => { setMenu(!menu) }}><IconEllipsisOutline16 /></button>} />
    {failed && <div className={board.details}><p>{t(paper.indexFailed ? 'exams.indexFailureReason' : 'exams.readFailureReason')}</p>{failure !== undefined && <details><summary>{t('exams.details')}</summary><pre className={board.diagnostic} dir="auto">{failure}</pre></details>}</div>}
  </li>
}

/** The engine's fixed year-mismatch note, localized; any other note stays verbatim. */
const YEAR_MISMATCH = /^Filename year (\d{4}) differs from the paper's printed year (\d{4})$/u

function paperNote(reason: string, t: TranslateNS<'library'>): string {
  const mismatch = YEAR_MISMATCH.exec(reason)
  return mismatch === null
    ? t('exams.paperNote', { reason })
    : t('exams.paperYearMismatch', { filename: mismatch[1] ?? '', printed: mismatch[2] ?? '' })
}
