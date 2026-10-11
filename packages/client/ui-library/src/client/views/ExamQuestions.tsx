/** Every question extracted from one exam paper, as the student reads it. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExamQuestion, ExamQuestionsPage, LectureEditing } from '../editing.ts'
import { PageHeader } from './PageHeader.tsx'
import type {} from '../locales.ts'
import css from './ExamQuestions.module.css'

// The engine Remote accepts at most ten questions per request.
const PAGE_SIZE = 10

/**
 * Drop the printed number the card already shows and the JSON escapes some extractions keep.
 * @param stem - extracted question text.
 * @returns the text to display.
 */
export function displayStem(stem: string): string {
  return stem.replace(/^\s*(?:Q\s*)?[0-9٠-٩]{1,3}\s*[.)\-:]\s*/u, '').replaceAll('\\"', '"').trim()
}

/**
 * Page through one paper's saved extraction, appending each page; nothing calls agy.
 * @param props - module, paper path, editing API, and localized copy.
 * @returns the paper's questions.
 */
export function ExamQuestionsView({ module, path, editing, t }: {
  readonly module: string
  readonly path: string
  readonly editing: LectureEditing
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [offset, setOffset] = useState(0)
  const [questions, setQuestions] = useState<readonly ExamQuestion[]>([])
  const [page, setPage] = useState<ExamQuestionsPage | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    if (editing.listExamQuestions === undefined) {
      setLoading(false)
      setError(t('examQuestions.unavailable'))
      return () => { controller.abort() }
    }
    setLoading(true)
    setError(undefined)
    void editing.listExamQuestions(module, path, offset, PAGE_SIZE, '', controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) { setError(result.message); return }
      setPage(result.value)
      setQuestions(previous => offset === 0 ? result.value.questions : [...previous, ...result.value.questions])
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort() }
  }, [editing, module, offset, path, t])

  const years = [...new Set(questions.map(question => question.year).filter(year => year !== null))]
  const facts = page === undefined ? undefined : [
    t('examQuestions.count', { count: String(page.total) }),
    ...years.length === 1 ? [String(years[0])] : [],
  ].join(' · ')
  return (
    <section className={css.page} aria-label={t('examQuestions.title')}>
      <PageHeader title={<bdi>{path.split('/').at(-1)}</bdi>} facts={facts} />
      {error !== undefined && <div className={css.error} role="alert">
        <span dir="auto">{t('examQuestions.failed', { message: error })}</span>
        <Button variant="ghost" size="sm" onClick={() => { setQuestions([]); setOffset(0) }}>{t('retry')}</Button>
      </div>}
      {!loading && error === undefined && questions.length === 0 && <p className={css.empty}>{t('examQuestions.empty')}</p>}
      {questions.length > 0 && <ol className={css.questions}>
        {questions.map((question, index) => <QuestionCard key={`${question.id}-${index}`} question={question} ordinal={index + 1} t={t} />)}
      </ol>}
      {loading && <div className={css.questions} role="status" aria-label={t('loading')} aria-busy>
        {[0, 1, 2].map(item => <div key={item} className={css.card}>
          <div className={css.head}><span className={css.number} data-skeleton="true" /><span className={css.bar} data-short="true" /></div>
          <span className={css.bar} style={{ inlineSize: `${70 - item * 8}%` }} />
          {[0, 1, 2, 3].map(option => <span key={option} className={css.bar} data-option="true" />)}
        </div>)}
      </div>}
      {!loading && page?.nextOffset != null && <Button variant="outline" className={css.moreButton}
        onClick={() => { if (page.nextOffset != null) setOffset(page.nextOffset) }}>
        {t('examQuestions.more', { shown: String(questions.length), total: String(page.total) })}
      </Button>}
    </section>
  )
}

/**
 * One question card: number, year and kind, the question, its options with the answer marked, and any explanation.
 * @param props - question, its position in the paper, and copy.
 * @returns the card.
 */
function QuestionCard({ question, ordinal, t }: {
  readonly question: ExamQuestion
  readonly ordinal: number
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const options = Object.entries(question.options)
  const answer = question.answer?.toLocaleLowerCase() ?? null
  const status = question.answerStatus as string | undefined
  const written = options.length === 0
  const writtenAnswer = written ? question.sourceAnswer : null
  const note = answer !== null || writtenAnswer !== null ? undefined
    : status === 'uncertain' ? t('examQuestions.uncertain') : t('examQuestions.noKey')
  return (
    <li className={css.card}>
      <div className={css.head}>
        <span className={css.number}>{question.number ?? ordinal}</span>
        <span className={css.chips}>
          {question.year !== null && <span className={css.chip}>{question.year}</span>}
          <span className={css.chip} data-quiet="true">{t(question.kind === 'mcq' ? 'examQuestions.mcq' : 'examQuestions.written')}</span>
        </span>
      </div>
      <p className={css.stem} dir="auto">{displayStem(question.stem)}</p>
      {!written && <ul className={css.options}>
        {options.map(([label, text]) => {
          const correct = label.toLocaleLowerCase() === answer
          return <li key={label} className={css.option} data-correct={correct} dir="auto">
            <span className={css.letter} aria-hidden>{correct ? <IconCheckOutline14 /> : label.toUpperCase()}</span>
            <span className={css.optionText}>{text}</span>
            {correct && <span className={css.visuallyHidden}>{t('examQuestions.correct')}</span>}
          </li>
        })}
      </ul>}
      {writtenAnswer !== null && <div className={css.answer}><span className={css.label}>{t('examQuestions.answer')}</span><p dir="auto">{writtenAnswer}</p></div>}
      {note !== undefined && <p className={css.note}>{note}</p>}
      {question.explanation !== '' && <details className={css.explanation}>
        <summary>{t('examQuestions.explanation')}</summary>
        <p dir="auto">{question.explanation}</p>
      </details>}
    </li>
  )
}
