// @vitest-environment jsdom
/** The exams page and a paper's questions are library routes reached and left through the breadcrumb. */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { LibraryService } from '../src/client/service.ts'
import type { LectureEditing } from '../src/client/editing.ts'
import { en } from '../src/client/locales.ts'

it('opens the exams page and a paper, and returns through the breadcrumb', async () => {
  const ctx = new Context()
  const library = new LibraryService(ctx, {
    listModules: async () => ({ ok: true, value: { workspace: '/study', modules: [
      { module: 'pediatric', display_name: 'Pediatric', notebooks: [], root: '/study/modules/pediatric' },
    ] } }),
    listLectures: async () => ({ ok: true, value: { lectures: [], materials: [] } }),
  })
  const release = library.provideEditing({
    listFiles: async () => ({ ok: true, value: [] }),
    define: async () => ({ ok: false, message: 'unused' }),
    undefine: async () => ({ ok: false, message: 'unused' }),
    importFile: async () => ({ ok: false, message: 'unused' }),
    renameFile: async () => ({ ok: false, message: 'unused' }),
    trashFile: async () => ({ ok: false, message: 'unused' }),
    upload: async () => ({ ok: false, message: 'unused' }),
  } satisfies LectureEditing)
  try {
    await library.loadModules()
    await library.loadModule('pediatric')
    library.navigate({ kind: 'module', module: 'pediatric' })
    render(<LibraryPanel library={library} ask={vi.fn()} t={makeTranslate(en)} />)
    expect(screen.getByRole('heading', { name: 'Pediatric', level: 1 })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['exams.manage'] }))
    expect(await screen.findByRole('heading', { name: en['exams.title'], level: 1 })).toBeTruthy()
    // The breadcrumb is the only way back; the module's title and facts stay on the module page.
    expect(screen.queryByRole('heading', { name: 'Pediatric' })).toBeNull()
    expect(screen.queryByRole('list', { name: en['module.facts'] })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to Pediatric' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    const trail = screen.getByRole('navigation', { name: en['panel.label'] })
    expect(library.currentTarget()).toMatchObject({ module: { id: 'pediatric' } })
    expect(library.currentTarget()?.lecture).toBeUndefined()
    act(() => { library.navigate({ kind: 'examQuestions', module: 'pediatric', path: 'Questions/Final 2024.pdf' }) })
    expect(within(trail).getByText('Final 2024.pdf')).toBeTruthy()
    fireEvent.click(within(trail).getByRole('button', { name: en['exams.title'] }))
    expect(library.state.getSnapshot().route).toEqual({ kind: 'exams', module: 'pediatric' })
    fireEvent.click(within(trail).getByRole('button', { name: 'Pediatric' }))
    expect(library.state.getSnapshot().route).toEqual({ kind: 'module', module: 'pediatric' })
    await waitFor(() => { expect(screen.getByRole('button', { name: en['exams.manage'] })).toBeTruthy() })
  } finally {
    cleanup()
    release()
    await ctx.fiber.dispose()
  }
})
