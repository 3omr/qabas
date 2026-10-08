// @vitest-environment jsdom
/** The file-scoped question viewer's source details, search and paging. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { ExamQuestionsPage, LectureEditing } from '../src/client/editing.ts'
import { ExamQuestionsView } from '../src/client/views/ExamQuestions.tsx'

const t = makeTranslate(en)
const question = {
  id: 'pediatric-0001', number: 17, kind: 'mcq' as const,
  stem: 'Which finding best identifies the condition?',
  options: { a: 'Finding one', b: 'Finding two' }, answer: 'b',
  sourceAnswer: 'Finding two', explanation: 'The source includes this explanation.',
  section: 'Sheet1', year: 2023,
  topic: null,
  locator: { type: 'spreadsheet_row' as const, sheet: 'Sheet1', row: 14, range: 'A14:G14' },
  needsReview: true, reviewReason: 'The source answer is printed unclearly.',
}
const page = (offset = 0): ExamQuestionsPage => ({
  path: 'Questions/Pediatrics.xlsx', sha256: 'a'.repeat(64), query: '', offset, limit: 10,
  total: 11, questions: [question], nextOffset: offset === 0 ? 10 : null,
})

afterEach(cleanup)

it('shows each source field and searches the saved extraction', async () => {
  const listExamQuestions = vi.fn(async (_module: string, _path: string, _offset: number, _limit: number, query: string) => ({
    ok: true as const, value: { ...page(), query },
  }))
  const editing = { listExamQuestions } as unknown as LectureEditing
  const view = render(<ExamQuestionsView module="pediatric" path="Questions/Pediatrics.xlsx"
    editing={editing} back={vi.fn()} t={t} />)

  expect(await view.findByRole('heading', { name: `${question.number}. ${question.stem}` })).toBeTruthy()
  expect(view.getAllByText('B. Finding two').length).toBeGreaterThanOrEqual(1)
  expect(view.getByText('The source includes this explanation.')).toBeTruthy()
  expect(view.getByText('Sheet1, row 14')).toBeTruthy()
  expect(view.getByText('The source answer is printed unclearly.')).toBeTruthy()

  fireEvent.change(view.getByRole('textbox', { name: en['examQuestions.search'] }), { target: { value: 'Finding two' } })
  await waitFor(() => { expect(listExamQuestions).toHaveBeenLastCalledWith('pediatric', 'Questions/Pediatrics.xlsx', 0, 10, 'Finding two', expect.any(AbortSignal)) })
})

it('requests the next source page without applying the lecture-results cap', async () => {
  const listExamQuestions = vi.fn(async (_module: string, _path: string, offset: number) => ({
    ok: true as const, value: page(offset),
  }))
  const view = render(<ExamQuestionsView module="pediatric" path="Questions/Pediatrics.xlsx"
    editing={{ listExamQuestions } as unknown as LectureEditing} back={vi.fn()} t={t} />)
  await view.findByRole('heading', { name: `${question.number}. ${question.stem}` })
  fireEvent.click(view.getByRole('button', { name: en['examQuestions.next'] }))

  await waitFor(() => { expect(listExamQuestions).toHaveBeenLastCalledWith('pediatric', 'Questions/Pediatrics.xlsx', 10, 10, '', expect.any(AbortSignal)) })
  expect(view.getByText('11 questions')).toBeTruthy()
})
