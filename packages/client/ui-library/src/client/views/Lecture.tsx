/**
 * One lecture, built around what a student opens it for: the transcript.
 *
 * The transcript (or, before it exists, the draft, or the action that makes
 * it) is the page's one large element, with its next action beside it. The
 * doctor's words verbatim are raw material, kept one click away under a
 * fold. The lecture's sources -- its recordings in part order and its slides
 * and books -- close the page as a reference.
 *
 * While a lecture is unfinished the stepper names the three things a
 * transcription makes, in the order it makes them, so a lecture that stopped
 * half way says where it stopped.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconDraft, IconMaterial, IconQuote, IconRecording, IconTranscript } from '../icons.tsx'
import { displayTitle, lectureHeading, type LectureState, type LibraryLecture, type LibraryModule } from '../model.ts'
import { ActionButtons, StateBadge } from '../parts.tsx'
import type { LibraryJob } from '../jobs.ts'
import { JobChip } from '../JobsTray.tsx'
import type { LibraryAction } from '../service.ts'
import type { EditOutcome, TranscriptKind } from '../editing.ts'
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

/** The lecture page's props. */
interface LectureViewProps {
  readonly module: LibraryModule
  readonly lecture: LibraryLecture
  readonly actions: readonly LibraryAction[]
  /** The job running on this lecture, shown in place of its actions. */
  readonly job?: LibraryJob | undefined
  readonly open: (path: string) => void
  readonly canOpen: boolean
  readonly removeTranscript?: ((kind: TranscriptKind) => Promise<EditOutcome<unknown>>) | undefined
  readonly changed?: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}

/**
 * The lecture page.
 * @param props - see {@link LectureViewProps}.
 */
export function LectureView({ module, lecture, actions, job, open, canOpen, removeTranscript, changed, t }: LectureViewProps): ReactNode {
  const [error, setError] = useState<string | undefined>(undefined)
  // Nothing is removed under a running job: it may be writing the very file.
  const removal = (kind: TranscriptKind, what: string): (() => void) | undefined => {
    if (removeTranscript === undefined || job !== undefined) return undefined
    return () => {
      if (!window.confirm(t('lecture.remove.confirm', { what, title: displayTitle(lecture.title) }))) return
      setError(undefined)
      void removeTranscript(kind).then((answer) => {
        if (answer.ok) changed?.()
        else setError(answer.message)
      })
    }
  }
  const lectureActions = job === undefined
    ? <ActionButtons actions={actions.filter(action => action.scope === 'lecture')} target={{ module, lecture }} />
    : <JobChip job={job} t={t} />
  const verbatims = lecture.verbatims ?? (lecture.verbatim === undefined ? [] : [lecture.verbatim])
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
      {lecture.state !== 'final' && <Stepper state={lecture.state} t={t} />}

      <Hero
        lecture={lecture}
        actions={lectureActions}
        open={open}
        canOpen={canOpen}
        removeFinal={removal('final', t('lecture.file.transcript'))}
        removeDraft={removal('draft', t('lecture.file.draft'))}
        t={t}
      />
      {error !== undefined && <p className={css.calloutError} role="alert" dir="auto">{error}</p>}

      {verbatims.length > 0 && (
        <VerbatimFold
          paths={verbatims}
          open={open}
          canOpen={canOpen}
          remove={removal('verbatim', t(verbatims.length > 1 ? 'lecture.file.verbatimAll' : 'lecture.file.verbatim'))}
          t={t}
        />
      )}

      <Sources lecture={lecture} t={t} />
    </div>
  )
}

/** A path's last segment. */
function fileName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path
}

/**
 * The page's one large element: the transcript to read, with what to do next
 * beside it. Before a transcript exists it is the draft; before that, the
 * action that starts the lecture.
 */
function Hero({ lecture, actions, open, canOpen, removeFinal, removeDraft, t }: {
  readonly lecture: LibraryLecture
  readonly actions: ReactNode
  readonly open: (path: string) => void
  readonly canOpen: boolean
  readonly removeFinal: (() => void) | undefined
  readonly removeDraft: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const main = lecture.transcript ?? lecture.draft
  if (main === undefined) {
    return (
      <section className={css.lectureHero} data-kind="empty" aria-labelledby="lecture-hero">
        <div className={css.lectureHeroText}>
          <h2 id="lecture-hero" className={css.lectureHeroTitle}>{t('lecture.hero.none')}</h2>
          <p className={css.lectureHeroSub}>{t(lecture.state === 'verbatim' ? 'lecture.hero.verbatimReady' : 'lecture.hero.start')}</p>
        </div>
        <div className={css.lectureHeroActions}>{actions}</div>
      </section>
    )
  }
  const isFinal = lecture.transcript !== undefined
  const remove = isFinal ? removeFinal : removeDraft
  const label = t(isFinal ? 'lecture.file.transcript' : 'lecture.file.draft')
  return (
    <section className={css.lectureHero} data-kind={isFinal ? 'final' : 'draft'} aria-labelledby="lecture-hero">
      <div className={css.lectureHeroMain}>
        <span className={css.lectureHeroIcon} aria-hidden>{isFinal ? <IconTranscript /> : <IconDraft />}</span>
        <div className={css.lectureHeroText}>
          <h2 id="lecture-hero" className={css.lectureHeroTitle}>{label}</h2>
          <p className={css.lectureHeroSub} dir="auto">{isFinal ? fileName(main) : t('lecture.hero.draftNote')}</p>
        </div>
        {remove !== undefined && (
          <button type="button" className={css.lectureHeroRemove} aria-label={t('lecture.remove', { what: label })} title={t('lecture.remove', { what: label })} onClick={remove}>×</button>
        )}
      </div>
      <div className={css.lectureHeroActions}>
        <Button variant="primary" disabled={!canOpen} onClick={() => { open(main) }}>
          {t(isFinal ? 'lecture.hero.read' : 'lecture.hero.readDraft')}
        </Button>
        {actions}
      </div>
      {isFinal && lecture.draft !== undefined && (
        // A redo in progress: the new draft waits beside the transcript it will replace.
        <div className={css.lectureHeroDraft}>
          <IconDraft aria-hidden />
          <span>{t('lecture.hero.newerDraft')}</span>
          <button type="button" className={css.linkButton} disabled={!canOpen} onClick={() => { open(lecture.draft as string) }}>
            {t('lecture.hero.openDraft')}
          </button>
          {removeDraft !== undefined && (
            <button type="button" className={css.linkButton} onClick={removeDraft}>{t('lecture.remove', { what: t('lecture.file.draft') })}</button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The doctor's words verbatim: raw material the transcript is written from,
 * folded away until asked for.
 */
function VerbatimFold({ paths, open, canOpen, remove, t }: {
  readonly paths: readonly string[]
  readonly open: (path: string) => void
  readonly canOpen: boolean
  readonly remove: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [shown, setShown] = useState(false)
  return (
    <section className={css.fold} aria-labelledby="lecture-verbatim">
      <div className={css.foldHead}>
        <button type="button" id="lecture-verbatim" className={css.foldButton} aria-expanded={shown} onClick={() => { setShown(!shown) }}>
          <span className={css.trashChevron} data-open={shown} aria-hidden>›</span>
          <IconQuote aria-hidden />
          <span>{t('lecture.verbatim.title', { count: String(paths.length) })}</span>
        </button>
        {shown && remove !== undefined && (
          <button type="button" className={css.linkButton} onClick={remove}>{t('lecture.verbatim.remove')}</button>
        )}
      </div>
      {shown && (
        <ul className={css.foldList}>
          {paths.map(path => (
            <li key={path}>
              <button type="button" className={css.foldRow} disabled={!canOpen} onClick={() => { open(path) }} title={path}>
                <span dir="auto">{fileName(path).replace(/\.verbatim\.md$/u, '')}</span>
                <span className={css.foldOpen}>{t('lecture.verbatim.open')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Where the lecture comes from: its recordings in part order, then its
 * slides and books, as one reference card.
 */
function Sources({ lecture, t }: { readonly lecture: LibraryLecture; readonly t: TranslateNS<'library'> }): ReactNode {
  if (lecture.sources.length === 0 && lecture.parts === 0) return null
  const materials = lecture.materials ?? []
  return (
    <section className={css.section} aria-labelledby="lecture-sources">
      <h2 id="lecture-sources" className={css.sectionTitle}>{t('lecture.sourcesTitle')}</h2>
      <div className={css.sourcesCard}>
        {lecture.sources.length > 0 && (
          <div className={css.sourceGroup}>
            <h3 className={css.sourceGroupTitle}>{t('lecture.sources')}</h3>
            <ol className={css.sourceList}>
              {lecture.sources.map(source => (
                <li key={source} className={css.sourceRow}>
                  <IconRecording aria-hidden />
                  <span className={css.sourceName} dir="auto">{source}</span>
                  {lecture.inNotebookOnly && <span className={css.chip}>{t('lecture.notebookOnly')}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
        {lecture.parts > 0 && (
          <div className={css.sourceGroup}>
            <h3 className={css.sourceGroupTitle}>{t('lecture.materials')}</h3>
            {materials.length === 0
              ? <p className={css.sectionHint}>{t('lecture.materials.none')}</p>
              : (
                <ul className={css.sourceList}>
                  {materials.map(material => (
                    <li key={material} className={css.sourceRow}>
                      <IconMaterial aria-hidden />
                      <span className={css.sourceName} dir="auto">{fileName(material)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        )}
      </div>
    </section>
  )
}
