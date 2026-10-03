// @vitest-environment jsdom
/**
 * The lecture manager: define a lecture with its recordings in part order,
 * refuse an empty one, upload what NotebookLM lacks, rename and bin files,
 * and forget a definition — each through the editing calls, then re-read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { definitionProblem, kindOfName, moved, readableSize, type LectureEditing, type ModuleFile } from '../src/client/editing.ts'
import { en } from '../src/client/locales.ts'
import type { LibraryLecture, LibraryModule } from '../src/client/model.ts'
import { ManageView } from '../src/client/views/Manage.tsx'

const t = makeTranslate(en)
const SURGERY: LibraryModule = { id: 'surgery', displayName: 'Surgery', notebooks: ['nb'], root: '/w/modules/surgery' }
const FILES: ModuleFile[] = [
  { path: 'Lecture/Shock boys part 1.m4a', name: 'Shock boys part 1.m4a', kind: 'recording', size: 14_000_000, inNotebook: true, lecture: 'Shock' },
  { path: 'Lecture/Shock boys part 2.m4a', name: 'Shock boys part 2.m4a', kind: 'recording', size: 12_000_000, inNotebook: false },
  { path: 'Lecture/Shock.pptx', name: 'Shock.pptx', kind: 'material', size: 3_000_000, inNotebook: false },
]
const SHOCK: LibraryLecture = {
  title: 'Shock', parts: 2, sources: ['Shock boys part 1.m4a', 'Shock boys part 2.m4a'], inNotebookOnly: false,
  state: 'pending', origin: 'manual', id: 'shock', materials: ['Shock.pptx'],
}

function fake() {
  const calls = {
    define: vi.fn(async () => ({ ok: true as const, value: { id: 'new' } })),
    undefine: vi.fn(async () => ({ ok: true as const, value: null })),
    renameFile: vi.fn(async () => ({ ok: true as const, value: null })),
    trashFile: vi.fn(async () => ({ ok: true as const, value: null })),
    upload: vi.fn(async () => ({ ok: true as const, value: { uploaded: ['Shock boys part 2.m4a'], already: [] } })),
    importFile: vi.fn(async (_m: string, file: File) => ({ ok: true as const, value: { path: `Lecture/${file.name}`, name: file.name, kind: 'material' as const, inNotebook: false } })),
  }
  const editing: LectureEditing = { listFiles: vi.fn(async () => ({ ok: true as const, value: FILES })), ...calls }
  return { editing, calls }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('editing helpers', () => {
  it('orders, sizes, files and checks', () => {
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(readableSize(14_600_000)).toBe('13.9 MB')
    expect(kindOfName('Critical thinking girls.oga')).toBe('recording')
    expect(kindOfName('Shock.pptx')).toBe('material')
    expect(definitionProblem({ title: ' ', recordings: ['a'], materials: [] })).toBe('title')
    expect(definitionProblem({ title: 'Shock', recordings: [], materials: [] })).toBe('recordings')
  })
})

describe('ManageView', () => {
  it('defines a new lecture with its recordings in part order', async () => {
    const { editing, calls } = fake()
    const changed = vi.fn()
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={editing} changed={changed} done={vi.fn()} t={t} />)
    await screen.findByText('Shock.pptx')
    fireEvent.click(screen.getByRole('button', { name: en['manage.new'] }))
    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: en['manage.save'] }))
    expect(within(dialog).getByRole('alert').textContent).toBe(en['manage.problem.title'])
    fireEvent.change(within(dialog).getByPlaceholderText(en['manage.editor.titlePlaceholder']), { target: { value: '  Shock II ' } })
    fireEvent.click(within(dialog).getByLabelText('Shock boys part 2.m4a'))
    fireEvent.click(within(dialog).getByLabelText(/^Shock boys part 1\.m4a/u))
    // Part 2 was ticked first: move part 1 up.
    fireEvent.click(within(dialog).getAllByRole('button', { name: en['manage.editor.earlier'] })[1] as HTMLElement)
    fireEvent.click(within(dialog).getByLabelText('Shock.pptx'))
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.save'] })) })
    expect(calls.define).toHaveBeenCalledWith('surgery', {
      title: 'Shock II', recordings: ['Shock boys part 1.m4a', 'Shock boys part 2.m4a'], materials: ['Shock.pptx'],
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(changed).toHaveBeenCalled()
  })

  it('uploads only what NotebookLM lacks, renames, bins and forgets', async () => {
    const { editing, calls } = fake()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={editing} changed={vi.fn()} done={vi.fn()} t={t} />)
    await screen.findByText('Shock.pptx')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manage.upload'].replace('{count}', '1') })) })
    expect(calls.upload).toHaveBeenCalledWith('surgery', ['Shock boys part 2.m4a'])

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['manage.files'], 'u') }))
    const all = (): HTMLElement => screen.getByRole('button', { name: new RegExp(en['manage.files'], 'u') }).closest('section') as HTMLElement
    const pptx = within(all()).getByText('Shock.pptx').closest('li') as HTMLElement
    fireEvent.click(within(pptx).getByRole('button', { name: en['manage.rename'] }))
    fireEvent.change(within(pptx).getByLabelText(en['manage.rename']), { target: { value: 'Shock - slides.pptx' } })
    await act(async () => { fireEvent.click(within(pptx).getByRole('button', { name: en['manage.save'] })) })
    expect(calls.renameFile).toHaveBeenCalledWith('surgery', 'Lecture/Shock.pptx', 'Shock - slides.pptx')

    const row = (await within(all()).findByText('Shock.pptx')).closest('li') as HTMLElement
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: en['manage.trash'] })) })
    expect(calls.trashFile).toHaveBeenCalledWith('surgery', 'Lecture/Shock.pptx')

    // Undoing the definition lives in the editor, beside what it undoes.
    fireEvent.click(screen.getByRole('button', { name: en['manage.edit'] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manage.undefine'] })) })
    expect(calls.undefine).toHaveBeenCalledWith('surgery', 'shock')
  })

  it('takes a lecture out of the library from its card, after asking', async () => {
    const { editing } = fake()
    const hideLecture = vi.fn(async () => ({ ok: true as const, value: ['Shock boys part 1.m4a'] }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={{ ...editing, hideLecture }} changed={vi.fn()} done={vi.fn()} t={t} />)
    const remove = await screen.findByRole('button', { name: en['manage.hide'].replace('{title}', 'Shock') })
    fireEvent.click(remove)
    expect(hideLecture).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(remove) })
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(hideLecture).toHaveBeenCalledWith('surgery', SHOCK.title)
  })

  it('offers no card × when the engine cannot hide a lecture', async () => {
    const { editing } = fake()
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={editing} changed={vi.fn()} done={vi.fn()} t={t} />)
    await screen.findByText('Shock.pptx')
    expect(screen.queryByRole('button', { name: en['manage.hide'].replace('{title}', 'Shock') })).toBeNull()
  })

  it('shows the engine\'s refusal and keeps the dialog open', async () => {
    const { editing, calls } = fake()
    calls.define.mockResolvedValueOnce({ ok: false, message: 'recording already belongs to Shock' } as never)
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={editing} changed={vi.fn()} done={vi.fn()} t={t} />)
    await screen.findByText('Shock.pptx')
    fireEvent.click(screen.getByRole('button', { name: en['manage.edit'] }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['manage.save'] })) })
    expect(screen.getByText('recording already belongs to Shock')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('puts a loose file into a lecture from its menu and refuses to empty a lecture', async () => {
    const { editing, calls } = fake()
    const loose: ModuleFile = { path: 'Lecture/Shock boys part 3.m4a', name: 'Shock boys part 3.m4a', kind: 'recording', inNotebook: false }
    editing.listFiles = vi.fn(async () => ({ ok: true as const, value: [...FILES, loose] }))
    const single: LibraryLecture = { ...SHOCK, sources: ['Shock boys part 1.m4a'] }
    render(<ManageView module={SURGERY} lectures={[single]} editing={editing} changed={vi.fn()} done={vi.fn()} t={t} />)
    const menu = await screen.findByLabelText(en['manage.assign'].replace('{name}', 'Shock boys part 3.m4a'))
    await act(async () => { fireEvent.change(menu, { target: { value: 'Shock' } }) })
    expect(calls.define).toHaveBeenCalledWith('surgery', {
      id: 'shock', title: 'Shock', recordings: ['Shock boys part 1.m4a', 'Shock boys part 3.m4a'], materials: ['Shock.pptx'],
    })

    calls.define.mockClear()
    fireEvent.click(screen.getByRole('button', { name: en['manage.removeFrom'].replace('{name}', 'Shock boys part 1.m4a') }))
    expect(calls.define).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Shock')
  })

  it('takes a slide out of a lecture', async () => {
    const { editing, calls } = fake()
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={editing} changed={vi.fn()} done={vi.fn()} t={t} />)
    await screen.findByText(en['manage.unassigned'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en['manage.removeFrom'].replace('{name}', 'Shock.pptx') }))
    })
    expect(calls.define).toHaveBeenCalledWith('surgery', {
      id: 'shock', title: 'Shock', recordings: ['Shock boys part 1.m4a', 'Shock boys part 2.m4a'], materials: [],
    })
  })

  it('files a book as a module-wide source, from its menu or by dropping it, and takes it back', async () => {
    const { editing } = fake()
    const book: ModuleFile = { path: 'Lecture/Book.pdf', name: 'Book.pdf', kind: 'material', size: 9, inNotebook: true, general: true }
    const atlas: ModuleFile = { path: 'Lecture/Atlas.pdf', name: 'Atlas.pdf', kind: 'material', size: 9, inNotebook: false }
    const setGeneral = vi.fn(async () => ({ ok: true as const, value: null }))
    const listFiles = vi.fn(async () => ({ ok: true as const, value: [...FILES, book, atlas] }))
    const withGeneral: LectureEditing = { ...editing, listFiles, setGeneral }
    render(<ManageView module={SURGERY} lectures={[SHOCK]} editing={withGeneral} changed={vi.fn()} done={vi.fn()} t={t} />)
    const general = (await screen.findByText(en['manage.general'])).closest('section') as HTMLElement
    expect(within(general).getByText('Book.pdf')).toBeTruthy()
    // A general source no longer waits among the unassigned files.
    const loose = screen.getByText(en['manage.unassigned']).closest('aside') as HTMLElement
    expect(within(loose).queryByText('Book.pdf')).toBeNull()
    fireEvent.change(within(loose).getByLabelText(en['manage.assign'].replace('{name}', 'Atlas.pdf')), { target: { value: '\u0000general' } })
    await waitFor(() => { expect(setGeneral).toHaveBeenCalledWith('surgery', ['Book.pdf', 'Atlas.pdf']) })
    fireEvent.click(within(general).getByRole('button', { name: en['manage.general.remove'].replace('{name}', 'Book.pdf') }))
    await waitFor(() => { expect(setGeneral).toHaveBeenLastCalledWith('surgery', []) })
    const data = new Map<string, string>()
    const transfer = {
      types: ['application/x-qabas-file'],
      getData: (type: string) => data.get(type) ?? '',
      setData: (type: string, value: string) => { data.set(type, value) },
      dropEffect: '',
      effectAllowed: '',
    }
    fireEvent.dragStart(within(loose).getByText('Atlas.pdf').closest('li') as HTMLElement, { dataTransfer: transfer })
    fireEvent.dragOver(general, { dataTransfer: transfer })
    fireEvent.drop(general, { dataTransfer: transfer })
    await waitFor(() => { expect(setGeneral).toHaveBeenCalledTimes(3) })
    // Dropping what is already general changes nothing.
    data.set('application/x-qabas-file', JSON.stringify({ name: 'Book.pdf', kind: 'material' }))
    fireEvent.drop(general, { dataTransfer: transfer })
    expect(setGeneral).toHaveBeenCalledTimes(3)
  })
})
