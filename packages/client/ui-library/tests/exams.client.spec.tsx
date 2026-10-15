// @vitest-environment jsdom
/** The exams page: uploads start the question-bank job, rows show year and progress, and years are editable. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { EditOutcome, LectureEditing, ModuleFile } from '../src/client/editing.ts'
import type { LibraryJob } from '../src/client/jobs.ts'
import { ExamsView } from '../src/client/views/Exams.tsx'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'

const t = makeTranslate(en)
type Paper = ModuleFile & { readonly year?: number | null }
const paper = (name: string, fields: Partial<Paper> = {}): Paper => ({
  name, path: `Questions/${name}`, kind: 'question', inNotebook: false, preparation: 'pending', ...fields,
})
function engine(initial: readonly Paper[] = []) {
  const files: Paper[] = [...initial]
  return {
    files,
    listFiles: vi.fn(async () => ({ ok: true as const, value: [...files] })),
    importFile: vi.fn(async (_module: string, file: File, _kind: string, options?: { readonly name?: string }) => {
      const value = paper(options?.name ?? file.name)
      const existing = files.findIndex(item => item.path === value.path)
      if (existing < 0) files.push(value)
      else files[existing] = value
      return { ok: true as const, value }
    }),
    renameFile: vi.fn(async () => ({ ok: true as const, value: null })),
    trashFile: vi.fn(async (_module: string, path: string) => {
      files.splice(files.findIndex(item => item.path === path), 1)
      return { ok: true as const, value: { trash_path: `.trash/${path}`, id: `trash-${path}` } }
    }),
    setExamYear: vi.fn(async (_module: string, path: string, year: number | 'bank' | null): Promise<EditOutcome<null>> => {
      const index = files.findIndex(item => item.path === path)
      const detected = initial.find(item => item.path === path)?.year ?? null
      files[index] = { ...files[index] as Paper, year: year === 'bank' ? null : year ?? detected, yearSource: year === null ? 'paper' : 'owner' }
      return { ok: true, value: null }
    }),
  }
}
const job = (fields: Partial<LibraryJob>): LibraryJob => ({
  id: 'job-1', kind: 'questions', module: 'pediatric', moduleName: 'Pediatric', status: 'running', startedAt: 1, ...fields,
})
function show(editing: ReturnType<typeof engine>, props: Partial<Parameters<typeof ExamsView>[0]> = {}, translate = t) {
  const startIndex = vi.fn()
  const stopIndex = vi.fn()
  const openQuestions = vi.fn()
  const view = render(<ExamsView module="pediatric" editing={editing as unknown as LectureEditing} changed={vi.fn()}
    startIndex={startIndex} stopIndex={stopIndex} openQuestions={openQuestions} t={translate} {...props} />)
  return { view, startIndex, stopIndex, openQuestions }
}
function pick(view: ReturnType<typeof render>, names: readonly string[]) {
  fireEvent.change(view.getByLabelText(en['exams.none.add']), { target: { files: names.map(name => new File(['paper'], name)) } })
}
function row(view: ReturnType<typeof render>, name: string): HTMLElement {
  const papers = view.container.querySelector('ul[class*="rows"]') as HTMLElement
  return within(papers).getByText(name).closest('li') as HTMLElement
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('starts the question-bank job once when a batch of uploads settles', async () => {
  const editing = engine()
  const { view, startIndex } = show(editing)
  await waitFor(() => { expect(view.getByText(en['exams.empty'])).toBeTruthy() })
  pick(view, ['2023.pdf', '2024.docx'])
  await waitFor(() => { expect(startIndex).toHaveBeenCalledOnce() })
  expect(editing.importFile.mock.calls.map(call => call[3]?.name)).toEqual(['2023.pdf', '2024.docx'])
  expect(row(view, '2024.docx')).toBeTruthy()
})

it.each(['copy', 'replace', 'skip'] as const)('resolves a duplicate with %s without stopping the next upload', async (choice) => {
  const editing = engine([paper('2023.pdf')])
  const { view, startIndex } = show(editing)
  await waitFor(() => { expect(view.getByText('2023.pdf')).toBeTruthy() })
  pick(view, ['2023.pdf', '2024.pdf'])
  const dialog = await view.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: en[`exams.duplicate.${choice}`] }))
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull(); expect(startIndex).toHaveBeenCalledOnce() })
  const names = editing.importFile.mock.calls.map(call => call[3]?.name)
  expect(names).toEqual(choice === 'skip' ? ['2024.pdf'] : [choice === 'copy' ? '2023 (2).pdf' : '2023.pdf', '2024.pdf'])
  if (choice === 'replace') expect(editing.importFile.mock.calls[0]?.[3]).toMatchObject({ replace: true })
})

it('skips an upload with the same original bytes and does not index', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const contents = new TextEncoder().encode('same paper')
  const hash = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', contents)), byte => byte.toString(16).padStart(2, '0')).join('')
  const editing = engine([paper('2023.pdf', { sha256: hash })])
  const { view, startIndex } = show(editing)
  await waitFor(() => { expect(view.getByText('2023.pdf')).toBeTruthy() })
  const file = new File(['same paper'], '2023.pdf')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => contents.buffer })
  fireEvent.change(view.getByLabelText(en['exams.none.add']), { target: { files: [file] } })
  await waitFor(() => { expect(view.getByText(en['management.upload.skipped'])).toBeTruthy() })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(editing.importFile).not.toHaveBeenCalled()
  expect(startIndex).not.toHaveBeenCalled()
})

it('lists papers newest first with their year and question count, and nothing about reviews or sizes', async () => {
  const editing = engine([
    paper('Old.pdf', { indexed: true, questionCount: 20, year: 2021, size: 2048, questionReviewCount: 5 }),
    paper('New.pdf', { indexed: true, questionCount: 17, year: 2025 }),
    paper('Bank.pdf', { indexed: true, questionCount: 142 }),
  ])
  const { view } = show(editing)
  await waitFor(() => { expect(view.getByText('New.pdf')).toBeTruthy() })
  expect([...view.container.querySelectorAll('li')].map(item => within(item).getByRole('button', { name: /^\w+\.pdf$/u }).textContent))
    .toEqual(['New.pdf', 'Old.pdf', 'Bank.pdf'])
  expect(within(row(view, 'Old.pdf')).getByText('2021')).toBeTruthy()
  expect(within(row(view, 'Old.pdf')).getByText(t('exams.questions', { count: '20' }))).toBeTruthy()
  expect(view.getByText(t('exams.facts', { papers: '3', questions: '179' }))).toBeTruthy()
  expect(view.queryByText(/review/iu)).toBeNull()
  expect(view.queryByText(/KB|MB/u)).toBeNull()
  expect(view.queryByRole('searchbox')).toBeNull()
  expect(view.queryByRole('textbox')).toBeNull()
})

it('shows each paper in the running job and stops it', async () => {
  const editing = engine([paper('A.pdf', { indexed: true, questionCount: 9 }), paper('B.pdf'), paper('C.pdf'), paper('D.pdf')])
  const running = job({ papers: {
    'A.pdf': { phase: 'done', questions: 9 }, 'B.pdf': { phase: 'extracting', part: 2, parts: 3 },
    'C.pdf': { phase: 'reviewing' }, 'D.pdf': { phase: 'queued' },
  } })
  const { view, stopIndex } = show(editing, { job: running })
  await waitFor(() => { expect(view.getByText('B.pdf')).toBeTruthy() })
  expect(within(row(view, 'A.pdf')).getByText(t('exams.questions', { count: '9' }))).toBeTruthy()
  expect(within(row(view, 'B.pdf')).getByRole('status').textContent).toBe(`${en['exams.phase.extracting']} · ${t('exams.phase.part', { part: '2', parts: '3' })}`)
  expect(within(row(view, 'C.pdf')).getByRole('status').textContent).toBe(en['exams.phase.reviewing'])
  expect(within(row(view, 'D.pdf')).getByRole('status').textContent).toBe(en['exams.phase.queued'])
  expect(view.getByText(t('exams.job.papers', { done: '1', total: '4' }))).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en['exams.stop'] }))
  expect(stopIndex).toHaveBeenCalledWith('job-1')
})

it('says whether a failed paper was unreadable or the model run did not finish', async () => {
  const editing = engine([paper('Blank.pdf', { indexFailed: true, indexFailureCause: 'source' }),
    paper('Bank.txt', { indexFailed: true, indexFailureCause: 'model' }), paper('End_2021.txt'), paper('Old.pdf', { indexFailed: true })])
  const { view } = show(editing, { job: job({ papers: { 'End_2021.txt': { phase: 'failed', cause: 'model' } } }) })
  await waitFor(() => { expect(view.getByText('Blank.pdf')).toBeTruthy() })
  expect(within(row(view, 'Blank.pdf')).getByText(en['exams.phase.failed'])).toBeTruthy()
  expect(within(row(view, 'Bank.txt')).getByText(en['exams.phase.modelFailed'])).toBeTruthy()
  expect(within(row(view, 'End_2021.txt')).getByText(en['exams.phase.modelFailed'])).toBeTruthy()
  expect(within(row(view, 'Old.pdf')).getByText(en['exams.phase.failed'])).toBeTruthy()
})

it('names signed-out papers, opens Accounts and tools, and summarizes a finished job', async () => {
  const editing = engine([paper('Bank.txt', { indexFailed: true, indexFailureCause: 'auth' }),
    paper('Ready.txt', { indexed: true, questionCount: 4 }), paper('Blank.pdf', { indexFailed: true, indexFailureCause: 'source' })])
  const opened = vi.fn()
  window.addEventListener('dsh-desktop-open-settings', opened)
  try {
    const { view } = show(editing, { job: job({ status: 'running', papers: { 'Ready.txt': { phase: 'failed', cause: 'auth' } } }) })
    await waitFor(() => { expect(view.getByText('Bank.txt')).toBeTruthy() })
    expect(view.getByText(t('exams.signIn.body', { count: '2' }))).toBeTruthy()
    view.rerender(<ExamsView module="pediatric" editing={editing as unknown as LectureEditing} changed={vi.fn()} job={job({ status: 'done' })} t={t} />)
    expect(within(row(view, 'Bank.txt')).getByText(en['exams.phase.authFailed'])).toBeTruthy()
    expect(view.getByText(t('exams.job.done', { ready: '1', failed: '2' }))).toBeTruthy()
    const notice = view.getByText(t('exams.signIn.body', { count: '1' })).closest('[role="alert"]') as HTMLElement
    fireEvent.click(within(notice).getByRole('button', { name: en['exams.signIn.open'] }))
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ section: 'transcriber-engine' })
  } finally {
    window.removeEventListener('dsh-desktop-open-settings', opened)
  }
})

it('says why the last job ended and retries, and rereads papers when a job finishes', async () => {
  const editing = engine([paper('A.pdf', { preparation: 'failed' })])
  const { view, startIndex } = show(editing, { job: job({ status: 'running' }) })
  await waitFor(() => { expect(view.getByText('A.pdf')).toBeTruthy() })
  const reads = editing.listFiles.mock.calls.length
  view.rerender(<ExamsView module="pediatric" editing={editing as unknown as LectureEditing} changed={vi.fn()} startIndex={startIndex}
    job={job({ status: 'failed', error: 'agy is signed out' })} t={t} />)
  await waitFor(() => { expect(editing.listFiles.mock.calls.length).toBeGreaterThan(reads) })
  const alert = view.getByRole('alert')
  expect(alert.textContent).toContain(en['exams.job.failed'])
  expect(alert.textContent).toContain('agy is signed out')
  expect(within(alert).getByText('agy is signed out').closest('details')).not.toBeNull()
  expect(within(row(view, 'A.pdf')).getByText(en['exams.phase.failed'])).toBeTruthy()
  fireEvent.click(within(alert).getByRole('button', { name: en.retry }))
  expect(startIndex).toHaveBeenCalledOnce()
})

it('changes a paper year, marks it a question bank, and returns it to the detected year', async () => {
  const editing = engine([paper('Scan.pdf', { indexed: true, questionCount: 26, year: 2022, yearSource: 'paper' })])
  const { view } = show(editing)
  await waitFor(() => { expect(view.getByText('Scan.pdf')).toBeTruthy() })
  expect(view.queryByRole('button', { name: en['exams.year.auto'] })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: t('exams.year.edit', { year: '2022' }) }))
  const input = view.getByLabelText(en['exams.year.label'])
  fireEvent.change(input, { target: { value: '1800' } })
  expect(view.getByRole('button', { name: en['manage.save'] }).hasAttribute('disabled')).toBe(true)
  fireEvent.change(input, { target: { value: '2023' } })
  await act(async () => { fireEvent.submit(input.closest('form') as HTMLFormElement) })
  expect(editing.setExamYear).toHaveBeenCalledWith('pediatric', 'Questions/Scan.pdf', 2023)
  fireEvent.click(await view.findByRole('button', { name: t('exams.year.edit', { year: '2023' }) }))
  await act(async () => { fireEvent.click(view.getByRole('button', { name: en['exams.year.markBank'] })) })
  expect(editing.setExamYear).toHaveBeenLastCalledWith('pediatric', 'Questions/Scan.pdf', 'bank')
  fireEvent.click(await view.findByRole('button', { name: t('exams.year.edit', { year: en['exams.year.bank'] }) }))
  expect(view.queryByRole('button', { name: en['exams.year.markBank'] })).toBeNull()
  await act(async () => { fireEvent.click(view.getByRole('button', { name: en['exams.year.auto'] })) })
  expect(editing.setExamYear).toHaveBeenLastCalledWith('pediatric', 'Questions/Scan.pdf', null)
  expect(await view.findByRole('button', { name: t('exams.year.edit', { year: '2022' }) })).toBeTruthy()
})

it('labels a read paper without a year as a question bank', async () => {
  const { view } = show(engine([paper('Bank.pdf', { indexed: true, questionCount: 142, year: null }), paper('New.pdf')]))
  await waitFor(() => { expect(view.getByText('Bank.pdf')).toBeTruthy() })
  expect(within(row(view, 'Bank.pdf')).getByText(en['exams.year.bank'])).toBeTruthy()
  expect(within(row(view, 'New.pdf')).queryByText(en['exams.year.bank'])).toBeNull()
})

it('opens an indexed paper from its name and offers no questions for an unindexed one', async () => {
  const editing = engine([paper('Ready.pdf', { indexed: true, questionCount: 3 }), paper('New.pdf')])
  const { view, openQuestions } = show(editing)
  await waitFor(() => { expect(view.getByText('Ready.pdf')).toBeTruthy() })
  fireEvent.click(view.getByRole('button', { name: 'Ready.pdf' }))
  expect(openQuestions).toHaveBeenCalledWith('Questions/Ready.pdf')
  expect(view.queryByRole('button', { name: 'New.pdf' })).toBeNull()
  expect(within(row(view, 'New.pdf')).getByText(en['exams.phase.waiting'])).toBeTruthy()
})

it('trashes the selected papers after one confirmation', async () => {
  const editing = engine([paper('A.pdf'), paper('B.pdf'), paper('C.pdf')])
  const { view } = show(editing)
  await waitFor(() => { expect(view.getByText('A.pdf')).toBeTruthy() })
  expect(view.queryByRole('checkbox')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en['exams.pageMenu'] }))
  fireEvent.click(view.getByRole('menuitem', { name: en['exams.select'] }))
  fireEvent.click(view.getByRole('checkbox', { name: t('management.select', { name: 'A.pdf' }) }))
  fireEvent.click(view.getByRole('checkbox', { name: t('management.select', { name: 'C.pdf' }) }))
  fireEvent.click(view.getByRole('button', { name: t('management.trash.bulk', { count: 2 }) }))
  const dialog = await view.findByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.trash'] })) })
  await waitFor(() => { expect(editing.trashFile.mock.calls.map(call => call[1])).toEqual(['Questions/A.pdf', 'Questions/C.pdf']) })
  await waitFor(() => { expect(view.queryByText('A.pdf')).toBeNull() })
  expect(view.getByText('B.pdf')).toBeTruthy()
})

it.each([['en', en], ['ar', dictionaries.library ?? {}]] as const)('renders the page in %s', async (_language, dictionary) => {
  const translate = makeTranslate(dictionary)
  const editing = engine([paper('2024.pdf', { indexed: true, questionCount: 12, year: 2024 }), paper('2023.pdf', { preparation: 'failed' })])
  const { view } = show(editing, {}, translate)
  await waitFor(() => { expect(view.getByText('2024.pdf')).toBeTruthy() })
  expect(view.getByRole('heading', { level: 1, name: translate('exams.title') })).toBeTruthy()
  expect(view.getByRole('button', { name: translate('exams.none.add') })).toBeTruthy()
  expect(within(row(view, '2023.pdf')).getByText(translate('exams.phase.failed'))).toBeTruthy()
  expect(view.asFragment()).toMatchSnapshot()
})
