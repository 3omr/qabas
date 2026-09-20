// @vitest-environment jsdom
/**
 * The panel against a scripted workspace read.
 *
 * What is asserted is the reader's contract: the workspace is read on mount,
 * a module's lectures come out split into the two standings with the
 * transcribed ones first, a section with nothing in it is not drawn, a
 * multipart lecture says how many files it took, a module collapses, the
 * panel says when it could not read, and — the rule the whole design rests on
 * — nothing in the panel ever writes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { failureLine, splitLectures } from '../src/client/TranscriberBody.tsx'
import { zh } from '../src/client/locales.ts'
import { RUN_POLL_INTERVAL_MS } from '../src/client/store.ts'
import type { ModuleView } from '../src/client/workspace.ts'
import type { TranscriberRun } from '../src/client/runs.ts'
import { mountBody, ROOT, SESSION } from './mount.client.tsx'

const source = (name: string) => ({ name, path: `Lecture/${name}` })

const TOXO: ModuleView = {
  id: 'toxo',
  displayName: 'Toxicology',
  lectures: [
    { title: 'Heavy Metals', sources: [source('Heavy Metals.m4a')], transcribed: false },
    {
      title: 'Corrosives',
      sources: [source('Corrosives Part 1.mp3'), source('Corrosives Part 2.mp3')],
      transcribed: true,
    },
  ],
}

const RUNNING: TranscriberRun = {
  runId: 'run-heavy-metals',
  title: 'Heavy Metals — current attempt',
  phases: [
    { name: 'guide', label: 'Chronological Guide', state: 'validated' },
    { name: 'imp', label: 'Important Points', state: 'validated' },
    { name: 'mcqs', label: 'MCQs', state: 'validated' },
    { name: 'written', label: 'Written Questions', state: 'validated' },
    { name: 'cases', label: 'Clinical Cases', state: 'running' },
  ],
  done: ['guide', 'imp', 'mcqs', 'written'],
  running: ['cases'],
  failed: [],
  finished: false,
  status: 'running',
}

const FINISHED: TranscriberRun = {
  ...RUNNING,
  finished: true,
  status: 'success',
  running: [],
  done: RUNNING.phases.map(phase => phase.name),
  phases: RUNNING.phases.map(phase => ({ ...phase, state: 'validated' })),
}

const FAILED: TranscriberRun = {
  ...RUNNING,
  finished: true,
  status: 'failed',
  running: [],
  failed: ['cases'],
  phases: RUNNING.phases.map(phase => phase.name === 'cases' ? { ...phase, state: 'failed' } : phase),
}

afterEach(() => { cleanup(); vi.useRealTimers() })

/** The lecture rows in document order, as title plus standing. */
function rows(root: HTMLElement): [string, boolean][] {
  return [...root.querySelectorAll('[data-transcriber-row="lecture"]')].map(li => [
    li.querySelector('[title]')?.getAttribute('title') ?? '',
    li.hasAttribute('data-transcriber-transcribed'),
  ])
}

describe('TranscriberBody', () => {
  it('says so when the session has no workspace directory, and reads nothing', () => {
    const { view, script } = mountBody(null)
    expect(view.container.querySelector('[data-transcriber-state="no-workspace"]')?.textContent)
      .toBe(zh.noWorkspace)
    expect(script.read).not.toHaveBeenCalled()
  })

  it('reads the workspace on mount and shows it is working', () => {
    const { view, script } = mountBody()
    expect(script.read).toHaveBeenCalledWith(SESSION, expect.any(AbortSignal))
    expect(view.container.querySelector('[data-transcriber-row="loading"]')?.textContent).toBe(zh.loading)
  })

  it('draws the transcribed lectures under their heading, then the waiting ones under theirs', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    expect([...view.container.querySelectorAll('[data-transcriber-section]')]
      .map(li => li.getAttribute('data-transcriber-section')))
      .toEqual(['transcribed', 'pending'])
    expect(rows(view.container)).toEqual([['Corrosives', true], ['Heavy Metals', false]])
  })

  it('draws an unfinished run across its phases and names the current phase', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, run: RUNNING }] }))
    const row = [...view.container.querySelectorAll('[data-transcriber-row="lecture"]')]
      .find(item => item.querySelector('[title="Heavy Metals"]') !== null)
    expect(row?.getAttribute('data-transcriber-progress')).toBe('4/5')
    expect(row?.textContent).toContain('▓▓▓▓░░ 4/5')
    expect(row?.textContent).toContain('转写中：Clinical Cases')
  })

  it('puts a failed run in a failed section instead of the waiting section', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, run: FAILED }] }))
    expect([...view.container.querySelectorAll('[data-transcriber-section]')]
      .map(section => section.getAttribute('data-transcriber-section')))
      .toEqual(['transcribed', 'failed'])
    const row = [...view.container.querySelectorAll('[data-transcriber-row="lecture"]')]
      .find(item => item.querySelector('[title="Heavy Metals"]') !== null)
    expect(row?.getAttribute('data-transcriber-run-state')).toBe('failed')
    expect(row?.textContent).toContain('转写失败：Clinical Cases')
  })

  it('says how many files a multipart lecture took, and stays quiet for a single one', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    const counts = [...view.container.querySelectorAll('[data-transcriber-row="lecture"]')]
      .map(li => li.lastElementChild?.textContent)
    expect(counts[0]).toBe('2 个录音文件')
    expect(counts[1]).toBe('Heavy Metals')
  })

  it('does not draw a heading for a standing with nothing in it', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({
      ok: true,
      value: [{ ...TOXO, lectures: [TOXO.lectures[1]!] }],
    }))
    expect([...view.container.querySelectorAll('[data-transcriber-section]')]
      .map(li => li.getAttribute('data-transcriber-section')))
      .toEqual(['transcribed'])
  })

  it('counts a module\'s progress on its own row', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    expect(view.container.querySelector('[data-transcriber-row="module"] button')?.textContent)
      .toContain('1/2 已转写')
  })

  it('collapses a module and leaves its lectures undrawn', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    const row = view.container.querySelector('[data-transcriber-row="module"] button')!
    expect(row.getAttribute('aria-expanded')).toBe('true')
    await act(async () => { fireEvent.click(row) })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(rows(view.container)).toEqual([])
  })

  it('reads again when reload is pressed', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    await act(async () => { fireEvent.click(view.container.querySelector(`[aria-label="${zh.refresh}"]`)!) })
    expect(script.read).toHaveBeenCalledTimes(2)
  })

  it('polls a visible unfinished run, then stops after the result is read', async () => {
    vi.useFakeTimers()
    const { script } = mountBody()
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, run: RUNNING }] }))
    expect(script.read).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS) })
    expect(script.read).toHaveBeenCalledTimes(2)
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, run: FINISHED }] }))

    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 2) })
    expect(script.read).toHaveBeenCalledTimes(2)
  })

  it('does not start polling when no module has an unfinished run', async () => {
    vi.useFakeTimers()
    const { script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 2) })
    expect(script.read).toHaveBeenCalledTimes(1)
  })

  it('does not poll an unfinished run while the tab is hidden', async () => {
    vi.useFakeTimers()
    const { script } = mountBody(ROOT, false)
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, run: RUNNING }] }))
    await act(async () => { await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS * 2) })
    expect(script.read).toHaveBeenCalledTimes(1)
  })

  it('tells an empty workspace apart from a broken one', async () => {
    const empty = mountBody()
    await act(() => empty.script.settle({ ok: true, value: [] }))
    expect(empty.view.container.querySelector('[data-transcriber-row="no-modules"]')?.textContent)
      .toBe(zh['empty.modules'])
    cleanup()

    const broken = mountBody()
    await act(() => broken.script.settle({
      ok: false,
      error: new RemoteError('gateway/internal', 'connection lost', {}),
    }))
    const failed = broken.view.container.querySelector('[data-transcriber-row="failed"]')
    expect(failed?.getAttribute('data-transcriber-code')).toBe('gateway/internal')
    expect(failed?.textContent).toContain('connection lost')
  })

  it('says a module has no recordings rather than drawing two empty headings', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [{ ...TOXO, lectures: [] }] }))
    expect(view.container.querySelector('[data-transcriber-row="empty"]')?.textContent)
      .toBe(zh['empty.lectures'])
  })

  it('offers no control that would start a run: the chat is where that is asked for', async () => {
    const { view, script } = mountBody()
    await act(() => script.settle({ ok: true, value: [TOXO] }))
    // Every button in the panel is either reload or a module disclosure.
    const labels = [...view.container.querySelectorAll('button')]
      .map(button => button.getAttribute('aria-label') ?? button.getAttribute('aria-expanded'))
    expect(labels).toEqual([zh.refresh, 'true'])
  })
})

describe('splitLectures', () => {
  it('keeps each standing in the order the module listed them', () => {
    const { transcribed, pending } = splitLectures(TOXO.lectures)
    expect(transcribed.map(one => one.title)).toEqual(['Corrosives'])
    expect(pending.map(one => one.title)).toEqual(['Heavy Metals'])
  })
})

describe('failureLine', () => {
  const t = makeTranslate(zh)

  it('names a missing workspace as itself', () => {
    expect(failureLine(t, new RemoteError('workspace-file/not-found', 'x', { path: 'p' })))
      .toBe(zh['error.notFound'])
  })

  it('passes a transport failure through, since the panel can add nothing to it', () => {
    expect(failureLine(t, new RemoteError('gateway/internal', 'connection lost', {})))
      .toContain('connection lost')
  })
})
