// @vitest-environment jsdom
/** Library refreshes retain the resident list and scroll; navigation resets it. */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LibraryService } from '../src/client/service.ts'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => { cleanup(); localStorage.clear() })

it('preserves scroll through a job-driven module refresh and equivalent route snapshots', async () => {
  const title = 'Addiction د. مصطفى'
  const ctx = new Context()
  const listLectures = vi.fn(async () => ({ ok: true as const, value: {
    lectures: [{ title, parts: 1, recording_sources: ['Addiction.mp3'], transcribed: false }], materials: [],
  } }))
  const fiber = ctx.plugin(LibraryService, {
    listModules: async () => ({ ok: true, value: { workspace: '/fixture', modules: [{ module: 'tox', display_name: 'سموم Toxicology', notebooks: [], root: '/fixture/tox' }] } }),
    listLectures,
  })
  await fiber.await()
  const library = ctx.library
  try {
    await library.loadModules()
    library.navigate({ kind: 'module', module: 'tox' })
    await waitFor(() => { expect(library.state.getSnapshot().contents.tox?.status).toBe('ready') })
    const view = render(<LibraryPanel library={library} ask={vi.fn()} t={makeTranslate(en)} />)
    const main = view.getByRole('main')
    main.scrollTop = 480
    await act(async () => { await library.loadModule('tox') })
    expect(main.scrollTop).toBe(480)
    act(() => { library.state.set({ ...library.state.getSnapshot(), route: { kind: 'module', module: 'tox' } }) })
    expect(main.scrollTop).toBe(480)
    expect(view.getByText(title).getAttribute('dir')).toBe('auto')
    const crumb = view.container.querySelector('[aria-current="page"] bdi')
    expect(crumb?.textContent).toBe('سموم Toxicology')
    act(() => { library.navigate({ kind: 'lecture', module: 'tox', lecture: title }) })
    expect(main.scrollTop).toBe(0)
    expect(view.getByRole('heading', { level: 1 }).querySelector('bdi')?.textContent).toBe(title)
  } finally { await fiber.dispose() }
})
