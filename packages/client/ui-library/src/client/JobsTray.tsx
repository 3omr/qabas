/**
 * The jobs tray: work the library started in the background, wherever the
 * student is in the app.
 *
 * Collapsed it is one pill — how many jobs are running and whether one is
 * waiting for an answer. Open, each job says what it is doing in words
 * ("reading the doctor's words, part 2 of 5"), and a job that asks a question
 * shows it with its options right there: the student answers without opening
 * the conversation the job runs in.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconEmber } from './icons.tsx'
import type { JobStep, LibraryJob, LibraryJobs } from './jobs.ts'
import { displayTitle } from './model.ts'
import { useSnapshot } from './parts.tsx'
import type {} from './locales.ts'
import { STEP_KEYS } from './tool-steps.ts'
import css from './JobsTray.module.css'

/** What the tray is handed besides its copy. */
export interface JobsTrayInjected {
  readonly jobs: LibraryJobs
  /** Show a job's lecture in the library. */
  readonly reveal: (job: LibraryJob) => void
}

/** The tray's props. */
export type JobsTrayProps = JobsTrayInjected & PropsLocale<'library'>

/**
 * Say in words what a job is doing.
 * @param step - the job's current step.
 * @param t - translate.
 * @returns the sentence.
 */
export function stepLine(step: JobStep | undefined, t: TranslateNS<'library'>): string {
  if (step === undefined) return t('job.step.working')
  const key = STEP_KEYS[step.tool] ?? 'job.step.working'
  const line = t(key)
  return step.part !== undefined && step.parts !== undefined
    ? `${line} ${t('job.step.part', { part: String(step.part), parts: String(step.parts) })}`
    : line
}

/** Whether a job is still going: it holds a place in the tray's count. */
export function isActive(job: LibraryJob): boolean {
  return job.status === 'queued' || job.status === 'starting' || job.status === 'running' || job.status === 'waiting'
}

function JobQuestion({ job, jobs, t }: { readonly job: LibraryJob; readonly jobs: LibraryJobs; readonly t: TranslateNS<'library'> }): ReactNode {
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({})
  const [sending, setSending] = useState(false)
  if (job.question === undefined) return null
  const questions = job.question.questions
  const complete = questions.every(question => (question.options?.length ?? 0) === 0 || chosen[question.id] !== undefined)
  const send = (): void => {
    setSending(true)
    void jobs.answer(job.id, {
      answers: questions.map((question) => {
        const option = chosen[question.id]
        return { id: question.id, selected: option === undefined ? [] : [option] }
      }),
    }).finally(() => { setSending(false) })
  }
  return (
    <div className={css.question} role="group" aria-label={t('job.question')}>
      {questions.map(question => (
        <fieldset key={question.id} className={css.questionItem}>
          <legend className={css.questionText} dir="auto">{question.question}</legend>
          {question.detail !== undefined && <p className={css.questionDetail} dir="auto">{question.detail}</p>}
          <div className={css.options}>
            {(question.options ?? []).map(option => (
              <label key={option.label} className={clsx(css.option, chosen[question.id] === option.label && css.optionChosen)}>
                <input
                  type="radio"
                  name={`${job.id}:${question.id}`}
                  value={option.label}
                  checked={chosen[question.id] === option.label}
                  onChange={() => { setChosen({ ...chosen, [question.id]: option.label }) }}
                />
                <span dir="auto">{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className={css.questionActions}>
        <Button size="sm" variant="primary" disabled={!complete || sending} onClick={send}>{t('job.answer')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { jobs.open(job.id) }}>{t('job.openChat')}</Button>
      </div>
    </div>
  )
}

/**
 * One job in the tray (and on its lecture's page).
 * @param props.job - the job.
 * @param props.jobs - the job service.
 * @param props.reveal - show the job's lecture.
 * @param props.t - translate.
 */
export function JobCard({ job, jobs, reveal, t }: {
  readonly job: LibraryJob
  readonly jobs: LibraryJobs
  readonly reveal?: ((job: LibraryJob) => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const subject = job.lecture === undefined ? job.moduleName : displayTitle(job.lecture)
  const active = isActive(job)
  return (
    <article className={css.card} data-status={job.status}>
      <header className={css.cardHead}>
        <span className={css.cardMark} aria-hidden>{active ? <span className={css.spinner} /> : <IconEmber size={14} />}</span>
        <div className={css.cardTitles}>
          <button type="button" className={css.cardTitle} onClick={() => { reveal?.(job) }} disabled={reveal === undefined} dir="auto">
            {t(`job.kind.${job.kind}`)} · {subject}
          </button>
          <span className={css.cardStatus}>
            {job.status === 'running' || job.status === 'starting' ? stepLine(job.step, t) : t(`job.status.${job.status}`)}
          </span>
        </div>
        {active
          ? (
            <button type="button" className={css.iconButton} aria-label={t('job.cancel')} title={t('job.cancel')} onClick={() => { void jobs.cancel(job.id) }}>
              <IconCloseOutline16 />
            </button>
          )
          : (
            <button type="button" className={css.iconButton} aria-label={t('job.dismiss')} title={t('job.dismiss')} onClick={() => { jobs.dismiss(job.id) }}>
              <IconCloseOutline16 />
            </button>
          )}
      </header>
      {(job.status === 'running' || job.status === 'starting') && <div className={css.track}><span className={css.trackBar} /></div>}
      {job.status === 'waiting' && <JobQuestion job={job} jobs={jobs} t={t} />}
      {(job.summary !== undefined || job.error !== undefined) && !active && (
        <p className={clsx(css.summary, job.status === 'failed' && css.summaryFailed)} dir="auto">{job.error ?? job.summary}</p>
      )}
      {!active && job.sessionId !== undefined && (
        <Button size="sm" variant="ghost" onClick={() => { jobs.open(job.id) }}>{t('job.openChat')}</Button>
      )}
    </article>
  )
}

/**
 * The tray.
 * @param props - see {@link JobsTrayProps}.
 */
export function JobsTray({ jobs, reveal, t }: JobsTrayProps): ReactNode {
  const list = useSnapshot(jobs.jobs)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  // A popover, not a pane: Escape or a click elsewhere puts it away.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])
  useEffect(() => { if (list.length === 0) setOpen(false) }, [list.length])
  if (list.length === 0) return null
  const active = list.filter(isActive)
  const waiting = list.some(job => job.status === 'waiting')
  const pillLabel = waiting
    ? t('job.pill.waiting')
    : active.length > 0
      ? t('job.pill.running', { count: String(active.length) })
      : t('job.pill.done', { count: String(list.length) })
  return (
    <div ref={root} className={css.tray} data-open={open}>
      <button
        type="button"
        className={clsx(css.pill, waiting && css.pillWaiting)}
        aria-expanded={open}
        aria-label={pillLabel}
        title={pillLabel}
        onClick={() => { setOpen(!open) }}
      >
        {active.length > 0 ? <span className={css.spinner} aria-hidden /> : <IconEmber size={14} />}
        {/* The count is what fits the rail; the sentence is the button's name. */}
        <span className={css.pillCount} aria-hidden>{waiting ? '!' : String(active.length > 0 ? active.length : list.length)}</span>
      </button>
      {open && (
        <section className={css.panel} aria-label={t('job.tray')}>
          <header className={css.panelHead}>
            <h2 className={css.panelTitle}>{t('job.tray')}</h2>
            <button type="button" className={css.iconButton} aria-label={t('job.collapse')} onClick={() => { setOpen(false) }}>
              <IconCloseOutline16 />
            </button>
          </header>
          <div className={css.panelList}>
            {list.map(job => <JobCard key={job.id} job={job} jobs={jobs} reveal={reveal} t={t} />)}
          </div>
        </section>
      )}
    </div>
  )
}

/**
 * A lecture's running job, where its action button would be: what the job
 * is doing right now, so the row never offers to start what already runs.
 * @param props.job - the active job on this lecture.
 * @param props.t - translate.
 */
export function JobChip({ job, t }: { readonly job: LibraryJob; readonly t: TranslateNS<'library'> }): ReactNode {
  const line = job.status === 'waiting' ? t('job.status.waiting') : job.status === 'queued' ? t('job.status.queued') : stepLine(job.step, t)
  return (
    <span className={clsx(css.chip, job.status === 'waiting' && css.chipWaiting)} role="status">
      {job.status === 'waiting' ? <IconEmber size={12} /> : <span className={css.spinner} aria-hidden />}
      <span className={css.chipText}>{line}</span>
    </span>
  )
}
