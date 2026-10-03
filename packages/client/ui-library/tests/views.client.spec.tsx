// @vitest-environment jsdom
/**
 * The library's pages against fixed workspaces: what each page shows for each
 * lecture state, how the filters split a
 * module, which buttons a lecture gets, and where clicks go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { LibraryLecture, LibraryModule, ModuleContents } from '../src/client/model.ts'
import type { LibraryAction, Loadable } from '../src/client/service.ts'
import { HomeView } from '../src/client/views/Home.tsx'
import { inFilter, lectureMeta, ModuleView } from '../src/client/views/Module.tsx'
import { LectureView, stepStanding } from '../src/client/views/Lecture.tsx'
import { ActionButtons, StateProgress, stateKey } from '../src/client/parts.tsx'

const t = makeTranslate(en)

/** A file button by its label: the same word also names a step of the stepper. */
function fileButton(label: string): HTMLButtonElement {
  const button = screen.getAllByText(label).map(node => node.closest('button')).find(node => node !== null)
  if (button === undefined || button === null) throw new Error(`no file button labelled ${label}`)
  return button
}

const OPHTHA: LibraryModule = { id: 'ophtha', displayName: 'Ophthalmology', notebooks: ['nb'], root: '/w/modules/ophtha' }
const RADIO: LibraryModule = { id: 'radio', displayName: 'Radiology', notebooks: [], root: '/w/modules/radio' }

function lecture(title: string, overrides: Partial<LibraryLecture> = {}): LibraryLecture {
  return { title, parts: 1, sources: [`${title}.mp3`], inNotebookOnly: false, state: 'pending', ...overrides }
}

const LECTURES: LibraryLecture[] = [
  lecture('Orbit', { state: 'final', transcript: '/w/modules/ophtha/Transcripts/Orbit 👁️.md' }),
  lecture('Glaucoma🔵', { state: 'draft', draft: '/w/d.md.draft.md', verbatim: '/w/v.verbatim.md' }),
  lecture('Conjunctiva', { state: 'verbatim', verbatim: '/w/c.verbatim.md', inNotebookOnly: true, sources: ['Conjunctiva'] }),
  lecture('Lens'),
  lecture('Retina', { parts: 2, sources: ['Retina 1.mp3', 'Retina 2.mp3'] }),
]

const ready = (value: ModuleContents): Loadable<ModuleContents> => ({ status: 'ready', value, refreshing: false })

afterEach(() => {
  cleanup()
})

function action(id: string, overrides: Partial<LibraryAction> = {}): LibraryAction {
  return { id, scope: 'lecture', label: () => id, appliesTo: () => true, run: vi.fn(), ...overrides }
}

describe('HomeView', () => {
  it('greets an empty workspace with what to do first', () => {
    render(<HomeView modules={[]} contents={{}} navigate={vi.fn()} t={t} />)
    expect(screen.getByText(en['home.empty.title'])).toBeTruthy()
  })

  it('draws a card per module and opens it', () => {
    const navigate = vi.fn()
    render(
      <HomeView
        modules={[OPHTHA, RADIO]}
        contents={{ ophtha: ready({ lectures: LECTURES, materials: [] }) }}
        navigate={navigate}
        t={t}
      />,
    )
    expect(screen.getByText(/2 modules · 5 lectures · 1 finished/u)).toBeTruthy()
    expect(screen.getByText(en['home.card.reading'], { exact: false })).toBeTruthy()
    fireEvent.click(screen.getByText('Radiology'))
    expect(navigate).toHaveBeenCalledWith({ kind: 'module', module: 'radio' })
    // The cards are the whole page: no list of reminders above them.
    expect(screen.queryByText(/the draft of/u)).toBeNull()
  })
})

describe('removals', () => {
  it('removes a lecture\'s transcript from its file card after asking, and not under a running job', async () => {
    const removeTranscript = vi.fn(async () => ({ ok: true as const, value: null }))
    const changed = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const final = { ...LECTURES[0]!, state: 'final' as const, transcript: '/w/T/Glaucoma.md' }
    const view = render(<LectureView module={OPHTHA} lecture={final} actions={[]} open={vi.fn()} canOpen
      removeTranscript={removeTranscript} changed={changed} t={t} />)
    const label = en['lecture.remove'].replace('{what}', en['lecture.file.transcript'])
    fireEvent.click(screen.getByRole('button', { name: label }))
    await vi.waitFor(() => { expect(changed).toHaveBeenCalledTimes(1) })
    expect(removeTranscript).toHaveBeenCalledWith('final')
    expect(confirm).toHaveBeenCalledTimes(1)
    view.unmount()
    const job = { id: 'j', module: 'ophtha', lecture: final.title } as never
    render(<LectureView module={OPHTHA} lecture={final} actions={[]} job={job} open={vi.fn()} canOpen
      removeTranscript={removeTranscript} t={t} />)
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  })

  it('removes the module after asking and goes home', async () => {
    const navigate = vi.fn()
    const removeModule = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    render(<ModuleView module={OPHTHA} contents={{ lectures: LECTURES, materials: [] }} actions={[]} navigate={navigate}
      retry={vi.fn()} removeModule={removeModule} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['module.remove'] }))
    await vi.waitFor(() => { expect(navigate).toHaveBeenCalledWith({ kind: 'home' }) })
  })

  it('lists the module\'s trash and restores an entry', async () => {
    const restoreTrash = vi.fn(async () => ({ ok: true as const, value: { id: 't1', paths: [] } }))
    const listTrash = vi.fn(async () => ({ ok: true as const, value: [
      { id: 't1', removedAt: '2026-10-03T09:00:00Z', kind: 'transcript' as const, label: 'Glaucoma', paths: ['Transcripts/Glaucoma.md'] },
    ] }))
    const retry = vi.fn()
    render(<ModuleView module={OPHTHA} contents={{ lectures: LECTURES, materials: [] }} actions={[]} navigate={vi.fn()}
      retry={retry} editing={{ listTrash, restoreTrash } as never} t={t} />)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(en['trash.title'].replace('({count})', ''), 'u') }))
    fireEvent.click(screen.getByRole('button', { name: en['trash.restore'] }))
    await vi.waitFor(() => { expect(retry).toHaveBeenCalledTimes(1) })
    expect(restoreTrash).toHaveBeenCalledWith('ophtha', 't1')
  })
})

describe('ModuleView', () => {
  it('sorts lectures under the filters by how far along they are', () => {
    expect(LECTURES.filter(item => inFilter('todo', item)).map(item => item.title)).toEqual(['Lens', 'Retina'])
    expect(LECTURES.filter(item => inFilter('progress', item)).map(item => item.title)).toEqual(['Glaucoma🔵', 'Conjunctiva'])
    expect(LECTURES.filter(item => inFilter('done', item)).map(item => item.title)).toEqual(['Orbit'])
  })

  it('says where each recording lives', () => {
    expect(lectureMeta(LECTURES[2] as LibraryLecture, t)).toBe('One recording · NotebookLM only')
    expect(lectureMeta(LECTURES[4] as LibraryLecture, t)).toBe('2 recordings')
    expect(lectureMeta(lecture('Old', { parts: 0 }), t)).toBe(en['lecture.noRecording'])
  })

  it('shows a running job in place of the lecture\'s action', () => {
    const transcribe = action('transcribe', { appliesTo: target => target.lecture?.state === 'pending', primary: () => true })
    const job = { id: 'j', kind: 'transcribe' as const, module: 'ophtha', moduleName: 'Ophthalmology', lecture: 'Lens', status: 'running' as const, step: { tool: 'mcp__transcriber__stage_draft_part', part: 2, parts: 4 }, startedAt: 1 }
    render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [] }}
        actions={[transcribe]}
        running={lecture => (lecture === 'Lens' ? job : undefined)}
        navigate={vi.fn()}
        retry={vi.fn()}
        t={t}
      />,
    )
    const lens = screen.getAllByRole('listitem').find(item => item.dataset.libraryLecture === 'Lens')
    expect(lens?.querySelector('[data-library-action="transcribe"]')).toBeNull()
    expect(lens?.querySelector('[role="status"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-library-action="transcribe"]')).toHaveLength(1)
  })

  it('lists lectures, filters them, offers each its next step, and opens one', () => {
    const navigate = vi.fn()
    const transcribe = action('transcribe', { appliesTo: target => target.lecture?.state === 'pending', primary: () => true })
    render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [{ name: 'Book.pdf', path: 'Lecture/Book.pdf' }], warning: 'down' }}
        actions={[transcribe, action('audit', { scope: 'module' })]}
        navigate={navigate}
        retry={vi.fn()}
        t={t}
      />,
    )
    expect(screen.getAllByRole('listitem').filter(item => item.dataset.libraryLecture !== undefined)).toHaveLength(5)
    expect(screen.getByText('Book.pdf')).toBeTruthy()
    expect(screen.getByText(en['module.warning'])).toBeTruthy()
    expect(document.querySelectorAll('[data-library-action="transcribe"]')).toHaveLength(2)
    fireEvent.click(screen.getByRole('tab', { name: en['module.filter.done'] }))
    expect(screen.getAllByRole('listitem').filter(item => item.dataset.libraryLecture !== undefined)).toHaveLength(1)
    fireEvent.click(screen.getByText('Orbit'))
    expect(navigate).toHaveBeenCalledWith({ kind: 'lecture', module: 'ophtha', lecture: 'Orbit' })
  })

  it('says a built question index is ready and rebuilds it without a chat job', async () => {
    const build = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'papers unreadable' })
      .mockResolvedValueOnce({ ok: true, value: null })
    const retry = vi.fn()
    const questions = action('questions', { scope: 'module' })
    render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [], questionIndex: { state: 'built', files: 3 } }}
        actions={[questions, action('audit', { scope: 'module' })]}
        editing={{ buildQuestionIndex: build } as never}
        navigate={vi.fn()}
        retry={retry}
        t={t}
      />,
    )
    expect(screen.getByText(en['qindex.ready'])).toBeTruthy()
    // The chat-job action gives way to the engine call.
    expect(screen.queryByRole('button', { name: 'questions' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['qindex.rebuild'] }))
    expect(screen.getByRole('button', { name: en['qindex.building'] })).toBeTruthy()
    expect(await screen.findByText('papers unreadable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['qindex.rebuild'] }))
    await vi.waitFor(() => { expect(retry).toHaveBeenCalledTimes(1) })
    expect(build).toHaveBeenCalledWith('ophtha')
  })

  it('offers past papers to a module that has none, files them as questions and indexes them', async () => {
    const importFile = vi.fn(async () => ({ ok: true as const, value: { name: 'x', path: 'Questions/x', kind: 'question' as const } }))
    const build = vi.fn(async () => ({ ok: true as const, value: null }))
    const retry = vi.fn()
    const { container } = render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [], questionIndex: { state: 'missing', files: 0 } }}
        actions={[]}
        editing={{ importFile, buildQuestionIndex: build } as never}
        navigate={vi.fn()}
        retry={retry}
        t={t}
      />,
    )
    expect(screen.getByText(en['exams.none.title'])).toBeTruthy()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const papers = [new File(['a'], '2023.pdf'), new File(['b'], '2024.docx')]
    fireEvent.change(input, { target: { files: papers } })
    await vi.waitFor(() => { expect(retry).toHaveBeenCalledTimes(1) })
    expect(importFile).toHaveBeenNthCalledWith(1, 'ophtha', papers[0], 'question')
    expect(importFile).toHaveBeenNthCalledWith(2, 'ophtha', papers[1], 'question')
    expect(build).toHaveBeenCalledWith('ophtha')
  })

  it('does not offer past papers to a module that has them', () => {
    render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [], questionIndex: { state: 'built', files: 3 } }}
        actions={[]}
        editing={{ buildQuestionIndex: vi.fn() } as never}
        navigate={vi.fn()}
        retry={vi.fn()}
        t={t}
      />,
    )
    expect(screen.queryByText(en['exams.none.title'])).toBeNull()
  })

  it('lists the module-wide sources apart from the lectures\' slides', () => {
    render(
      <ModuleView
        module={OPHTHA}
        contents={{ lectures: LECTURES, materials: [{ name: 'Book.pdf', path: 'Lecture/Book.pdf' }, { name: 'Orbit.pptx', path: 'Lecture/Orbit.pptx' }], general: ['Book.pdf'] }}
        actions={[]}
        navigate={vi.fn()}
        retry={vi.fn()}
        t={t}
      />,
    )
    const general = screen.getByText(en['module.general']).closest('section') as HTMLElement
    expect(general.textContent).toContain('Book.pdf')
    const slides = screen.getByText(en['module.materials']).closest('section') as HTMLElement
    expect(slides.textContent).toContain('Orbit.pptx')
    expect(slides.textContent).not.toContain('Book.pdf')
  })

  it('says when a module or a filter is empty', () => {
    const { rerender } = render(
      <ModuleView module={RADIO} contents={{ lectures: [], materials: [] }} actions={[]} navigate={vi.fn()} retry={vi.fn()} t={t} />,
    )
    expect(screen.getByText(en['module.empty'])).toBeTruthy()
    rerender(
      <ModuleView module={RADIO} contents={{ lectures: [lecture('Lens')], materials: [] }} actions={[]} navigate={vi.fn()} retry={vi.fn()} t={t} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: en['module.filter.done'] }))
    expect(screen.getByText(en['module.filterEmpty'])).toBeTruthy()
  })
})

describe('LectureView', () => {
  it('marks the steps a lecture has reached and the one it is on next', () => {
    expect(stepStanding('verbatim', 'pending')).toBe('next')
    expect(stepStanding('draft', 'pending')).toBe('ahead')
    expect(stepStanding('verbatim', 'draft')).toBe('done')
    expect(stepStanding('final', 'draft')).toBe('next')
  })

  it('offers the files the lecture has produced, and opens them', () => {
    const open = vi.fn()
    render(
      <LectureView
        module={OPHTHA}
        lecture={LECTURES[1] as LibraryLecture}
        actions={[action('continue', { primary: () => true })]}
        open={open}
        canOpen
        t={t}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Glaucoma')
    fireEvent.click(fileButton(en['lecture.file.draft']))
    expect(open).toHaveBeenCalledWith('/w/d.md.draft.md')
    expect(fileButton(en['lecture.file.verbatim'])).toBeTruthy()
    expect(document.querySelectorAll('ul button[title]')).toHaveLength(2)
  })

  it('shows a finished lecture\'s transcript, and no file buttons work without an opener', () => {
    const open = vi.fn()
    render(<LectureView module={OPHTHA} lecture={LECTURES[0] as LibraryLecture} actions={[]} open={open} canOpen={false} t={t} />)
    expect(fileButton(en['lecture.file.transcript']).disabled).toBe(true)
  })

  it('lists the slides a lecture is taught with, or says how to add them', () => {
    const { rerender } = render(
      <LectureView module={OPHTHA} lecture={lecture('Lens', { materials: ['Lecture/lens.pptx'] })} actions={[]} open={vi.fn()} canOpen t={t} />,
    )
    expect(screen.getByText('lens.pptx')).toBeTruthy()
    rerender(<LectureView module={OPHTHA} lecture={lecture('Lens')} actions={[]} open={vi.fn()} canOpen t={t} />)
    expect(screen.getByText(en['lecture.materials.none'])).toBeTruthy()
    rerender(<LectureView module={OPHTHA} lecture={lecture('Old', { parts: 0, sources: [] })} actions={[]} open={vi.fn()} canOpen t={t} />)
    expect(screen.queryByText(en['lecture.materials'])).toBeNull()
  })

  it('names a lecture that only lives in the notebook', () => {
    render(<LectureView module={OPHTHA} lecture={LECTURES[2] as LibraryLecture} actions={[]} open={vi.fn()} canOpen t={t} />)
    expect(screen.getAllByText(en['lecture.notebookOnly']).length).toBeGreaterThan(0)
  })
})

describe('parts', () => {
  it('maps each state to its label key', () => {
    expect(stateKey('verbatim')).toBe('state.verbatim')
  })

  it('draws an empty bar for a module with no lectures', () => {
    const { container } = render(<StateProgress counts={{ pending: 0, verbatim: 0, draft: 0, final: 0 }} t={t} />)
    expect(container.querySelectorAll('[data-state]')).toHaveLength(0)
  })

  it('runs an action once, holding the buttons while it runs', async () => {
    let finish: () => void = () => undefined
    const run = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<ActionButtons actions={[action('go', { run, primary: () => true }), action('other')]} target={{ module: OPHTHA }} />)
    const go = screen.getByText('go').closest('button') as HTMLButtonElement
    fireEvent.click(go)
    expect(run).toHaveBeenCalledTimes(1)
    expect(go.disabled).toBe(true)
    finish()
    await vi.waitFor(() => { expect(go.disabled).toBe(false) })
  })

  it('draws nothing when no action applies, and only the primary one in a row', () => {
    const { container, rerender } = render(<ActionButtons actions={[action('x', { appliesTo: () => false })]} target={{ module: OPHTHA }} />)
    expect(container.innerHTML).toBe('')
    rerender(<ActionButtons actions={[action('a'), action('b', { primary: () => true })]} target={{ module: OPHTHA }} primaryOnly />)
    expect(screen.queryByText('a')).toBeNull()
    expect(screen.getByText('b')).toBeTruthy()
    rerender(<ActionButtons actions={[action('a')]} target={{ module: OPHTHA }} primaryOnly compact />)
    expect(screen.queryByText('a')).toBeNull()
  })
})
