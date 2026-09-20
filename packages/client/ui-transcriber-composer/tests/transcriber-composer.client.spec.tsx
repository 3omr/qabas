// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranscriberComposerProps } from '../src/client/TranscriberComposer.tsx'
import { transcriberComposerFace } from '../src/client/face.ts'
import { zh } from '../src/client/locales.ts'
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
    },
    {
      title: 'Organophosphates',
      sources: [{ name: 'Organophosphates.mp3', path: 'modules/toxicology/Lecture/Organophosphates.mp3' }],
      transcribed: true,
    },
  ],
}]

const EMPTY_LECTURE_MODULE: ModuleView[] = [{
  id: 'empty',
  displayName: 'موديول فاضي',
  lectures: [],
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
    t: makeTranslate(zh),
  } as unknown as TranscriberComposerProps
  render(<TranscriberComposer {...props} />)
  return { read, setDraft, submit }
}

describe('TranscriberComposer', () => {
  it('lists modules and marks selected lectures as transcribed or waiting', async () => {
    mount(MODULES)
    await waitFor(() => {
      expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'الموديول' }).value).toBe('toxicology')
    })

    expect(screen.getByRole('option', { name: 'Corrosives — مستنية التفريغ' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Organophosphates — متفرغة' })).toBeTruthy()
  })

  it.each([
    ['فرّغ المحاضرة', 'فرّغ محاضرة «Corrosives» من موديول «سموم».'],
    ['راجع المسودة', 'راجع مسودة تفريغ محاضرة «Corrosives» في موديول «سموم».'],
    ['راجع مصادر الموديول', 'راجع مصادر موديول «سموم» وقولي لو في حاجة ناقصة.'],
    ['اتأكد من جاهزية الموديول', 'اتأكد إن موديول «سموم» جاهز للتفريغ وقولي لو في حاجة ناقصة.'],
  ])('puts the %s sentence in the draft without sending', async (label, expected) => {
    const { setDraft, submit } = mount(MODULES)
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: label }).disabled).toBe(false)
    })

    fireEvent.click(screen.getByRole('button', { name: label }))

    expect(setDraft).toHaveBeenCalledWith(expected)
    expect(submit).not.toHaveBeenCalled()
  })

  it('shows a useful empty-workspace message without throwing', async () => {
    mount([])
    expect(await screen.findByText(zh['empty.modules'])).toBeTruthy()
  })

  it('shows a useful message and keeps module actions available when a module has no lectures', async () => {
    mount(EMPTY_LECTURE_MODULE)
    expect(await screen.findByText(zh['empty.lectures'])).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'راجع مصادر الموديول' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'فرّغ المحاضرة' }).disabled).toBe(true)
  })

  it('keeps lecture paths in left-to-right elements', async () => {
    mount(MODULES)
    const path = await screen.findByText('modules/toxicology/Lecture/Corrosives Part 1.mp3')
    expect(path.getAttribute('dir')).toBe('ltr')
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
