/**
 * The organization agy proposes for a module, laid out for the student to
 * check before anything is saved: each proposed lecture with its parts and
 * slides, ticked by default, its title editable, and what changes against the
 * module as it is now. Nothing reaches module.json until "Save".
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LectureDefinition, OrganizationProposal, ProposedLecture } from '../editing.ts'
import { displayTitle } from '../model.ts'
import type {} from '../locales.ts'
import css from './Proposal.module.css'

/** Where asking for a proposal stands. */
export type ProposalState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: OrganizationProposal }
  | { readonly status: 'failed'; readonly message: string }

/** The review's props. */
export interface ProposalReviewProps {
  readonly state: ProposalState
  readonly saving: boolean
  /** The engine's refusal of the last save. */
  readonly error: string | undefined
  readonly again: () => void
  readonly save: (lectures: readonly LectureDefinition[]) => void
  readonly close: () => void
  readonly t: TranslateNS<'library'>
}

/**
 * The proposed organization, for review.
 * @param props - see {@link ProposalReviewProps}.
 */
export function ProposalReview({ state, saving, error, again, save, close, t }: ProposalReviewProps): ReactNode {
  return (
    <Modal
      open
      onClose={close}
      title={t('propose.title')}
      closeLabel={t('manage.editor.close')}
      {...state.status === 'ready'
        ? {}
        : {
          footer: (
            <div className={css.footer}>
              {state.status === 'failed' && <Button variant="outline" onClick={again}>{t('propose.again')}</Button>}
              <Button variant="ghost" onClick={close}>{t('manage.editor.cancel')}</Button>
            </div>
          ),
        }}
    >
      {state.status === 'loading' && (
        <div className={css.waiting} role="status">
          <span className={css.spark} aria-hidden />
          <p>{t('propose.loading')}</p>
        </div>
      )}
      {state.status === 'failed' && <p className={css.error} role="alert" dir="auto">{state.message}</p>}
      {state.status === 'ready' && (
        <Review proposal={state.value} saving={saving} error={error} again={again} save={save} close={close} t={t} />
      )}
    </Modal>
  )
}

function Review({ proposal, saving, error, again, save, close, t }: {
  readonly proposal: OrganizationProposal
  readonly saving: boolean
  readonly error: string | undefined
  readonly again: () => void
  readonly save: (lectures: readonly LectureDefinition[]) => void
  readonly close: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  // Lectures that would not change start unticked: saving them again does nothing.
  const [chosen, setChosen] = useState<ReadonlySet<number>>(
    () => new Set(proposal.lectures.flatMap((lecture, index) => lecture.change === 'same' ? [] : [index])),
  )
  const [titles, setTitles] = useState<readonly string[]>(() => proposal.lectures.map(lecture => lecture.title))
  const picked = proposal.lectures.flatMap((lecture, index) => chosen.has(index)
    ? [{
      ...lecture.existingId === undefined ? {} : { id: lecture.existingId },
      title: (titles[index] ?? lecture.title).trim(),
      recordings: lecture.recordings,
      materials: lecture.materials,
    }]
    : [])
  const untitled = picked.some(lecture => lecture.title === '')
  const loose = [...proposal.unassigned.recordings, ...proposal.unassigned.materials]
  const toggle = (index: number): void => {
    const next = new Set(chosen)
    if (next.has(index)) next.delete(index)
    else next.add(index)
    setChosen(next)
  }

  return (
    <div className={css.review}>
      <p className={css.lead}>{t(proposal.source === 'agy' ? 'propose.lead.agy' : 'propose.lead.automatic')}</p>
      {proposal.notes.length > 0 && (
        <ul className={css.notes}>
          {proposal.notes.map(note => <li key={note} dir="auto">{note}</li>)}
        </ul>
      )}

      <ul className={css.lectures}>
        {proposal.lectures.map((lecture, index) => (
          <Proposed
            key={`${lecture.title}:${String(index)}`}
            lecture={lecture}
            title={titles[index] ?? lecture.title}
            rename={(title) => { setTitles(titles.map((value, at) => at === index ? title : value)) }}
            chosen={chosen.has(index)}
            toggle={() => { toggle(index) }}
            t={t}
          />
        ))}
      </ul>

      {loose.length > 0 && (
        <section className={css.loose}>
          <h4 className={css.looseTitle}>{t('propose.unassigned', { count: String(loose.length) })}</h4>
          <p className={css.looseNames} dir="ltr">{loose.join(' · ')}</p>
        </section>
      )}

      <div className={css.footer}>
        {untitled && <span className={css.error} role="alert">{t('manage.problem.title')}</span>}
        {!untitled && error !== undefined && <span className={css.error} role="alert" dir="auto">{error}</span>}
        <Button variant="ghost" onClick={again} disabled={saving}>{t('propose.again')}</Button>
        <Button variant="ghost" onClick={close}>{t('manage.editor.cancel')}</Button>
        <Button variant="primary" disabled={saving || picked.length === 0 || untitled} onClick={() => { save(picked) }}>
          {saving ? t('manage.saving') : t('propose.save', { count: String(picked.length) })}
        </Button>
      </div>
    </div>
  )
}

function Proposed({ lecture, title, rename, chosen, toggle, t }: {
  readonly lecture: ProposedLecture
  readonly title: string
  readonly rename: (title: string) => void
  readonly chosen: boolean
  readonly toggle: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  return (
    <li className={clsx(css.lecture, !chosen && css.lectureOff)} data-change={lecture.change}>
      <div className={css.lectureHead}>
        <input
          type="checkbox"
          className={css.tick}
          checked={chosen}
          aria-label={t('propose.include', { title: displayTitle(title) })}
          onChange={toggle}
        />
        <Input
          dir="auto"
          className={clsx(css.titleInput)}
          value={title}
          aria-label={t('manage.editor.title')}
          disabled={!chosen}
          onChange={(event) => { rename(event.currentTarget.value) }}
        />
        <span className={css.change}>{t(`propose.change.${lecture.change}`)}</span>
      </div>
      <ol className={css.parts}>
        {lecture.recordings.map((name, index) => (
          <li key={name}>
            <span className={css.partNumber}>{t('manage.editor.part', { part: String(index + 1) })}</span>
            <span className={css.name} dir="ltr" title={name}>{name}</span>
          </li>
        ))}
      </ol>
      {lecture.materials.length > 0 && (
        <ul className={css.materials}>
          {lecture.materials.map(name => <li key={name} className={css.name} dir="ltr" title={name}>{name}</li>)}
        </ul>
      )}
    </li>
  )
}
