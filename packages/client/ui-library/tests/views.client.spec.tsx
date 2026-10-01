// @vitest-environment jsdom
/**
 * The library's pages against fixed workspaces: what each page shows for each
 * lecture state, what "waiting on you" derives, how the filters split a
 * module, which buttons a lecture gets, and where clicks go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import type { LibraryLecture, LibraryModule, ModuleContents } from '../src/client/model.ts'
import type { LibraryAction, Loadable } from '../src/client/service.ts'
import { HomeView, needsOf } from '../src/client/views/Home.tsx'
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

describe('needsOf', () => {
  it('lists unfinished drafts first, then modules with lectures nobody started, then silent notebooks', () => {
    const needs = needsOf([OPHTHA, RADIO], {
      ophtha: ready({ lectures: LECTURES, materials: [], warning: 'down' }),
      radio: { status: 'loading' },
    }, t)
    expect(needs.map(need => need.key)).toEqual(['draft:ophtha:Glaucoma🔵', 'pending:ophtha', 'notebook:ophtha'])
    expect(needs[0]?.route).toEqual({ kind: 'lecture', module: 'ophtha', lecture: 'Glaucoma🔵' })
    expect(needs[1]?.text).toContain('2')
  })

  it('does not count a transcript whose recording is gone as waiting', () => {
    const needs = needsOf([OPHTHA], { ophtha: ready({ lectures: [lecture('Old', { parts: 0 })], materials: [] }) }, t)
    expect(needs).toEqual([])
  })
})

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
    fireEvent.click(screen.getByText(/the draft of “Glaucoma”/u))
    expect(navigate).toHaveBeenCalledWith({ kind: 'lecture', module: 'ophtha', lecture: 'Glaucoma🔵' })
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
