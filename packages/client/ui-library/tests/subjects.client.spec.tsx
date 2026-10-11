// @vitest-environment jsdom
/** Subjects (مواد) group a module's lectures on the module page and in the lecture manager. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { ManageView } from '../src/client/views/Manage.tsx'
import { en } from '../src/client/locales.ts'
import type { EditOutcome, LectureEditing, ModuleFile } from '../src/client/editing.ts'
import { groupBySubject, type LibraryLecture, type LibrarySubject } from '../src/client/model.ts'

const t = makeTranslate(en)
const module = { id: 'radio', displayName: 'Clinical pathology and radiology', root: '/fixture/modules/radio', notebooks: [] }
const subjects: LibrarySubject[] = [{ id: 'pathology', title: 'Clinical Pathology' }, { id: 'radiology', title: 'Radiology' }]
const lecture = (id: string, title: string, subject?: string, origin: 'manual' | 'auto' = 'manual'): LibraryLecture => ({
  ...origin === 'manual' ? { id } : {}, title, origin, state: 'pending', parts: 1, sources: [`${title}.m4a`], materials: [], inNotebookOnly: false,
  ...subject === undefined ? {} : { subject },
})
const lectures = [lecture('anemia', 'Anemia', 'pathology'), lecture('chest', 'Chest X-ray', 'radiology'), lecture('intro', 'Introduction', undefined, 'auto')]
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function engine() {
  const files: ModuleFile[] = lectures.map(item => ({ path: `Lecture/${item.title}.m4a`, name: `${item.title}.m4a`, kind: 'recording', inNotebook: true }))
  const calls = {
    listFiles: vi.fn(async (): Promise<EditOutcome<readonly ModuleFile[]>> => ({ ok: true, value: files })),
    define: vi.fn(async () => ({ ok: true as const, value: { id: 'introduction' } })),
    undefine: vi.fn(async () => ({ ok: true as const, value: null })),
    upload: vi.fn(async () => ({ ok: true as const, value: { uploaded: [], already: [] } })),
    importFile: vi.fn(async () => ({ ok: false as const, message: 'unused' })),
    renameFile: vi.fn(async () => ({ ok: true as const, value: null })),
    trashFile: vi.fn(async () => ({ ok: true as const, value: null })),
    createSubject: vi.fn(async () => ({ ok: true as const, value: { id: 'microbiology' } })),
    renameSubject: vi.fn(async () => ({ ok: true as const, value: null })),
    deleteSubject: vi.fn(async () => ({ ok: true as const, value: null })),
    setLectureSubject: vi.fn(async () => ({ ok: true as const, value: null })),
  }
  return { editing: calls satisfies LectureEditing, calls }
}
function manage(editing: LectureEditing, translate = t) {
  return render(<ManageView module={module} lectures={lectures} subjects={subjects} editing={editing}
    changed={vi.fn()} t={translate} />)
}

it('groups lectures by subject order and keeps unassigned lectures last', () => {
  expect(groupBySubject(lectures, subjects).map(group => [group.subject?.id, group.lectures.map(item => item.title)])).toEqual([
    ['pathology', ['Anemia']], ['radiology', ['Chest X-ray']], [undefined, ['Introduction']],
  ])
  expect(groupBySubject(lectures)).toEqual([{ lectures }])
  // A lecture naming a subject the module no longer has is shown as unassigned, not lost.
  expect(groupBySubject([lecture('x', 'X', 'gone')], subjects).at(-1)?.lectures.map(item => item.title)).toEqual(['X'])
})

it.each([['en', en], ['ar', dictionaries.library ?? {}]] as const)('renders a section per subject in %s', async (_language, dictionary) => {
  const translate = makeTranslate(dictionary)
  manage(engine().editing, translate)
  const sections = await screen.findAllByRole('region')
  expect(sections.slice(0, 3).map(section => section.getAttribute('aria-label'))).toEqual(['Clinical Pathology', 'Radiology', translate('subjects.none')])
  expect(within(sections[0] as HTMLElement).getByText('Anemia')).toBeTruthy()
  expect(within(sections[2] as HTMLElement).getByText('Introduction')).toBeTruthy()
})

it('adds a subject from the page menu with the keyboard', async () => {
  const { editing, calls } = engine()
  manage(editing)
  fireEvent.click(await screen.findByRole('button', { name: en['manage.pageMenu'] }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['subjects.add'] }))
  const input = screen.getByLabelText(en['subjects.add'])
  fireEvent.change(input, { target: { value: 'Microbiology' } })
  await act(async () => { fireEvent.submit(input.closest('form') as HTMLFormElement) })
  expect(calls.createSubject).toHaveBeenCalledWith('radio', 'Microbiology')
  await waitFor(() => { expect(screen.queryByLabelText(en['subjects.add'])).toBeNull() })
})

it('moves a defined lecture by id and pins an automatic lecture with its subject', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const anemia = (await screen.findByRole('button', { name: 'Anemia', expanded: false })).closest('li') as HTMLElement
  fireEvent.click(within(anemia).getByRole('button', { name: /Actions for/u }))
  fireEvent.click(screen.getByRole('menuitem', { name: t('subjects.moveTo', { title: 'Radiology' }) }))
  await waitFor(() => { expect(calls.setLectureSubject).toHaveBeenCalledWith('radio', 'anemia', 'radiology') })
  const intro = screen.getByRole('button', { name: 'Introduction', expanded: false }).closest('li') as HTMLElement
  fireEvent.click(within(intro).getByRole('button', { name: /Actions for/u }))
  expect(screen.queryByRole('menuitem', { name: en['subjects.moveOut'] })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: t('subjects.moveTo', { title: 'Clinical Pathology' }) }))
  await waitFor(() => {
    expect(calls.define).toHaveBeenCalledWith('radio', expect.objectContaining({ title: 'Introduction', recordings: ['Introduction.m4a'], subject: 'pathology' }))
  })
})

it('renames a subject inline and deletes it only after a confirmation that keeps lectures', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const radiology = (await screen.findAllByRole('region'))[1] as HTMLElement
  fireEvent.click(within(radiology).getByRole('button', { name: en['subjects.rename'] }))
  const input = screen.getByLabelText(en['subjects.rename'])
  fireEvent.change(input, { target: { value: 'Imaging' } })
  await act(async () => { fireEvent.submit(input.closest('form') as HTMLFormElement) })
  expect(calls.renameSubject).toHaveBeenCalledWith('radio', 'radiology', 'Imaging')
  fireEvent.click(within(screen.getAllByRole('region')[1] as HTMLElement).getByRole('button', { name: en['subjects.delete'] }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(t('subjects.delete.confirm', { title: 'Radiology' }))).toBeTruthy()
  expect(calls.deleteSubject).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['subjects.delete'] })) })
  expect(calls.deleteSubject).toHaveBeenCalledWith('radio', 'radiology')
})

it('chooses the subject in the lecture editor', async () => {
  const { editing, calls } = engine()
  manage(editing)
  const chest = (await screen.findByRole('button', { name: 'Chest X-ray', expanded: false })).closest('li') as HTMLElement
  fireEvent.click(within(chest).getByRole('button', { name: /Actions for/u }))
  fireEvent.click(screen.getByRole('menuitem', { name: en['manage.edit'] }))
  const select = await screen.findByLabelText(en['subjects.field'])
  expect((select as HTMLSelectElement).value).toBe('radiology')
  fireEvent.change(select, { target: { value: '' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['manage.save'] })) })
  expect(calls.define).toHaveBeenCalledWith('radio', expect.objectContaining({ id: 'chest', subject: null }))
})
