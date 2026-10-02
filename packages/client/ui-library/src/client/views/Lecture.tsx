/**
 * One lecture: how far it has come, the next thing to do, and the files it
 * has produced so far.
 *
 * The stepper names the three things a transcription makes, in the order it
 * makes them — the doctor's words, the draft written from them, the finished
 * transcript — so a lecture that stopped half way says where it stopped.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconDraft, IconMaterial, IconQuote, IconRecording, IconTranscript } from '../icons.tsx'
import { lectureHeading, type LectureState, type LibraryLecture, type LibraryModule } from '../model.ts'
import { ActionButtons, StateBadge } from '../parts.tsx'
import type { LibraryJob } from '../jobs.ts'
import { JobChip } from '../JobsTray.tsx'
import type { LibraryAction } from '../service.ts'
import { lectureMeta } from './Module.tsx'
import type {} from '../locales.ts'
import css from '../LibraryPanel.module.css'

const STEPS: readonly { readonly state: Exclude<LectureState, 'pending'>; readonly key: 'lecture.step.verbatim' | 'lecture.step.draft' | 'lecture.step.final' }[] = [
  { state: 'verbatim', key: 'lecture.step.verbatim' },
  { state: 'draft', key: 'lecture.step.draft' },
  { state: 'final', key: 'lecture.step.final' },
]

const RANK: Readonly<Record<LectureState, number>> = { pending: 0, verbatim: 1, draft: 2, final: 3 }

/**
 * Whether a step is done, current, or ahead for a lecture in a given state.
 * @param step - the step's state.
 * @param state - the lecture's state.
 * @returns the step's standing.
 */
export function stepStanding(step: Exclude<LectureState, 'pending'>, state: LectureState): 'done' | 'next' | 'ahead' {
  if (RANK[state] >= RANK[step]) return 'done'
  return RANK[state] + 1 === RANK[step] ? 'next' : 'ahead'
}

function Stepper({ state, t }: { readonly state: LectureState; readonly t: TranslateNS<'library'> }): ReactNode {
  return (
    <ol className={css.stepper}>
      {STEPS.map((step, index) => {
        const standing = stepStanding(step.state, state)
        return (
          <li key={step.state} className={clsx(css.step, css[`step_${standing}`])} data-standing={standing}>
            <span className={css.stepMark} aria-hidden>
              {standing === 'done' ? <IconCheckOutline14 /> : index + 1}
            </span>
            <span className={css.stepLabel}>{t(step.key)}</span>
          </li>
        )
      })}
    </ol>
  )
}

function FileRow({ icon, label, path, open, canOpen }: {
  readonly icon: ReactNode
  readonly label: string
  readonly path: string
  readonly open: (path: string) => void
  readonly canOpen: boolean
}): ReactNode {
  const name = path.split(/[\\/]/u).pop() ?? path
  return (
    <li>
      <button type="button" className={css.file} onClick={() => { open(path) }} disabled={!canOpen} title={path}>
        <span className={css.fileIcon} aria-hidden>{icon}</span>
        <span className={css.fileTitles}>
          <span className={css.fileLabel}>{label}</span>
          <span className={css.fileName} dir="auto">{name}</span>
        </span>
      </button>
    </li>
  )
}

/**
 * The lecture page.
 * @param props.module - the lecture's module.
 * @param props.lecture - the lecture.
 * @param props.actions - registered actions.
 * @param props.open - open a workspace file.
 * @param props.canOpen - whether any panel can open files.
 * @param props.t - translate.
 */
export function LectureView({ module, lecture, actions, job, open, canOpen, t }: {
  readonly module: LibraryModule
  readonly lecture: LibraryLecture
  readonly actions: readonly LibraryAction[]
  /** The job running on this lecture, shown in place of its actions. */
  readonly job?: LibraryJob | undefined
  readonly open: (path: string) => void
  readonly canOpen: boolean
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const files: ReactNode[] = []
  if (lecture.transcript !== undefined) {
    files.push(<FileRow key="transcript" icon={<IconTranscript />} label={t('lecture.file.transcript')} path={lecture.transcript} open={open} canOpen={canOpen} />)
  }
  if (lecture.draft !== undefined) {
    files.push(<FileRow key="draft" icon={<IconDraft />} label={t('lecture.file.draft')} path={lecture.draft} open={open} canOpen={canOpen} />)
  }
  if (lecture.verbatims !== undefined) {
    // One verbatim per recording: the boys' and the girls' lectures each have their own.
    for (const path of lecture.verbatims) {
      const name = path.split(/[\\/]/u).pop() ?? path
      files.push(<FileRow key={path} icon={<IconQuote />} label={t('lecture.file.verbatimOf', { recording: name.replace(/\.verbatim\.md$/u, '') })} path={path} open={open} canOpen={canOpen} />)
    }
  } else if (lecture.verbatim !== undefined) {
    files.push(<FileRow key="verbatim" icon={<IconQuote />} label={t('lecture.file.verbatim')} path={lecture.verbatim} open={open} canOpen={canOpen} />)
  }
  return (
    <div className={css.page}>
      <header className={css.pageHead}>
        <div className={css.pageTitles}>
          <p className={css.eyebrow}>{module.displayName}</p>
          <h1 className={css.pageTitle}><bdi>{lectureHeading(lecture)}</bdi></h1>
          <p className={css.pageSubtitle}>{lectureMeta(lecture, t)}</p>
        </div>
        <StateBadge state={lecture.state} t={t} />
      </header>
      <Stepper state={lecture.state} t={t} />
      <div className={css.lectureActions}>
        {job === undefined
          ? <ActionButtons actions={actions.filter(action => action.scope === 'lecture')} target={{ module, lecture }} />
          : <JobChip job={job} t={t} />}
      </div>
      {files.length > 0 && (
        <section className={css.section} aria-labelledby="library-files">
          <h2 id="library-files" className={css.sectionTitle}>{t('lecture.files')}</h2>
          <ul className={css.files}>{files}</ul>
        </section>
      )}
      {lecture.sources.length > 0 && (
        <section className={css.section} aria-labelledby="library-sources">
          <h2 id="library-sources" className={css.sectionTitle}>{t('lecture.sources')}</h2>
          <ul className={css.materials}>
            {lecture.sources.map(source => (
              <li key={source} className={css.material}>
                <IconRecording aria-hidden />
                <span dir="auto">{source}</span>
                {lecture.inNotebookOnly && <span className={css.chip}>{t('lecture.notebookOnly')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {lecture.parts > 0 && (
        <section className={css.section} aria-labelledby="library-lecture-materials">
          <h2 id="library-lecture-materials" className={css.sectionTitle}>{t('lecture.materials')}</h2>
          {lecture.materials === undefined || lecture.materials.length === 0
            ? <p className={css.sectionHint}>{t('lecture.materials.none')}</p>
            : (
              <ul className={css.materials}>
                {lecture.materials.map(material => (
                  <li key={material} className={css.material}>
                    <IconMaterial aria-hidden />
                    <span dir="auto">{material.split(/[\\/]/u).pop() ?? material}</span>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}
    </div>
  )
}
