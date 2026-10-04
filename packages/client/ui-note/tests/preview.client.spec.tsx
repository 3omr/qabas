// @vitest-environment jsdom
/**
 * The live preview in a real CodeMirror view: marks hide off the active line
 * and come back on it, callouts and figures render, links open, and the text
 * itself never changes. Plus the pieces around it — figure resolution, link
 * targets, word count — and the panel drawing a note.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Context } from '@deepseek-ai/cordis'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createImageCache, mediaTypeOf, relativeReference } from '../src/client/images.ts'
import { engineNoteFiles, linkTarget } from '../src/client/files.ts'
import { headingsOf, livePreview, type PreviewHooks, readingMode } from '../src/client/live-preview.ts'
import { en } from '../src/client/locales.ts'
import { documentDirection, NotePanel, wordCount } from '../src/client/NotePanel.tsx'
import { NoteService } from '../src/client/service.ts'

const t = makeTranslate(en)

const DOC = [
  '## 📖 Chronological Guide',
  'The doctor said **Trachoma** is `chlamydial`.',
  '- first point',
  '> [!important] Doctor\'s remark',
  '> Remember the stages.',
  '',
  '![page 6](./Figures/Conjunctiva/page-006.png)',
  'See [[Cornea 👁️]] and [notes](Orbit.md).',
  '',
  '---',
  '',
  '> plain quote',
].join('\n')

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
  cleanup()
})

function mount(doc: string, hooks: PreviewHooks, cursor = doc.length, reading = false): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ base: markdownLanguage }), livePreview(hooks), readingMode.of(reading)],
    }),
  })
  views.push(view)
  return view
}

function hooks(): PreviewHooks & { opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    image: vi.fn(async (reference: string) => (reference.includes('missing') ? undefined : `blob:${reference}`)),
    openLink: (target) => { opened.push(target) },
  }
}

describe('live preview', () => {
  it('renders the lines the cursor is not on, and leaves the text alone', () => {
    const preview = hooks()
    const view = mount(DOC, preview, 0)
    const text = view.contentDOM.textContent ?? ''
    // The heading line holds the cursor, so its marks stay visible.
    expect(text).toContain('## ')
    // Off the active line: emphasis and code marks are hidden, the bullet is drawn.
    expect(text).not.toContain('**Trachoma**')
    expect(text).toContain('Trachoma')
    expect(view.contentDOM.querySelector('.cm-qabas-strong')).not.toBeNull()
    expect(view.contentDOM.querySelector('.cm-qabas-bullet')?.textContent).toBe('•')
    expect(view.contentDOM.querySelector('.cm-qabas-callout-important.cm-qabas-callout-head')).not.toBeNull()
    expect(view.contentDOM.querySelector('.cm-qabas-quote')).not.toBeNull()
    expect(view.contentDOM.querySelector('.cm-qabas-hr')).not.toBeNull()
    expect(view.state.doc.toString()).toBe(DOC)
  })

  it('shows a line\'s markdown again when the cursor moves onto it', () => {
    const view = mount(DOC, hooks(), 0)
    const line = view.state.doc.line(2)
    act(() => { view.dispatch({ selection: { anchor: line.from + 3 } }) })
    expect(view.contentDOM.textContent).toContain('**Trachoma**')
  })

  it('draws figures, opens wikilinks and markdown links, and names a missing figure', async () => {
    const preview = hooks()
    const view = mount(`${DOC}\n![[missing.png]]\n![[page-007.png]]`, preview, 0)
    await vi.waitFor(() => {
      expect(view.contentDOM.querySelector('img[src="blob:./Figures/Conjunctiva/page-006.png"]')).not.toBeNull()
    })
    await vi.waitFor(() => { expect(view.contentDOM.querySelector('.cm-qabas-image-missing')?.textContent).toBe('missing.png') })
    const links = [...view.contentDOM.querySelectorAll('.cm-qabas-wikilink')]
    expect(links.map(link => link.textContent)).toEqual(['Cornea 👁️', 'notes'])
    for (const link of links) fireEvent.mouseDown(link)
    expect(preview.opened).toEqual(['Cornea 👁️', 'Orbit.md'])
  })

  it('renders a figure written inside a callout', async () => {
    const doc = '> [!example] Slide\n> ![x](./Figures/a.png)\n\nend'
    const view = mount(doc, hooks(), doc.length)
    await vi.waitFor(() => { expect(view.contentDOM.querySelector('img[src="blob:./Figures/a.png"]')).not.toBeNull() })
  })

  it('titles a callout with its type when its head line has no title', () => {
    const view = mount('> [!tip]\n> body\n\nend', hooks(), 18)
    expect(view.contentDOM.querySelector('.cm-qabas-callout-title')?.textContent).toBe('Tip')
    const unknown = mount('> [!custom]- folded\n> body\n\nend', hooks(), 26)
    expect(unknown.contentDOM.querySelector('.cm-qabas-callout-note')).not.toBeNull()
  })

  it('keeps an external link a link, and fenced code a code block', () => {
    const doc = '[site](https://example.com) and [x](notes.md#part)\n\n```\ncode\n```\n\nend'
    const view = mount(doc, hooks(), doc.length)
    expect(view.contentDOM.querySelector('.cm-qabas-link')).not.toBeNull()
    expect(view.contentDOM.querySelectorAll('.cm-qabas-codeblock').length).toBeGreaterThan(0)
  })

  it('lists headings with their level for the outline', () => {
    const state = EditorState.create({ doc: '# Title\ntext\n## 📖 Guide\n### Point', extensions: [markdown({ base: markdownLanguage })] })
    expect(headingsOf(state).map(({ level, text }) => [level, text])).toEqual([[1, 'Title'], [2, '📖 Guide'], [3, 'Point']])
  })
})

describe('figures and links', () => {
  it('knows which files are images', () => {
    expect(mediaTypeOf('Figures/x/page-006.PNG')).toBe('image/png')
    expect(mediaTypeOf('a.jpg?x=1')).toBe('image/jpeg')
    expect(mediaTypeOf('notes.md')).toBeUndefined()
    expect(mediaTypeOf('no-extension')).toBeUndefined()
  })

  it('reads a written reference as a relative path, never a remote URL', () => {
    expect(relativeReference('./Figures/Conjunctiva%20A/page-006.png')).toBe('./Figures/Conjunctiva A/page-006.png')
    expect(relativeReference('https://example.com/a.png')).toBeUndefined()
    expect(relativeReference('bad%E0.png')).toBe('bad%E0.png')
  })

  it('fetches a figure once, looks under Figures/ for a bare name, and frees it', async () => {
    const readBytes = vi.fn(async (path: string) => (path === 'Figures/page-006.png'
      ? { ok: true as const, value: new Uint8Array([1, 2, 3]) }
      : { ok: false as const, message: 'no' }))
    const loaded = vi.fn()
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:one')
    const cache = createImageCache({ read: vi.fn(), write: vi.fn(), readBytes }, '/w/n.md', loaded)
    expect(cache.peek('page-006.png')).toBeUndefined()
    expect(await cache.get('page-006.png')).toBe('blob:one')
    expect(await cache.get('page-006.png')).toBe('blob:one')
    expect(cache.peek('page-006.png')).toBe('blob:one')
    expect(await cache.get('https://example.com/x.png')).toBeUndefined()
    expect(await cache.get('./Figures/none.png')).toBeUndefined()
    expect(readBytes).toHaveBeenCalledTimes(3)
    expect(loaded).toHaveBeenCalled()
    const late = cache.get('late.png')
    cache.dispose()
    await late
    expect(revoke).toHaveBeenCalledWith('blob:one')
    vi.restoreAllMocks()
  })

  it('resolves a link against the note it was written in', () => {
    const from = '/w/modules/ophtha/Transcripts/Orbit 👁️.md'
    expect(linkTarget('Cornea 👁️', from)).toBe('/w/modules/ophtha/Transcripts/Cornea 👁️.md')
    expect(linkTarget('../Verbatim/Orbit.verbatim.md#top', from)).toBe('/w/modules/ophtha/Verbatim/Orbit.verbatim.md')
    expect(linkTarget('./Figures/a.png', from)).toBe('/w/modules/ophtha/Transcripts/Figures/a.png')
    expect(linkTarget('/abs/x.md', from)).toBe('/abs/x.md')
  })

  it('counts words in any script', () => {
    expect(wordCount('الدكتور قال **Trachoma** 3 مرات')).toBe(5)
    expect(wordCount('')).toBe(0)
  })
})

describe('engineNoteFiles', () => {
  it('maps the engine\'s answers and failures, conflicts included', async () => {
    const signal = new AbortController().signal
    const engine = {
      readFile: vi.fn(async () => ({ ok: true as const, value: { absolutePath: '/w/a.md', version: '1', text: 'x' } })),
      readFileBytes: vi.fn(async () => ({ ok: true as const, value: { bytes: btoa(String.fromCharCode(1)) } })),
      writeFile: vi.fn(async () => ({ ok: false as const, error: { code: 'transcriber-engine/write-conflict', message: 'changed' } })),
    }
    const files = engineNoteFiles(engine as never)
    expect(await files.read('/w/a.md', signal)).toEqual({ ok: true, value: { absolutePath: '/w/a.md', version: '1', text: 'x' } })
    expect(await files.readBytes('a.png', '/w/a.md', signal)).toEqual({ ok: true, value: new Uint8Array([1]) })
    expect(engine.readFileBytes).toHaveBeenCalledWith({ path: 'a.png', relativeTo: '/w/a.md' }, signal)
    await files.readBytes('a.png', undefined, signal)
    expect(engine.readFileBytes).toHaveBeenLastCalledWith({ path: 'a.png' }, signal)
    expect(await files.write('/w/a.md', 'y', '1', signal)).toEqual({ ok: false, conflict: true, message: 'changed' })
    const broken = engineNoteFiles({ ...engine, readFile: async () => { throw new Error('unmounted') } } as never)
    expect(await broken.read('/w/a.md', signal)).toEqual({ ok: false, message: 'unmounted' })
    const thrown = engineNoteFiles({ ...engine, readFile: async () => { throw 'plain' as unknown as Error } } as never)
    expect(await thrown.read('/w/a.md', signal)).toEqual({ ok: false, message: 'plain' })
  })
})

describe('reading mode', () => {
  const doc = '> [!NOTE] Slide only\n> Review preload.\n\n### MCQ 1 **[Past Exams - 2023, 2024]**\n\n**[IMP]** and **[Question Bank]**'

  it('draws every line, the cursor\'s too: a callout and its badges as they mean', () => {
    const view = mount(doc, hooks(), 0, true)
    expect(view.dom.querySelector('.cm-qabas-callout-note')).not.toBeNull()
    expect(view.dom.textContent).not.toContain('[!NOTE]')
    expect(view.dom.querySelector('.cm-qabas-badge-exam')?.textContent).toBe('Past Exams - 2023, 2024')
    expect(view.dom.querySelector('.cm-qabas-badge-imp')?.textContent).toBe('IMP')
    expect(view.dom.querySelector('.cm-qabas-badge-bank')?.textContent).toBe('Question Bank')
  })

  it('shows a badge\'s markdown on the line being edited', () => {
    const view = mount(doc, hooks(), doc.indexOf('MCQ'))
    expect(view.dom.querySelector('.cm-qabas-badge-exam')).toBeNull()
    expect(view.dom.querySelector('.cm-qabas-badge-imp')).not.toBeNull()
  })
})

describe('maths', () => {
  it('typesets inline TeX off the edited line, and leaves code and money alone', () => {
    const doc = 'Formula: $DO_2 = CO \\times CaO_2$ and $SaO_2$.\n\n`$PATH$` costs $5 and $10\n\nedited $x^2$'
    const view = mount(doc, hooks(), doc.length)
    const maths = [...view.dom.querySelectorAll('.cm-qabas-math')]
    expect(maths).toHaveLength(2)
    expect(maths[0]?.querySelector('.katex')).not.toBeNull()
    expect(maths[0]?.getAttribute('dir')).toBe('ltr')
    expect(view.dom.textContent).toContain('$PATH$')
    expect(view.dom.textContent).toContain('$5 and $10')
    expect(view.dom.textContent).toContain('$x^2$')
  })
})

describe('NotePanel', () => {
  const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

  function service(text = '# Orbit\n\nbody'): NoteService {
    return new NoteService(new Context(), {
      read: async path => ({ ok: true, value: { absolutePath: path, version: '1', text } }),
      readBytes: async () => ({ ok: false, message: 'none' }),
      write: async () => ({ ok: true, value: { version: '2' } }),
    }, 500)
  }

  it('reads an Arabic transcript right to left even when its title is English', () => {
    expect(documentDirection('# 🧪 Animal poisoning\n\nالدكتور بيبدأ المحاضرة وبيشرح الـ Snake bites')).toBe('rtl')
    expect(documentDirection('# Orbit\n\nThe orbit is a pyramid')).toBe('ltr')
  })

  it('says when nothing is open', () => {
    render(<NotePanel notes={service()} openLink={vi.fn()} labels={labels} t={t} />)
    expect(screen.getByText(en['panel.empty.title'])).toBeTruthy()
  })

  it('shows the open note inside the library\'s trail, switches modes, and closes back to the lecture', async () => {
    const notes = service()
    await notes.open('/w/a/Cornea.md')
    const library = vi.fn()
    const module = vi.fn()
    const lecture = vi.fn()
    const trail = () => [
      { label: 'Library', go: library },
      { label: 'Ophthalmology', go: module },
      { label: 'Cornea', go: lecture },
    ]
    render(<NotePanel notes={notes} openLink={vi.fn()} labels={labels} trail={trail} t={t} />)
    // No strip of tabs: the way back is the library's own trail.
    expect(screen.queryByRole('tab', { name: 'Cornea' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ophthalmology' }))
    expect(module).toHaveBeenCalledOnce()
    expect(screen.getByText(en['save.saved'])).toBeTruthy()
    expect(screen.getByText(/2 words/u)).toBeTruthy()
    // A note opens to read, drawn by the editor's own renderer and not editable.
    expect(document.querySelector('[data-mode="read"] .cm-qabas-reading')).not.toBeNull()
    expect(document.querySelector('[data-mode="read"] .cm-content')?.getAttribute('contenteditable')).toBe('false')
    fireEvent.click(screen.getByRole('tab', { name: en['mode.live'] }))
    expect(document.querySelector('[data-mode="live"] .cm-qabas-editing')).not.toBeNull()
    expect(document.querySelector('[data-mode="live"] .cm-content')?.getAttribute('contenteditable')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: en['mode.read'] }))
    expect(document.querySelector('[data-mode="read"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en['outline.toggle'] }))
    expect(screen.queryByText(en['outline.label'])).toBeNull()
    // Closing returns to the place it was opened from.
    fireEvent.click(screen.getByRole('button', { name: 'Close Cornea.md' }))
    await vi.waitFor(() => { expect(lecture).toHaveBeenCalledOnce() })
  })

  it('offers both ways out of a conflict, and says why a save or a read failed', async () => {
    const notes = service()
    await notes.open('/w/a/Orbit.md')
    const reload = vi.spyOn(notes, 'reload').mockResolvedValue()
    const keep = vi.spyOn(notes, 'keepMine').mockResolvedValue()
    act(() => {
      notes.state.update((draft) => {
        const note = draft.notes[0]
        if (note !== undefined) Object.assign(note, { save: 'conflict' })
      })
    })
    render(<NotePanel notes={notes} openLink={vi.fn()} labels={labels} t={t} />)
    fireEvent.click(screen.getByText(en['conflict.reload']))
    fireEvent.click(screen.getByText(en['conflict.keep']))
    expect(reload).toHaveBeenCalled()
    expect(keep).toHaveBeenCalled()
    act(() => {
      notes.state.update((draft) => {
        const note = draft.notes[0]
        if (note !== undefined) Object.assign(note, { save: 'failed', message: 'disk full' })
      })
    })
    expect(screen.getByText('Could not save: disk full')).toBeTruthy()
    act(() => {
      notes.state.update((draft) => {
        const note = draft.notes[0]
        if (note !== undefined) Object.assign(note, { status: 'failed', message: 'gone' })
      })
    })
    expect(screen.getByText('Could not open: gone')).toBeTruthy()
    act(() => {
      notes.state.update((draft) => {
        const note = draft.notes[0]
        if (note !== undefined) Object.assign(note, { status: 'loading' })
      })
    })
    expect(screen.getByText(en.loading)).toBeTruthy()
  })
})
