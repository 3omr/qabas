// @vitest-environment jsdom
/** One paper's questions as cards: the answer marked, no source plumbing, and paging by Show more. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import type { ExamQuestion, ExamQuestionsPage, LectureEditing } from '../src/client/editing.ts'
import { displayStem, displayText, ExamQuestionsView, optionLetter } from '../src/client/views/ExamQuestions.tsx'

const t = makeTranslate(en)
const question = (fields: Partial<ExamQuestion> = {}): ExamQuestion => ({
  id: 'pediatric-0001', number: 17, kind: 'mcq',
  stem: 'Which finding best identifies the condition?',
  options: { a: 'Finding one', b: 'Finding two' }, answer: 'b', answerStatus: 'printed',
  sourceAnswer: 'Finding two', explanation: 'The source includes this explanation.',
  section: 'Sheet1', year: 2023, topic: 'Neonatal jaundice',
  locator: { type: 'spreadsheet_row', sheet: 'Sheet1', row: 14, range: 'A14:G14' },
  needsReview: true, reviewReason: 'The source answer is printed unclearly.',
  ...fields,
})
function show(pages: (offset: number) => ExamQuestionsPage, translate = t) {
  const listExamQuestions = vi.fn(async (_module: string, _path: string, offset: number) => ({ ok: true as const, value: pages(offset) }))
  const view = render(<ExamQuestionsView module="pediatric" path="Questions/Pediatrics.xlsx"
    editing={{ listExamQuestions } as unknown as LectureEditing} t={translate} />)
  return { view, listExamQuestions }
}
const page = (questions: readonly ExamQuestion[], fields: Partial<ExamQuestionsPage> = {}): ExamQuestionsPage => ({
  path: 'Questions/Pediatrics.xlsx', sha256: 'a'.repeat(64), query: '', offset: 0, limit: 20,
  total: questions.length, questions, nextOffset: null, ...fields,
})

afterEach(cleanup)

it('shows a card with the answer marked and none of the source plumbing', async () => {
  const { view } = show(() => page([question()]))
  const card = (await view.findByText('Which finding best identifies the condition?')).closest('li') as HTMLElement
  expect(view.getByRole('heading', { level: 1, name: 'Pediatrics.xlsx' })).toBeTruthy()
  expect(within(card).getByText('17')).toBeTruthy()
  expect(within(card).getByText('2023')).toBeTruthy()
  expect(within(card).getByText(en['examQuestions.mcq'])).toBeTruthy()
  const correct = within(card).getByText('Finding two').closest('li') as HTMLElement
  expect(correct.dataset.correct).toBe('true')
  expect(within(correct).getByText(en['examQuestions.correct'])).toBeTruthy()
  expect((within(card).getByText('Finding one').closest('li') as HTMLElement).dataset.correct).toBe('false')
  expect(within(card).getByText(en['examQuestions.explanation'])).toBeTruthy()
  for (const hidden of ['Sheet1', 'Neonatal jaundice', 'printed unclearly', 'row 14']) expect(view.queryByText(new RegExp(hidden, 'u'))).toBeNull()
  expect(view.queryByRole('textbox')).toBeNull()
})

it('drops a printed number and escaped quotes from the question text', () => {
  expect(displayStem('1) Which plant is \\"cannabis sativa\'?')).toBe('Which plant is "cannabis sativa\'?')
  expect(displayStem('١٢- ما هو العلاج؟')).toBe('ما هو العلاج؟')
  expect(displayStem('2023 guidelines changed')).toBe('2023 guidelines changed')
  expect(displayText('Eye opening\\n except   all')).toBe('Eye opening except all')
  expect([optionLetter('b', 1), optionLetter('>', 0), optionLetter('@', 2)]).toEqual(['B', 'A', 'C'])
})

it('shows a written answer, and one no-answer note when the key is missing or the mark uncertain', async () => {
  const { view } = show(() => page([
    question({ id: 'w', number: 1, kind: 'written', options: {}, answer: null, sourceAnswer: 'Gastric lavage within one hour.' }),
    question({ id: 'n', number: 2, answer: null, answerStatus: 'no_key', sourceAnswer: null }),
    question({ id: 'u', number: 3, answer: null, answerStatus: 'uncertain' as NonNullable<ExamQuestion['answerStatus']>, sourceAnswer: null }),
  ]))
  await waitFor(() => { expect(view.getByText('Gastric lavage within one hour.')).toBeTruthy() })
  expect(view.getAllByText(en['examQuestions.noKey'])).toHaveLength(2)
})

it('appends the next page from Show more', async () => {
  const { view, listExamQuestions } = show(offset => offset === 0
    ? page([question({ id: 'first', stem: 'First question?' })], { total: 2, nextOffset: 20 })
    : page([question({ id: 'second', number: 18, stem: 'Second question?' })], { offset: 20, total: 2, nextOffset: null }))
  fireEvent.click(await view.findByRole('button', { name: t('examQuestions.more', { shown: '1', total: '2' }) }))
  await waitFor(() => { expect(view.getByText('Second question?')).toBeTruthy() })
  expect(view.getByText('First question?')).toBeTruthy()
  expect(listExamQuestions.mock.calls.map(call => call[2])).toEqual([0, 20])
  expect(view.queryByRole('button', { name: /Show more/u })).toBeNull()
})

it.each([['en', en], ['ar', dictionaries.library ?? {}]] as const)('renders a paper in %s', async (_language, dictionary) => {
  const translate = makeTranslate(dictionary)
  const { view } = show(() => page([question({ answer: null, answerStatus: 'no_key', explanation: '' })]), translate)
  expect(await view.findByText(translate('examQuestions.noKey'))).toBeTruthy()
  expect(view.getByText(translate('examQuestions.count', { count: '1' }) + ' · 2023')).toBeTruthy()
})
