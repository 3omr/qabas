/** A module's exam papers: one row per paper, its year and question count, and a background question-bank job. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconEllipsisOutline16, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LectureEditing, ModuleFile } from '../editing.ts'
import type { LibraryJob, PaperProgress } from '../jobs.ts'
import { IconTranscript } from '../icons.tsx'
import { useConfirm } from './Confirm.tsx'
import { useInventory, useWrites, WriteFeedback, useIntake, UploadRows, useFileDrop, useUndo } from './management.tsx'
import { PageHeader } from './PageHeader.tsx'
import type {} from '../locales.ts'
import css from './Exams.module.css'

const FORMATS = '.pdf,.docx,.doc,.txt,.md,.odt,.rtf,.xls,.xlsx,.ppt,.pptx,.pps,.ppsx,.jpg,.jpeg,.png,.webp,.bmp'
const FIRST_YEAR = 1900
const LAST_YEAR = 2100
type Choice = 'skip' | 'replace' | 'copy'

function copyName(name: string, names: Set<string>): string {
  const dot = name.lastIndexOf('.')
  const stem = dot < 0 ? name : name.slice(0, dot)
  const extension = dot < 0 ? '' : name.slice(dot)
  let n = 2
  while (names.has(`${stem} (${n})${extension}`.toLocaleLowerCase())) n++
  return `${stem} (${n})${extension}`
}

/** Newest exams first; papers without a year follow, by name. */
function byYear(left: ModuleFile, right: ModuleFile): number {
  return (right.year ?? -1) - (left.year ?? -1) || left.name.localeCompare(right.name)
}

/**
 * Whether a paper failed because agy is signed out, live from the running job or from its published failure.
 * @param paper - the listed paper.
 * @param progress - its state in the running job, if one runs.
 * @returns whether signing in to Antigravity is the paper's next step.
 */
function signedOut(paper: ModuleFile, progress: PaperProgress | undefined): boolean {
  return progress === undefined
    ? paper.indexFailed === true && paper.indexFailureCause === 'auth'
    : progress.phase === 'failed' && progress.cause === 'auth'
}

/** Open Settings at Accounts and tools, where Antigravity is signed in and tested. */
function openAccounts(): void {
  window.dispatchEvent(new CustomEvent('dsh-desktop-open-settings', { detail: { section: 'transcriber-engine' } }))
}

/** Whether a job is still admitted or running. */
function active(job: LibraryJob | undefined): boolean {
  return job !== undefined && ['queued', 'starting', 'running', 'waiting'].includes(job.status)
}

/**
 * Manage a module's exam papers and run its question bank as a background job.
 * @param props - module, engine edits, the module's latest question-bank job, its controls, navigation and copy.
 * @returns the exams page.
 */
export function ExamsView({ module, editing, job, startIndex, stopIndex, changed, openQuestions, t }: {
  readonly module: string
  readonly editing: LectureEditing
  /** Newest question-bank job of this module, finished or not. */
  readonly job?: LibraryJob | undefined
  readonly startIndex?: (() => void) | undefined
  readonly stopIndex?: ((jobId: string) => void) | undefined
  readonly openQuestions?: (path: string) => void
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
  const [menu, setMenu] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [conflict, setConflict] = useState<string>()
  const answer = useRef<((choice: Choice) => void)>()
  const papers = inventory.files.filter(file => file.kind === 'question').toSorted(byYear)
  const known = useRef(papers)
  known.current = papers
  const running = active(job)
  // A job that just ended republished the index; read the papers it settled.
  const jobStatus = job === undefined ? undefined : `${job.id}:${job.status}`
  const seenStatus = useRef(jobStatus)
  useEffect(() => {
    if (seenStatus.current === jobStatus) return
    seenStatus.current = jobStatus
    if (job !== undefined && !active(job)) void refresh()
  }, [jobStatus])
  useEffect(() => () => { answer.current?.('skip') }, [])
  const settle = (choice: Choice): void => { answer.current?.(choice)
    answer.current = undefined
    setConflict(undefined) }
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
  const intake = useIntake(editing, module, () => 'question', (paper) => {
    known.current = [...known.current.filter(item => item.path !== paper.path), paper]
    inventory.imported(paper)
    changed()
  }, choose)
  const drop = useFileDrop(intake.add)
  // Index once a batch of uploads has settled with at least one new paper.
  const completedBatch = useRef('')
  useEffect(() => {
    if (intake.entries.length === 0 || intake.entries.some(entry => entry.phase === 'preparing' || entry.phase === 'saving')) return
    const signature = intake.entries.map(entry => `${entry.id}:${entry.phase}`).join(',')
    if (signature === completedBatch.current) return
    completedBatch.current = signature
    if (intake.entries.some(entry => entry.phase === 'done') && !running) startIndex?.()
  }, [intake.entries])
  const trashPapers = async (chosen: readonly ModuleFile[]): Promise<void> => {
    const first = chosen[0]
    if (first === undefined) return
    const yes = await confirm.ask({ title: t('manage.trash.title'), body: chosen.length === 1 ? t('manage.trash.confirm', { name: first.name }) : t('management.trash.bulkConfirm', { count: chosen.length }), confirm: t('manage.trash'), danger: true })
    if (!yes) return
    const ids: string[] = []
    for (const paper of chosen) {
      const result = await writes.run(paper.path, () => editing.trashFile(module, paper.path))
      if (result?.ok && result.value?.id !== undefined) ids.push(result.value.id)
    }
    setSelected(new Set())
    setSelecting(false)
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
  const setExamYear = editing.setExamYear?.bind(editing)
  const chosen = papers.filter(paper => selected.has(paper.path))
  const questions = papers.reduce((sum, paper) => sum + (paper.indexed === true ? paper.questionCount ?? 0 : 0), 0)
  const unsigned = papers.filter(paper => signedOut(paper, running ? job?.papers?.[paper.name] : undefined)).length
  const outcome = {
    ready: papers.filter(paper => paper.indexed === true).length,
    failed: papers.filter(paper => paper.indexFailed === true || paper.preparation === 'failed').length,
  }
  const facts = papers.length === 0 ? undefined : questions > 0
    ? t('exams.facts', { papers: String(papers.length), questions: String(questions) })
    : t('exams.count', { count: String(papers.length) })
  return <section className={css.page} aria-label={t('exams.title')} {...drop.handlers}>
    <PageHeader title={t('exams.title')} facts={facts}>
      <Button variant="primary" onClick={() => { input.current?.click() }}>{t('exams.none.add')}</Button>
      {papers.length > 0 && <Menu open={menu} autoFocus portal align="end" items={[
        ...startIndex === undefined ? [] : [{ id: 'index', label: t('exams.refresh'), disabled: running }],
        { id: 'select', label: t(selecting ? 'exams.selectDone' : 'exams.select') },
      ]} onSelect={(action) => { setMenu(false)
        if (action === 'index') startIndex?.()
        if (action === 'select') { setSelecting(!selecting)
          setSelected(new Set()) } }} onClose={() => { setMenu(false) }}
      anchor={<button type="button" className={css.more} aria-haspopup="menu" aria-expanded={menu} aria-label={t('exams.pageMenu')} onClick={() => { setMenu(!menu) }}><IconEllipsisOutline16 /></button>} />}
    </PageHeader>
    <input ref={input} type="file" multiple hidden accept={FORMATS} aria-label={t('exams.none.add')} onChange={(event) => { intake.add([...event.currentTarget.files ?? []])
      event.currentTarget.value = '' }} />
    {drop.over && <div className={css.dropOverlay} role="status">{t('exams.drop')}</div>}
    <UploadRows intake={intake} t={t} />
    {job !== undefined && <JobStrip job={job} papers={papers.length} outcome={outcome} retry={startIndex}
      stop={stopIndex === undefined ? undefined : () => { stopIndex(job.id) }} t={t} />}
    {unsigned > 0 && <div className={css.notice} role="alert">
      <span>{t('exams.signIn.body', { count: String(unsigned) })}</span>
      <Button variant="outline" size="sm" onClick={openAccounts}>{t('exams.signIn.open')}</Button>
    </div>}
    {selecting && <div className={css.selectBar} role="toolbar" aria-label={t('exams.select')}>
      <label className={css.selectAll}><input type="checkbox" checked={papers.length > 0 && chosen.length === papers.length} onChange={() => {
        setSelected(chosen.length === papers.length ? new Set() : new Set(papers.map(paper => paper.path))) }} />{t('management.selectAll')}</label>
      <Button variant="outline" size="sm" disabled={chosen.length === 0 || chosen.some(paper => writes.pending.has(paper.path))} onClick={() => { void trashPapers(chosen) }}>{t('management.trash.bulk', { count: chosen.length })}</Button>
    </div>}
    {inventory.error !== undefined && <div className={css.notice} role="alert"><span dir="auto">{inventory.error}</span><Button variant="ghost" size="sm" onClick={() => { void inventory.reload() }}>{t('retry')}</Button></div>}
    {inventory.loading ? <LoadingPapers t={t} /> : papers.length === 0
      ? <div className={css.empty}>
        <span className={css.emptyIcon} aria-hidden><IconTranscript /></span>
        <p className={css.emptyTitle}>{t('exams.empty')}</p>
        <p className={css.emptyHint}>{t('exams.emptyHint')}</p>
        <Button variant="primary" onClick={() => { input.current?.click() }}>{t('exams.none.add')}</Button>
      </div>
      : <ul className={css.rows}>{papers.map(paper => <ExamRow key={paper.path} paper={paper}
        progress={running ? job?.papers?.[paper.name] : undefined}
        pending={writes.pending.has(paper.path)} feedback={writes.feedback.get(paper.path)}
        selecting={selecting} selected={selected.has(paper.path)} select={() => { setSelected((previous) => { const next = new Set(previous)
          if (next.has(paper.path)) next.delete(paper.path)
          else next.add(paper.path)
          return next }) }}
        rename={async name => (await writes.run(paper.path, () => editing.renameFile(module, paper.path, name)))?.ok === true}
        {...setExamYear === undefined ? {} : {
          setYear: async (year: number | 'bank' | null) => (await writes.run(paper.path, () => setExamYear(module, paper.path, year)))?.ok === true,
        }}
        retry={running ? undefined : startIndex} trash={() => { void trashPapers([paper]) }}
        openQuestions={openQuestions} t={t} />)}</ul>}
    {conflict !== undefined && <Modal open title={t('exams.duplicate.title')} closeLabel={t('manage.editor.close')} onClose={() => { settle('skip') }}>
      <p dir="auto">{t('exams.duplicate.body', { name: conflict })}</p><div className={css.modalActions}>
        <Button onClick={() => { settle('copy') }}>{t('exams.duplicate.copy')}</Button><Button variant="outline" onClick={() => { settle('replace') }}>{t('exams.duplicate.replace')}</Button><Button variant="ghost" onClick={() => { settle('skip') }}>{t('exams.duplicate.skip')}</Button>
      </div>
    </Modal>}
    {confirm.dialog}{undo.toast}
  </section>
}

/**
 * Placeholder rows shaped like papers while the module's files are read.
 * @param props - localized label.
 * @returns shimmering rows.
 */
function LoadingPapers({ t }: { readonly t: TranslateNS<'library'> }): ReactNode {
  return <ul className={css.rows} role="status" aria-label={t('loading')} aria-busy>
    {[62, 48, 55, 40].map(width => <li key={width} className={css.row}>
      <span className={css.icon} data-skeleton="true" />
      <div className={css.main}><span className={css.bar} style={{ inlineSize: `${width}%` }} /><span className={css.bar} data-short="true" /></div>
    </li>)}
  </ul>
}

/**
 * The module's question-bank job in one line: live progress with Stop, or how the last run ended.
 * @param props - job, listed paper count, settled paper outcomes, retry and stop controls, and copy.
 * @returns the strip, or nothing for a finished job with nothing to report.
 */
function JobStrip({ job, papers, outcome, retry, stop, t }: {
  readonly job: LibraryJob
  readonly papers: number
  /** Listed papers in the bank and papers whose reading failed, after the job settled. */
  readonly outcome: { readonly ready: number
    readonly failed: number }
  readonly retry: (() => void) | undefined
  readonly stop: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  if (active(job)) {
    const states = Object.values(job.papers ?? {})
    const total = Math.max(states.length, papers)
    const done = states.filter(paper => paper.phase === 'done' || paper.phase === 'failed').length
    return <div className={css.strip} role="status">
      <span className={css.spinner} aria-hidden />
      <div className={css.stripText}>
        <strong>{t('exams.job.running')}</strong>
        <span>{total === 0 ? t('job.status.queued') : t('exams.job.papers', { done: String(done), total: String(total) })}</span>
      </div>
      <div className={css.track} aria-hidden><span style={{ inlineSize: `${total === 0 ? 4 : Math.max(4, done / total * 100)}%` }} /></div>
      {stop !== undefined && <Button variant="ghost" size="sm" onClick={stop}>{t('exams.stop')}</Button>}
    </div>
  }
  if (job.status === 'done') {
    if (outcome.failed === 0) return null
    return <div className={css.strip} role="status">
      <div className={css.stripText}><strong>{t('exams.job.done', { ready: String(outcome.ready), failed: String(outcome.failed) })}</strong></div>
    </div>
  }
  if (job.status !== 'failed') return null
  return <div className={css.strip} data-tone="failed" role="alert">
    <div className={css.stripText}>
      <strong>{t('exams.job.failed')}</strong>
      {/* The engine's English diagnostic, for whoever needs it. */}
      {job.error !== undefined && <details className={css.details}><summary>{t('exams.job.details')}</summary><pre dir="ltr">{job.error}</pre></details>}
    </div>
    {retry !== undefined && <Button variant="outline" size="sm" onClick={retry}>{t('retry')}</Button>}
  </div>
}

/**
 * One paper: name, year, and either its question count or where it is in the running job.
 * @param props - paper, its live job state, edits, selection, navigation and copy.
 * @returns the paper row.
 */
function ExamRow({ paper, progress, pending, feedback, selecting, selected, select, rename, setYear, retry, trash, openQuestions, t }: {
  readonly paper: ModuleFile
  readonly progress: PaperProgress | undefined
  readonly pending: boolean
  readonly feedback: { readonly error?: string
    readonly retry?: () => void } | undefined
  readonly selecting: boolean
  readonly selected: boolean
  readonly select: () => void
  readonly rename: (name: string) => Promise<boolean>
  readonly setYear?: (year: number | 'bank' | null) => Promise<boolean>
  readonly retry: (() => void) | undefined
  readonly trash: () => void
  readonly openQuestions: ((path: string) => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [menu, setMenu] = useState(false)
  const [name, setName] = useState<string>()
  const [year, setYearDraft] = useState<string>()
  useEffect(() => { setName(undefined) }, [paper.name])
  const failed = progress?.phase === 'failed' || (progress === undefined && (paper.indexFailed === true || paper.preparation === 'failed'))
  const readable = paper.indexed === true || paper.indexLegacy === true
  const open = readable && openQuestions !== undefined && !selecting ? () => { openQuestions(paper.path) } : undefined
  const draftYear = year === undefined || year === '' ? undefined : Number(year)
  // A read paper without a year is a question bank: dated by no single exam.
  const yearLabel = paper.year != null ? String(paper.year) : readable ? t('exams.year.bank') : undefined
  const choose = (choice: number | 'bank' | null): void => { void setYear?.(choice).then((ok) => { if (ok) setYearDraft(undefined) }) }
  const validYear = draftYear !== undefined && Number.isInteger(draftYear) && draftYear >= FIRST_YEAR && draftYear <= LAST_YEAR
  return <li className={css.row} data-phase={progress?.phase ?? (failed ? 'failed' : readable ? 'done' : 'idle')}>
    {selecting && <input type="checkbox" checked={selected} disabled={pending} onChange={select} aria-label={t('management.select', { name: paper.name })} />}
    <span className={css.icon} aria-hidden><IconTranscript /></span>
    <div className={css.main}>
      {name === undefined
        ? open === undefined
          ? <span className={css.name}><bdi>{paper.name}</bdi></span>
          : <button type="button" className={css.name} onClick={open}><bdi>{paper.name}</bdi></button>
        : <form className={css.inline} onSubmit={(event) => { event.preventDefault()
          if (name.trim()) void rename(name.trim()).then((ok) => { if (ok) setName(undefined) }) }}>
          <Input autoFocus value={name} dir="auto" aria-label={t('manage.rename')} disabled={pending} onChange={(event) => { setName(event.currentTarget.value) }} onKeyDown={(event) => { if (event.key === 'Escape') setName(undefined) }} />
          <Button type="submit" size="sm" disabled={pending || name.trim() === ''}>{t('manage.save')}</Button><Button size="sm" variant="ghost" onClick={() => { setName(undefined) }}>{t('manage.editor.cancel')}</Button>
        </form>}
      {year === undefined
        ? <div className={css.sub}>
          {yearLabel !== undefined && (setYear === undefined
            ? <span className={css.year} data-bank={paper.year == null}>{yearLabel}</span>
            : <button type="button" className={css.year} data-bank={paper.year == null} disabled={pending} aria-label={t('exams.year.edit', { year: yearLabel })}
              onClick={() => { setYearDraft(paper.year == null ? '' : String(paper.year)) }}>{yearLabel}</button>)}
          <PaperState paper={paper} progress={progress} failed={failed} t={t} />
        </div>
        : <form className={css.inline} onSubmit={(event) => { event.preventDefault()
          if (validYear) choose(draftYear) }}>
          <span className={css.yearInput}><Input autoFocus type="number" inputMode="numeric" min={FIRST_YEAR} max={LAST_YEAR} value={year}
            aria-label={t('exams.year.label')} disabled={pending} onChange={(event) => { setYearDraft(event.currentTarget.value) }}
            onKeyDown={(event) => { if (event.key === 'Escape') setYearDraft(undefined) }} /></span>
          <Button type="submit" size="sm" disabled={pending || !validYear}>{t('manage.save')}</Button>
          {!(paper.year == null && paper.yearSource === 'owner') && <Button size="sm" variant="outline" disabled={pending} onClick={() => { choose('bank') }}>{t('exams.year.markBank')}</Button>}
          {paper.yearSource === 'owner' && <Button size="sm" variant="ghost" disabled={pending} onClick={() => { choose(null) }}>{t('exams.year.auto')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => { setYearDraft(undefined) }}>{t('manage.editor.cancel')}</Button>
        </form>}
      <WriteFeedback pending={pending} feedback={feedback} t={t} />
    </div>
    {!selecting && <Menu open={menu} autoFocus portal align="end" items={[
      ...open === undefined ? [] : [{ id: 'questions', label: t('exams.viewQuestions') }],
      ...setYear === undefined ? [] : [{ id: 'year', label: t('exams.year.change') }],
      { id: 'rename', label: t('manage.rename') }, ...failed && retry !== undefined ? [{ id: 'retry', label: t('exams.retry') }] : [],
      { id: 'trash', label: t('manage.trash'), danger: true },
    ]} onSelect={(action) => { setMenu(false)
      if (action === 'questions') open?.()
      if (action === 'year') setYearDraft(paper.year == null ? '' : String(paper.year))
      if (action === 'rename') setName(paper.name)
      if (action === 'retry') retry?.()
      if (action === 'trash') trash() }} onClose={() => { setMenu(false) }}
    anchor={<button type="button" className={css.more} disabled={pending} aria-haspopup="menu" aria-expanded={menu} aria-label={t('exams.more', { name: paper.name })} onClick={() => { setMenu(!menu) }}><IconEllipsisOutline16 /></button>} />}
  </li>
}

/**
 * The paper's state in a few words: its questions, its live phase, or that it could not be read.
 * @param props - paper, live job state, failure, and copy.
 * @returns the state label.
 */
function PaperState({ paper, progress, failed, t }: {
  readonly paper: ModuleFile
  readonly progress: PaperProgress | undefined
  readonly failed: boolean
  readonly t: TranslateNS<'library'>
}): ReactNode {
  if (progress !== undefined && progress.phase !== 'done' && progress.phase !== 'failed') {
    const part = progress.phase === 'extracting' && progress.part !== undefined && progress.parts !== undefined && progress.parts > 1
      ? ` · ${t('exams.phase.part', { part: String(progress.part), parts: String(progress.parts) })}` : ''
    return <span className={css.state} data-live={progress.phase !== 'queued'} role="status">
      {progress.phase !== 'queued' && <span className={css.spinner} data-size="small" aria-hidden />}{t(`exams.phase.${progress.phase}`)}{part}
    </span>
  }
  if (failed) {
    const cause = progress?.phase === 'failed' ? progress.cause : paper.indexFailureCause
    const key = cause === 'model' ? 'exams.phase.modelFailed' : cause === 'auth' ? 'exams.phase.authFailed' : 'exams.phase.failed'
    return <span className={css.state} data-tone="failed">{t(key)}</span>
  }
  const count = progress?.questions ?? (paper.indexed === true || paper.indexLegacy === true ? paper.questionCount : undefined)
  if (count !== undefined) return <span className={css.state}>{t('exams.questions', { count: String(count) })}</span>
  return <span className={css.state}>{t('exams.phase.waiting')}</span>
}
