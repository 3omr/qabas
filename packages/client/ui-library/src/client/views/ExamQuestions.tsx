/** Review every extracted question from one original exam file. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExamQuestionLocator, ExamQuestionsPage, LectureEditing } from '../editing.ts'
import type {} from '../locales.ts'
import css from './ExamQuestions.module.css'

const PAGE_SIZE = 10

function locatorParts(locator: ExamQuestionLocator | null, t: TranslateNS<'library'>): string[] {
  if (locator === null) return []
  switch (locator.type) {
    case 'page': return [t('examQuestions.page', { page: String(locator.page) })]
    case 'line': return [t('examQuestions.line', { line: String(locator.line) })]
    case 'spreadsheet_row': return [t('examQuestions.sheetRow', { sheet: locator.sheet, row: String(locator.row) })]
    case 'paragraph': return [t('examQuestions.paragraph', { paragraph: String(locator.paragraph) })]
    case 'table_row': return [t('examQuestions.tableRow', { table: String(locator.table), row: String(locator.row) })]
    case 'multiple': return locator.items.flatMap(item => locatorParts(item, t))
  }
}

/**
 * Page the saved extraction for one exam file without rerunning agy.
 * @param props - selected module and file, editing API, return action, and localized copy.
 * @returns searchable source questions with their recorded answers and locations.
 */
export function ExamQuestionsView({ module, path, editing, back, t }: {
  readonly module: string
  readonly path: string
  readonly editing: LectureEditing
  readonly back: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<ExamQuestionsPage | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const list = editing.listExamQuestions

  useEffect(() => {
    const controller = new AbortController()
    if (list === undefined) {
      setLoading(false)
      setError(t('examQuestions.unavailable'))
      return () => { controller.abort() }
    }
    setLoading(true)
    setPage(undefined)
    setError(undefined)
    void list(module, path, offset, PAGE_SIZE, query, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (!result.ok) { setError(result.message); return }
      setPage(result.value)
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => { controller.abort() }
  }, [list, module, offset, path, query, t])

  const pages = page?.questions ?? []
  return (
    <section className={css.page} aria-label={t('examQuestions.title')}>
      <Button variant="ghost" onClick={back}>{t('examQuestions.back')}</Button>
      <header className={css.header}>
        <div><h2 className={css.title}>{t('examQuestions.title')}</h2><p className={css.file} dir="auto">{path.split('/').at(-1)}</p></div>
        {page !== undefined && <span className={css.count}>{t('examQuestions.count', { count: String(page.total) })}</span>}
      </header>
      <Input value={query} onChange={(event) => { setQuery(event.currentTarget.value); setOffset(0) }}
        placeholder={t('examQuestions.search')} aria-label={t('examQuestions.search')} />
      {loading && <p role="status">{t('loading')}</p>}
      {error !== undefined && <p className={css.error} role="alert">{t('examQuestions.failed', { message: error })}</p>}
      {!loading && error === undefined && pages.length === 0 && <p className={css.empty}>{t('examQuestions.empty')}</p>}
      <ol className={css.questions} start={offset + 1}>
        {pages.map((question, index) => {
          const answer = question.answer === null
            ? question.sourceAnswer
            : `${question.answer.toUpperCase()}. ${question.options[question.answer] ?? question.sourceAnswer ?? ''}`
          const locations = locatorParts(question.locator, t)
          return (
            <li className={css.question} value={offset + index + 1} key={`${question.id}-${index}`}>
              <article>
                <div className={css.questionHead}>
                  <span className={css.kind}>{t(question.kind === 'mcq' ? 'examQuestions.mcq' : 'examQuestions.written')}</span>
                  {question.year !== null && <span className={css.meta}>{t('examQuestions.year', { year: String(question.year) })}</span>}
                  {question.section !== '' && <span className={css.meta} dir="auto">{question.section}</span>}
                  {question.needsReview && <span className={css.review}>{t('examQuestions.review')}</span>}
                </div>
                <h3 className={css.stem} dir="auto">{question.number === null ? question.stem : `${question.number}. ${question.stem}`}</h3>
                {Object.keys(question.options).length > 0 && <ul className={css.options}>
                  {Object.entries(question.options).map(([label, text]) => (
                    <li key={label} dir="auto"><b>{label.toUpperCase()}.</b> {text}</li>
                  ))}
                </ul>}
                <dl className={css.details}>
                  <div><dt>{t('examQuestions.answer')}</dt><dd dir="auto">{answer ?? t('examQuestions.noAnswer')}</dd></div>
                  {question.explanation !== '' && <div><dt>{t('examQuestions.explanation')}</dt><dd dir="auto">{question.explanation}</dd></div>}
                  {question.topic !== null && <div><dt>{t('examQuestions.topic')}</dt><dd dir="auto">{question.topic}</dd></div>}
                  {locations.length > 0 && <div><dt>{t('examQuestions.source')}</dt><dd dir="auto">{[...new Set(locations)].join(' · ')}</dd></div>}
                  {question.reviewReason !== null && <div><dt>{t('examQuestions.reviewNote')}</dt><dd dir="auto">{question.reviewReason}</dd></div>}
                </dl>
              </article>
            </li>
          )
        })}
      </ol>
      {page !== undefined && page.total > PAGE_SIZE && <nav className={css.pagination} aria-label={t('examQuestions.pagination')}>
        <Button variant="outline" disabled={loading || offset === 0} onClick={() => { setOffset(Math.max(0, offset - page.limit)) }}>{t('examQuestions.previous')}</Button>
        <span>{t('examQuestions.range', { from: String(offset + 1), to: String(Math.min(offset + pages.length, page.total)), total: String(page.total) })}</span>
        <Button variant="outline" disabled={loading || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffset(page.nextOffset) }}>{t('examQuestions.next')}</Button>
      </nav>}
    </section>
  )
}
