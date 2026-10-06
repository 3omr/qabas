// @vitest-environment jsdom
/** Exam upload, conflict resolution, partial failure, retry, cancellation and localization. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { webcrypto } from 'node:crypto'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { EditOutcome, LectureEditing, ModuleFile } from '../src/client/editing.ts'
import { ExamsView } from '../src/client/views/Exams.tsx'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'

const t = makeTranslate(en)
const paper = (name: string, preparation: ModuleFile['preparation'] = 'pending'): ModuleFile => ({
  name, path: `Questions/${name}`, kind: 'question', inNotebook: false, preparation,
})
function engine(initial: readonly ModuleFile[] = []) {
  const files = [...initial]
  return {
    listFiles: vi.fn(async () => ({ ok: true as const, value: [...files] })),
    importFile: vi.fn(async (_module: string, file: File, _kind: string, options?: { readonly name?: string }) => {
      const value = paper(options?.name ?? file.name)
      const existing = files.findIndex(paper => paper.path === value.path)
      if (existing < 0) files.push(value)
      else files[existing] = value
      return { ok: true as const, value }
    }),
    prepareExamFile: vi.fn(async (_module: string, path: string, _signal?: AbortSignal): Promise<EditOutcome<null>> => {
      const index = files.findIndex(file => file.path === path)
      if (files[index] !== undefined) files[index] = { ...files[index], preparation: 'ready' }
      return { ok: true as const, value: null }
    }),
    buildQuestionIndex: vi.fn(async () => {
      for (let index = 0; index < files.length; index++) files[index] = { ...(files[index] as ModuleFile), indexed: true, questionCount: 1 }
      return { ok: true as const, value: null }
    }),
    renameFile: vi.fn(async () => ({ ok: true as const, value: null })),
    trashFile: vi.fn(async () => ({ ok: true as const, value: null })),
  }
}
function show(editing: ReturnType<typeof engine>, translate = t) {
  return render(<ExamsView module="pediatric" editing={editing as unknown as LectureEditing} changed={vi.fn()} t={translate} />)
}
function pick(view: ReturnType<typeof show>, names: readonly string[]) {
  fireEvent.change(view.getByLabelText(en['exams.none.add']), { target: { files: names.map(name => new File(['paper'], name)) } })
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('reads each uploaded paper before indexing and keeps adding available afterwards', async () => {
  const editing = engine()
  const view = show(editing)
  await waitFor(() => { expect(view.getByRole('button', { name: en['exams.none.add'] }).hasAttribute('disabled')).toBe(false) })
  pick(view, ['2023.pdf', '2024.docx'])
  await waitFor(() => { expect(editing.buildQuestionIndex).toHaveBeenCalledOnce() })
  expect(editing.prepareExamFile.mock.calls.map(call => call[1])).toEqual(['Questions/2023.pdf', 'Questions/2024.docx'])
  expect(editing.buildQuestionIndex.mock.invocationCallOrder[0]).toBeGreaterThan(editing.prepareExamFile.mock.invocationCallOrder[1] ?? 0)
  await waitFor(() => { expect(view.getAllByText(en['exams.ready'])).toHaveLength(2) })
  expect(view.getByRole('button', { name: en['exams.none.add'] }).hasAttribute('disabled')).toBe(false)
})

it('keeps successful uploads when one paper fails, continues the batch and retries the affected file', async () => {
  const editing = engine()
  editing.prepareExamFile.mockResolvedValueOnce({ ok: false, message: 'OCR missing' } as never)
  const view = show(editing)
  await waitFor(() => { expect(view.getByText(en['exams.empty'])).toBeTruthy() })
  pick(view, ['2023.pdf', '2024.pdf'])
  await waitFor(() => { expect(editing.prepareExamFile).toHaveBeenCalledTimes(2) })
  await waitFor(() => { expect(view.getByRole('button', { name: en.retry })).toBeTruthy() })
  expect(editing.importFile).toHaveBeenCalledTimes(2)
  expect(editing.buildQuestionIndex).not.toHaveBeenCalled()
  expect(view.getByText('2024.pdf')).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: en.retry }))
  await waitFor(() => { expect(editing.buildQuestionIndex).toHaveBeenCalledOnce() })
})

it.each(['copy', 'replace', 'skip'] as const)('resolves a duplicate with %s without stopping the next upload', async (choice) => {
  const editing = engine([paper('2023.pdf')])
  const view = show(editing)
  await waitFor(() => { expect(view.getByText('2023.pdf')).toBeTruthy() })
  pick(view, ['2023.pdf', '2024.pdf'])
  const dialog = await view.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: en[`exams.duplicate.${choice}`] }))
  await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull(); expect(editing.buildQuestionIndex).toHaveBeenCalledOnce() })
  const names = editing.importFile.mock.calls.map(call => call[3]?.name)
  expect(names).toEqual(choice === 'skip' ? ['2024.pdf'] : [choice === 'copy' ? '2023 (2).pdf' : '2023.pdf', '2024.pdf'])
  if (choice === 'replace') expect(editing.importFile.mock.calls[0]?.[3]).toMatchObject({ replace: true })
})

it('skips an upload with the same original bytes', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const contents = new TextEncoder().encode('same paper')
  const hash = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', contents)), byte => byte.toString(16).padStart(2, '0')).join('')
  const editing = engine([{ ...paper('2023.pdf', 'ready'), sha256: hash }])
  const view = show(editing)
  await waitFor(() => { expect(view.getByText('2023.pdf')).toBeTruthy() })
  const file = new File(['same paper'], '2023.pdf')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => contents.buffer })
  fireEvent.change(view.getByLabelText(en['exams.none.add']), { target: { files: [file] } })
  await waitFor(() => { expect(view.getByRole('button', { name: en['exams.none.add'] }).hasAttribute('disabled')).toBe(false) })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(editing.importFile).not.toHaveBeenCalled()
  expect(editing.buildQuestionIndex).not.toHaveBeenCalled()
})

it('distinguishes extracted text from an indexed paper and offers indexing', async () => {
  const editing = engine([{ ...paper('2023.pdf', 'ready'), indexed: false }])
  const view = show(editing)
  await waitFor(() => { expect(view.getByText(en['exams.ready'])).toBeTruthy() })
  expect(view.getByText(en['exams.notIndexed'])).toBeTruthy()
  expect(view.queryByText(en['exams.indexed'])).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en['exams.indexNow'] }))
  await waitFor(() => { expect(view.getByText(en['exams.indexed'])).toBeTruthy() })
  expect(view.getByText('1 questions')).toBeTruthy()
})

it('collects only unread papers and reuses files already ready for the bank', async () => {
  const editing = engine([
    { ...paper('2023.pdf', 'ready'), indexed: true },
    { ...paper('2024.txt', 'ready'), indexed: false },
    paper('2025.pdf'),
  ])
  const view = show(editing)
  await waitFor(() => { expect(view.getByRole('button', { name: en['exams.collect'] })).toBeTruthy() })
  fireEvent.click(view.getByRole('button', { name: en['exams.collect'] }))
  await waitFor(() => { expect(editing.buildQuestionIndex).toHaveBeenCalledOnce() })
  expect(editing.prepareExamFile.mock.calls.map(call => call[1])).toEqual(['Questions/2025.pdf'])
  await waitFor(() => { expect(view.getByRole('button', { name: en['exams.refresh'] })).toBeTruthy() })
})

it('updates a completed bank without reading every paper again', async () => {
  const editing = engine([{ ...paper('2023.pdf', 'ready'), indexed: true }])
  const view = show(editing)
  await waitFor(() => { expect(view.getByRole('button', { name: en['exams.refresh'] })).toBeTruthy() })
  expect(view.queryByRole('button', { name: en['exams.collect'] })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: en['exams.refresh'] }))
  await waitFor(() => { expect(editing.buildQuestionIndex).toHaveBeenCalledOnce() })
  expect(editing.prepareExamFile).not.toHaveBeenCalled()
})

it('cancels active reading, retains the uploaded original and does not start another file', async () => {
  const editing = engine()
  let signal: AbortSignal | undefined
  editing.prepareExamFile = vi.fn(async (_module: string, _path: string, current?: AbortSignal) => {
    signal = current
    return await new Promise<EditOutcome<null>>((resolve) => { current?.addEventListener('abort', () => { resolve({ ok: false, message: 'cancelled' }) }, { once: true }) })
  })
  const view = show(editing)
  await waitFor(() => { expect(view.getByText(en['exams.empty'])).toBeTruthy() })
  pick(view, ['2023.pdf', '2024.pdf'])
  await waitFor(() => { expect(signal).toBeDefined() })
  fireEvent.click(view.getByRole('button', { name: en['exams.stop'] }))
  await waitFor(() => { expect(view.queryByRole('button', { name: en['exams.stop'] })).toBeNull() })
  expect(signal?.aborted).toBe(true)
  expect(editing.importFile).toHaveBeenCalledOnce()
  expect(editing.buildQuestionIndex).not.toHaveBeenCalled()
  expect(view.getByText('2023.pdf')).toBeTruthy()
})

it.each([['en', en], ['ar', dictionaries.library ?? {}]] as const)('shows localized exam controls in %s', async (_language, dictionary) => {
  const translate = makeTranslate(dictionary)
  const view = show(engine([paper('2023.pdf', 'failed'), { ...paper('2024.pdf', 'ready'), indexed: true, questionCount: 12 }, paper('2025.pdf')]), translate)
  await waitFor(() => { expect(view.getByText('2023.pdf')).toBeTruthy() })
  expect(view.getByRole('button', { name: dictionary['exams.none.add'] })).toBeTruthy()
  expect(view.asFragment()).toMatchSnapshot()
})
