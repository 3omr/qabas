// @vitest-environment jsdom
/**
 * A transcript's figures are files beside it, and must paint as pictures.
 *
 * The figures a lecture transcript links are rendered slide pages saved in
 * `Figures/<lecture>/` next to the document. A browser resolves that against
 * the page URL, so every one of them rendered as alt text inside the app while
 * rendering correctly in the editor the student wrote it in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { MarkdownBody, type MarkdownBodyProps } from '../src/client/markdown/MarkdownBody.tsx'
import { imageMediaTypeOf, isRelativeImagePath, relativeImagePath } from '../src/client/markdown/relative-images.ts'
import { en } from '../src/client/markdown/locales.ts'

const ADDRESS = 'dsh-resource://file/session/markdown/modules/toxo/Transcripts/Corrosives.md'
let createDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
  }
})

function props(text: string, readRelated?: MarkdownBodyProps['readRelated']): MarkdownBodyProps {
  return {
    resourceAddress: ADDRESS,
    content: { kind: 'text', text, pages: [{ offset: 1, text, lines: text.split('\n').length }], eof: true },
    wrap: false,
    readRelated,
    t: makeTranslate(en),
  } as MarkdownBodyProps
}

function failure(): RemoteResult<WorkspaceFileBytes> {
  return { ok: false, error: new RemoteError('workspace-file/not-found', 'not found', { path: 'missing.png' }) }
}

function bytes(absolutePath: string) {
  return { ok: true as const, value: { absolutePath, version: '1', offset: 0, data: 'AQID', eof: true } }
}

const FIGURE = '![Corrosives — slide 6](<./Figures/Corrosive 1/page-006.png>)'

describe('a transcript\'s relative figures', () => {
  it('paints them as images read through the Host, not as alt text', async () => {
    const readRelated = vi.fn(async (_address: string, relativePath: string) =>
      bytes(`/workspace/modules/toxo/Transcripts/${relativePath}`))
    const view = render(<MarkdownBody {...props(FIGURE, readRelated)} />)
    await act(async () => { await Promise.resolve() })

    expect(readRelated).toHaveBeenCalledWith(ADDRESS, './Figures/Corrosive 1/page-006.png', expect.anything())
    const image = view.container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    expect(image?.getAttribute('alt')).toBe('Corrosives — slide 6')
    expect(create.mock.calls[0]?.[0].type).toBe('image/png')
  })

  it('asks the Host once per figure, however many times the document repaints', async () => {
    const readRelated = vi.fn(async (_address: string, relativePath: string) =>
      bytes(`/workspace/modules/toxo/Transcripts/${relativePath}`))
    const view = render(<MarkdownBody {...props(FIGURE, readRelated)} />)
    await act(async () => { await Promise.resolve() })
    view.rerender(<MarkdownBody {...props(`${FIGURE}\n\nMore prose.`, readRelated)} />)
    await act(async () => { await Promise.resolve() })

    expect(readRelated).toHaveBeenCalledTimes(1)
  })

  it('survives the repaints between asking for a figure and receiving it', async () => {
    // The read belongs to the document, not to the paint that noticed the
    // figure. Scoping its cancellation to the render aborted every read on
    // the next one -- which is every read, in a document that streams.
    let release: (() => void) | undefined
    const seen: AbortSignal[] = []
    const readRelated = vi.fn((_address: string, relativePath: string, signal: AbortSignal) => {
      seen.push(signal)
      return new Promise<ReturnType<typeof bytes>>((resolve) => {
        release = () => { resolve(bytes(`/workspace/modules/toxo/Transcripts/${relativePath}`)) }
      })
    })
    const view = render(<MarkdownBody {...props(FIGURE, readRelated)} />)
    view.rerender(<MarkdownBody {...props(`${FIGURE}\n\nStill streaming.`, readRelated)} />)
    view.rerender(<MarkdownBody {...props(`${FIGURE}\n\nStill streaming. And more.`, readRelated)} />)

    expect(seen.every(signal => !signal.aborted)).toBe(true)
    await act(async () => { release?.(); await Promise.resolve() })
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:https://preview.invalid/1')
  })

  it('leaves a figure the Host cannot read as its alt text, and renders the rest', async () => {
    const readRelated = vi.fn(async () => failure())
    const view = render(<MarkdownBody {...props(`# Corrosives\n\n${FIGURE}`, readRelated)} />)
    await act(async () => { await Promise.resolve() })

    expect(view.container.querySelector('img')).toBeNull()
    expect(view.getByRole('heading', { name: 'Corrosives' })).toBeDefined()
  })

  it('never sends the Host something that is already a URL', () => {
    expect(isRelativeImagePath('./Figures/a.png')).toBe(true)
    expect(isRelativeImagePath('Figures/a.png')).toBe(true)
    expect(isRelativeImagePath('https://example.test/a.png')).toBe(false)
    expect(isRelativeImagePath('data:image/png;base64,AA')).toBe(false)
    expect(isRelativeImagePath('/etc/passwd')).toBe(false)
    expect(isRelativeImagePath('')).toBe(false)
  })

  it('restores the spaces a bracketed destination keeps and an encoded one loses', () => {
    expect(relativeImagePath('./Figures/Corrosive 1/page-006.png')).toBe('./Figures/Corrosive 1/page-006.png')
    expect(relativeImagePath('./Figures/Corrosive%201/page-006.png')).toBe('./Figures/Corrosive 1/page-006.png')
    expect(relativeImagePath('./Figures/100%.png')).toBe('./Figures/100%.png')
  })

  it('types the Blob from the file the Host resolved, and paints nothing it cannot', () => {
    expect(imageMediaTypeOf('/a/page-006.PNG')).toBe('image/png')
    expect(imageMediaTypeOf('/a/scan.jpg')).toBe('image/jpeg')
    expect(imageMediaTypeOf('/a/notes.md')).toBeUndefined()
    expect(imageMediaTypeOf('/a/noextension')).toBeUndefined()
  })
})
