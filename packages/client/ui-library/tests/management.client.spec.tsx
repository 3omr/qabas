// @vitest-environment jsdom
/** Management workflows across first reads, independent writes and streamed engine checkpoints. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { ManageView } from '../src/client/views/Manage.tsx'
import { ExamsView } from '../src/client/views/Exams.tsx'
import { ModuleView } from '../src/client/views/Module.tsx'
import { en } from '../src/client/locales.ts'
import type { EditOutcome, LectureEditing, ModuleFile } from '../src/client/editing.ts'
import type { LibraryLecture } from '../src/client/model.ts'

const t = makeTranslate(en)
const module = { id: 'tox', displayName: 'Toxicology', root: '/fixture/modules/tox', notebooks: [] }
const lecture: LibraryLecture = { id: 'shock', title: 'Shock', origin: 'manual', state: 'draft', parts: 2, sources: ['A.m4a', 'B.m4a'], materials: ['Slides.pdf'], inNotebookOnly: false }
const audio = (name: string): ModuleFile => ({ path: `Lecture/${name}`, name, kind: 'recording', inNotebook: true })
const paper = (name: string): ModuleFile => ({ path: `Questions/${name}`, name, kind: 'question', inNotebook: false, preparation: 'ready' })
function engine(initial: ModuleFile[] = [audio('A.m4a'), audio('B.m4a'), { ...audio('Slides.pdf'), kind: 'material' }]) {
  let files = initial
  const calls = {
    listFiles: vi.fn(async (): Promise<EditOutcome<readonly ModuleFile[]>> => ({ ok: true, value: files })),
    define: vi.fn(async () => ({ ok: true as const, value: { id: 'shock' } })),
    undefine: vi.fn(async () => ({ ok: true as const, value: null })),
    upload: vi.fn(async () => ({ ok: true as const, value: { uploaded: [], already: [] } })),
    importFile: vi.fn(async (_module: string, file: File, kind: ModuleFile['kind']) => {
      const value = { ...audio(file.name), kind, size: file.size }
      files = [...files, value]; return { ok: true as const, value }
    }),
    renameFile: vi.fn(async (_module: string, path: string, name: string) => {
      files = files.map(file => file.path === path ? { ...file, name } : file); return { ok: true as const, value: null }
    }),
    trashFile: vi.fn(async (_module: string, path: string) => { files = files.filter(file => file.path !== path); return { ok: true as const, value: { id: path.includes('A') ? 'trash-a' : 'trash-b', trashPath: path } } }),
    restoreTrash: vi.fn(async () => { files = initial; return { ok: true as const, value: { id: 'restored', paths: [] } } }),
  }
  return { editing: calls satisfies LectureEditing, calls }
}
function manage(editing: LectureEditing, translate = t) {
  return render(<ManageView module={module} lectures={[lecture]} editing={editing} changed={vi.fn()} done={vi.fn()} t={translate} />)
}
async function row() { return (await screen.findByRole('button', { name: 'Shock', expanded: false })).closest('li') as HTMLElement }
function menu(row: HTMLElement) { fireEvent.click(within(row).getByRole('button', { name: /Actions for|اختيارات/u })) }
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each(['lectures', 'exams'] as const)('reserves skeleton rows on the first %s read', async (view) => {
  const { editing } = engine([])
  let resolve!: (value: EditOutcome<readonly ModuleFile[]>) => void
  editing.listFiles.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const shown = view === 'lectures' ? manage(editing) : render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  expect(shown.container.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0)
  await act(async () => { resolve({ ok: true, value: [] }) })
  expect(shown.container.querySelector('[data-skeleton]')).toBeNull()
})

it('expands compact lecture rows and renames inline through the keyboard menu', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const entry = await row()
  expect(within(entry).queryByText('A.m4a')).toBeNull()
  const expand = within(entry).getByRole('button', { name: 'Shock', expanded: false })
  fireEvent.click(expand)
  expect(expand.getAttribute('aria-expanded')).toBe('true')
  expect(within(entry).getByText('A.m4a')).toBeTruthy()
  menu(entry)
  expect(document.activeElement?.textContent).toBe(en['manage.rename'])
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(document.activeElement?.textContent).toBe(en['manage.edit'])
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(document.activeElement?.getAttribute('aria-haspopup')).toBe('menu')
  menu(entry)
  fireEvent.click(screen.getByRole('menuitem', { name: en['manage.rename'] }))
  const input = screen.getByLabelText(en['manage.editor.title'])
  fireEvent.change(input, { target: { value: 'New title' } })
  await act(async () => { fireEvent.submit(input.closest('form')!) })
  expect(calls.define).toHaveBeenCalledWith('tox', expect.objectContaining({ id: 'shock', title: 'New title' }))
  expect(within(entry).getByText('New title')).toBeTruthy()
})

it('distinguishes unassign from confirmed trash and restores the engine trash identity', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const entry = await row()
  fireEvent.click(within(entry).getByRole('button', { name: 'Shock', expanded: false }))
  const slide = within(entry).getByText('Slides.pdf').closest('li')!
  await act(async () => { fireEvent.click(within(slide).getByRole('button', { name: en['management.unassign'] })) })
  expect(calls.define).toHaveBeenLastCalledWith('tox', expect.objectContaining({ materials: [] }))
  expect(calls.trashFile).not.toHaveBeenCalled()
  fireEvent.click(within(slide).getByRole('button', { name: en['manage.trash'] }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toContain('restore')
  expect(calls.trashFile).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.trash'] })) })
  fireEvent.click(await screen.findByRole('button', { name: en['management.undo'] }))
  await waitFor(() => { expect(calls.restoreTrash).toHaveBeenCalledWith('tox', 'trash-b') })
})

it('cancels an editor with Escape and preserves its ordered files until Save', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const entry = await row()
  menu(entry); fireEvent.click(screen.getByRole('menuitem', { name: en['manage.edit'] }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getAllByRole('button', { name: en['manage.editor.earlier'] })[1]!)
  fireEvent.change(within(dialog).getByPlaceholderText(en['manage.editor.titlePlaceholder']), { target: { value: 'Discard' } })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(calls.define).not.toHaveBeenCalled()
  menu(entry); fireEvent.click(screen.getByRole('menuitem', { name: en['manage.edit'] }))
  const next = screen.getByRole('dialog')
  fireEvent.click(within(next).getAllByRole('button', { name: en['manage.editor.earlier'] })[1]!)
  await act(async () => { fireEvent.click(within(next).getByRole('button', { name: en['manage.save'] })) })
  expect(calls.define).toHaveBeenCalledWith('tox', expect.objectContaining({ recordings: ['B.m4a', 'A.m4a'] }))
})

it.each(['lectures', 'exams'] as const)('shows honest saving and retries an individual %s upload without losing its neighbours', async (view) => {
  const { editing, calls } = engine([])
  let resolve!: (value: Awaited<ReturnType<typeof calls.importFile>>) => void
  calls.importFile.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const shown = view === 'lectures' ? manage(editing) : render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  await waitFor(() => { expect(shown.container.querySelector('[data-skeleton]')).toBeNull() })
  const file = new File(['test'], view === 'exams' ? 'A.pdf' : 'A.m4a')
  fireEvent.change(shown.getByLabelText(en[view === 'exams' ? 'exams.none.add' : 'manage.add']), { target: { files: [file] } })
  await screen.findByText(en['management.upload.saving'])
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false)
  await act(async () => { resolve({ ok: false, message: 'Disk unavailable' } as never) })
  expect(screen.getByText('Disk unavailable')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  await screen.findByText(en['management.upload.done'])
  expect(calls.importFile).toHaveBeenCalledTimes(2)
  expect(shown.container.textContent).toContain(file.name)
})

it('shows each exam state, inline rename and confirmed bulk trash with undo', async () => {
  const { editing, calls } = engine([
    { ...paper('A.pdf'), preparation: 'pending' }, paper('B.pdf'), { ...paper('C.pdf'), indexed: true, questionCount: 7 },
    { ...paper('D.pdf'), preparation: 'failed', preparationError: 'Unreadable page' },
  ])
  render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  await screen.findByText('A.pdf')
  expect(screen.getAllByText(en['exams.phase.waiting'])).toHaveLength(2)
  expect(screen.getByText(t('exams.questions', { count: '7' }))).toBeTruthy()
  expect(screen.getByText(en['exams.phase.failed'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Actions for B.pdf' }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['manage.rename'] }))
  fireEvent.change(screen.getByLabelText(en['manage.rename']), { target: { value: 'Renamed.pdf' } })
  await act(async () => { fireEvent.submit(screen.getByLabelText(en['manage.rename']).closest('form')!) })
  await screen.findByText('Renamed.pdf')
  fireEvent.click(screen.getByRole('button', { name: en['exams.pageMenu'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['exams.select'] }))
  fireEvent.click(screen.getByLabelText('Select A.pdf')); fireEvent.click(screen.getByLabelText('Select Renamed.pdf'))
  fireEvent.click(screen.getByRole('button', { name: 'Move 2 files to trash' }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('2 files')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.trash'] })) })
  expect(calls.trashFile).toHaveBeenCalledTimes(2)
  fireEvent.click(await screen.findByRole('button', { name: en['management.undo'] }))
  await waitFor(() => { expect(calls.restoreTrash).toHaveBeenCalledTimes(2) })
})

it('keeps module transcription progress inside its lecture section and removes exam banners from management', async () => {
  const { editing } = engine()
  const shown = render(<ModuleView module={module} contents={{ lectures: [lecture], materials: [], questionIndex: { state: 'stale', files: 13 } }} actions={[]} editing={editing} navigate={vi.fn()} retry={vi.fn()} t={t} />)
  const progress = shown.getByText('Transcription: 0 of 1 ready')
  expect(progress.closest('section')?.getAttribute('aria-labelledby')).toBe('library-lectures')
  fireEvent.click(shown.getByRole('button', { name: en['manage.open'] }))
  await row()
  expect(shown.queryByText(en['qindex.stale.title'])).toBeNull()
  expect(shown.queryByText('Transcription: 0 of 1 ready')).toBeNull()
})

it.each([['en', en], ['ar', dictionaries.library!]] as const)('records compact lecture management in %s', async (_language, dictionary) => {
  const { editing } = engine()
  const shown = manage(editing, makeTranslate(dictionary))
  await row()
  expect(shown.asFragment()).toMatchSnapshot()
})

it('retains exam rows during a slow background refresh and isolates a pending rename', async () => {
  const { editing, calls } = engine([paper('A.pdf'), paper('B.pdf')])
  const view = render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  await screen.findByText('A.pdf')
  let resolve!: (value: EditOutcome<readonly ModuleFile[]>) => void
  calls.listFiles.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  fireEvent.click(screen.getByRole('button', { name: 'Actions for A.pdf' }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['manage.rename'] }))
  fireEvent.change(screen.getByLabelText(en['manage.rename']), { target: { value: 'New.pdf' } })
  fireEvent.submit(screen.getByLabelText(en['manage.rename']).closest('form')!)
  await waitFor(() => { expect(calls.listFiles).toHaveBeenCalledTimes(2) })
  expect(view.container.querySelector('[data-skeleton]')).toBeNull()
  expect(screen.getByText('B.pdf')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Actions for B.pdf' }).hasAttribute('disabled')).toBe(false)
  await act(async () => { resolve({ ok: true, value: [paper('New.pdf'), paper('B.pdf')] }) })
  expect(screen.getByText('New.pdf')).toBeTruthy()
})

it('shows the last read papers at once on a later visit while the engine is asked again', async () => {
  const { editing, calls } = engine([paper('A.pdf')])
  const first = render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  await screen.findByText('A.pdf')
  first.unmount()
  let resolve!: (value: EditOutcome<readonly ModuleFile[]>) => void
  calls.listFiles.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  const second = render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  expect(screen.getByText('A.pdf')).toBeTruthy()
  expect(second.container.querySelector('[data-skeleton]')).toBeNull()
  await act(async () => { resolve({ ok: true, value: [paper('A.pdf'), paper('B.pdf')] }) })
  expect(screen.getByText('B.pdf')).toBeTruthy()
})

it('offers no file Undo without an engine restore identity', async () => {
  const { editing } = engine([paper('A.pdf')])
  render(<ExamsView module="tox" editing={{ ...editing, trashFile: async () => ({ ok: true, value: null }) }} changed={vi.fn()} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for A.pdf' }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['manage.trash'] }))
  const dialog = screen.getByRole('dialog')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.trash'] })) })
  expect(screen.queryByRole('button', { name: en['management.undo'] })).toBeNull()
})

it('retains a bulk failure on its row and trashes the rest', async () => {
  const { editing, calls } = engine([paper('A.pdf'), paper('B.pdf')])
  calls.trashFile.mockImplementationOnce(async () => ({ ok: false, message: 'Busy paper' } as never))
  render(<ExamsView module="tox" editing={editing} changed={vi.fn()} t={t} />)
  await screen.findByText('A.pdf')
  fireEvent.click(screen.getByRole('button', { name: en['exams.pageMenu'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['exams.select'] }))
  fireEvent.click(screen.getByLabelText('Select A.pdf')); fireEvent.click(screen.getByLabelText('Select B.pdf'))
  fireEvent.click(screen.getByRole('button', { name: 'Move 2 files to trash' }))
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: en['manage.trash'] })) })
  expect(calls.trashFile.mock.calls.map(call => call[1])).toEqual(['Questions/A.pdf', 'Questions/B.pdf'])
  await waitFor(() => { expect(screen.queryByText('B.pdf')).toBeNull() })
  expect(within(screen.getByText('A.pdf').closest('li') as HTMLElement).getByText('Busy paper')).toBeTruthy()
})

it('accepts external files across the page without treating assignment drags as uploads', async () => {
  const { editing, calls } = engine()
  const view = manage(editing)
  await row()
  const page = view.container.firstElementChild!
  const dataTransfer = { types: ['Files'], files: [new File(['audio'], 'Dropped.m4a')] }
  fireEvent.dragEnter(page, { dataTransfer })
  expect(screen.getByText(en['manage.drop'])).toBeTruthy()
  fireEvent.drop(page, { dataTransfer })
  await screen.findByText(en['management.upload.done'])
  const uploaded: unknown = expect.any(Uint8Array)
  expect(calls.importFile).toHaveBeenCalledWith('tox', expect.any(File), 'recording', expect.objectContaining({ bytes: uploaded }))
  fireEvent.dragEnter(page, { dataTransfer: { types: ['application/x-qabas-file'] } })
  expect(screen.queryByText(en['manage.drop'])).toBeNull()
})

it('removes a lecture after confirmation and undoes only its hidden recordings', async () => {
  const { editing } = engine()
  const hideLecture = vi.fn(async () => ({ ok: true as const, value: ['A.m4a', 'B.m4a'] }))
  const restoreRecordings = vi.fn(async () => ({ ok: true as const, value: ['A.m4a', 'B.m4a'] }))
  manage({ ...editing, hideLecture, restoreRecordings })
  menu(await row()); fireEvent.click(screen.getByRole('menuitem', { name: en['management.hide'] }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('transcripts stay saved')
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['management.hide'] })) })
  expect(hideLecture).toHaveBeenCalledWith('tox', 'shock')
  fireEvent.click(await screen.findByRole('button', { name: en['management.undo'] }))
  await waitFor(() => { expect(restoreRecordings).toHaveBeenCalledWith('tox', ['A.m4a', 'B.m4a']) })
})

it('reorders selected recording parts by drag before saving the dialog', async () => {
  const { editing, calls } = engine()
  manage(editing)
  menu(await row()); fireEvent.click(screen.getByRole('menuitem', { name: en['manage.edit'] }))
  const dialog = screen.getByRole('dialog')
  const first = within(dialog).getAllByText('A.m4a')[0]!.closest('li')!
  const second = within(dialog).getAllByText('B.m4a')[0]!.closest('li')!
  const dataTransfer = { types: ['application/x-qabas-part'], getData: () => '1', setData: vi.fn() }
  fireEvent.dragStart(second, { dataTransfer }); fireEvent.drop(first, { dataTransfer })
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['manage.save'] })) })
  expect(calls.define).toHaveBeenCalledWith('tox', expect.objectContaining({ recordings: ['B.m4a', 'A.m4a'] }))
})
