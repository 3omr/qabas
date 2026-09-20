// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranscriberComposerProps } from '../src/client/TranscriberComposer.tsx'
import { transcriberComposerFace } from '../src/client/face.ts'
import { en } from '../src/client/locales.ts'
import { createTranscriberComposerStore } from '../src/client/store.ts'
import { TranscriberComposer } from '../src/client/TranscriberComposer.tsx'

afterEach(cleanup)

const SESSION = 'composer-test' as SessionId

const MODULES: ModuleView[] = [{
  id: 'toxicology',
  displayName: 'سموم',
  lectures: [
    {
      title: 'Corrosives',
      sources: [{ name: 'Corrosives Part 1.mp3', path: 'modules/toxicology/Lecture/Corrosives Part 1.mp3' }],
      transcribed: false,
      inNotebookOnly: false,
    },
    {
      title: 'Organophosphates',
      sources: [{ name: 'Organophosphates.mp3', path: 'modules/toxicology/Lecture/Organophosphates.mp3' }],
      transcribed: true,
      inNotebookOnly: false,
    },
  ],
  notebookStatus: 'ready',
  questionFileExists: false,
}]

const EMPTY_LECTURE_MODULE: ModuleView[] = [{
  id: 'empty',
  displayName: 'موديول فاضي',
  lectures: [],
  notebookStatus: 'ready',
  questionFileExists: false,
}]

function hookOf<T>(instance: { subscribe: (listener: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(selector: (state: T) => S): S {
    return selector(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

function mount(modules: ModuleView[]) {
  const store = createTranscriberComposerStore().create()
  const setDraft = vi.fn()
  const submit = vi.fn()
  const read = vi.fn(async () => ({ ok: true as const, value: modules }))
  const injected = transcriberComposerFace(read)(SESSION, store.actions)
  const props = {
    useStore: hookOf(store),
    actions: store.actions,
    inputActions: {
      setDraft,
      submit,
    },
    start: injected.start,
    refresh: injected.refresh,
    t: makeTranslate(en),
  } as unknown as TranscriberComposerProps
  render(<TranscriberComposer {...props} />)
  return { read, setDraft, submit }
}

describe('TranscriberComposer', () => {
  it('lists modules and marks selected lectures as transcribed or waiting', async () => {
    mount(MODULES)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Module' }).value).toBe('toxicology')
    })

    expect(screen.getByRole('option', { name: 'Corrosives — Waiting' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Organophosphates — Transcribed' })).toBeTruthy()
  })

  it.each([
    ['Transcribe lecture', 'فرّغ محاضرة «Corrosives» من موديول «سموم».'],
    ['Audit module sources', 'راجع مصادر موديول «سموم» وقولي لو في حاجة ناقصة.'],
    ['Check module readiness', 'اتأكد إن موديول «سموم» جاهز للتفريغ وقولي لو في حاجة ناقصة.'],
    ['Find untranscribed lectures', 'دور في النوت بوك على المحاضرات اللي لسه ماتفَرّغتش في موديول «سموم».'],
    ['Prepare question file', 'جهّز ملف الأسئلة لموديول «سموم».'],
  ])('puts the applicable %s sentence in the draft without sending', async (label, expected) => {
    const { setDraft, submit } = mount(MODULES)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    await screen.findByRole('button', { name: label })

    fireEvent.click(screen.getByRole('button', { name: label }))

    expect(setDraft).toHaveBeenCalledWith(expected)
    expect(submit).not.toHaveBeenCalled()
  })

  it('removes transcribe and offers review when the selected lecture is finished', async () => {
    const { setDraft, submit } = mount(MODULES)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    const lecture = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Lecture' })
    fireEvent.change(lecture, { target: { value: 'Organophosphates' } })

    expect(screen.queryByRole('button', { name: 'Transcribe lecture' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review transcript' }))
    expect(setDraft).toHaveBeenCalledWith('راجع مسودة تفريغ محاضرة «Organophosphates» في موديول «سموم».')
    expect(submit).not.toHaveBeenCalled()
  })

  it('shows a useful empty-workspace message without throwing', async () => {
    mount([])
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    expect(await screen.findByText(en['empty.modules'])).toBeTruthy()
  })

  it('shows a useful message and keeps module actions available when a module has no lectures', async () => {
    mount(EMPTY_LECTURE_MODULE)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    expect(await screen.findByText(en['empty.lectures'])).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Audit module sources' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Transcribe lecture' })).toBeNull()
  })

  it('keeps lecture paths in left-to-right elements', async () => {
    mount(MODULES)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    const path = await screen.findByText('modules/toxicology/Lecture/Corrosives Part 1.mp3')
    expect(path.getAttribute('dir')).toBe('ltr')
  })

  it('offers transcription for a lecture that exists only in NotebookLM', async () => {
    // The audio is uploaded once and deleted, so on a normal workspace every
    // lecture is this kind. The default route reads the transcript back from
    // the notebook without opening the recording, so there is nothing about a
    // missing local file that stops a transcription.
    const remoteOnly: ModuleView[] = [{
      ...MODULES[0]!,
      lectures: [{
        title: 'Notebook lecture', sources: [], transcribed: false, inNotebookOnly: true,
      }],
    }]
    mount(remoteOnly)
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    await screen.findByRole('combobox', { name: 'Lecture' })
    expect(screen.getByRole('button', { name: 'Transcribe lecture' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Find untranscribed lectures' })).toBeTruthy()
  })

  it('removes question preparation when the question index is already present', async () => {
    mount([{ ...MODULES[0]!, questionFileExists: true }])
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    await screen.findByRole('combobox', { name: 'Lecture' })
    expect(screen.queryByRole('button', { name: 'Prepare question file' })).toBeNull()
  })

  it('says what is pending while NotebookLM has not answered', async () => {
    mount([{ ...MODULES[0]!, notebookStatus: 'pending' }])
    fireEvent.click(screen.getByRole('button', { name: 'Lecture helper' }))
    expect(await screen.findByText(en['notebook.pending'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Find untranscribed lectures' })).toBeNull()
  })

  it('ignores a read that is aborted before it settles', async () => {
    const store = createTranscriberComposerStore().create()
    const controller = new AbortController()
    let settle: ((result: { ok: true; value: ModuleView[] }) => void) | undefined
    const read = vi.fn(() => new Promise<{ ok: true; value: ModuleView[] }>((resolve) => { settle = resolve }))
    const injected = transcriberComposerFace(read)(SESSION, store.actions)
    injected.start(controller.signal)
    controller.abort()
    settle?.({ ok: true, value: MODULES })
    await act(async () => { await Promise.resolve() })
    expect(store.getSnapshot().phase).toBe('loading')
  })
})
