// @vitest-environment jsdom
/** Exam management is a separate library route with navigation back to its module. */
import { Context } from '@deepseek-ai/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LibraryPanel } from '../src/client/LibraryPanel.tsx'
import { LibraryService } from '../src/client/service.ts'
import type { LectureEditing } from '../src/client/editing.ts'
import { en } from '../src/client/locales.ts'

it('opens an exam page, leaves lecture content behind and returns to the module', async () => {
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
    const moduleFacts = screen.getByRole('list', { name: en['module.facts'] }).textContent
    fireEvent.click(screen.getByRole('button', { name: en['exams.manage'] }))
    expect(await screen.findByRole('heading', { name: en['exams.title'], level: 2 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Pediatric', level: 1 })).toBeTruthy()
    expect(screen.getByRole('list', { name: en['module.facts'] }).textContent).toBe(moduleFacts)
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('button', { name: en['manage.open'] })).toBeNull()
    const trail = screen.getByRole('navigation', { name: en['panel.label'] })
    expect(within(trail).getByRole('button', { name: 'Pediatric' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to Pediatric' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en['exams.manage'] })).toBeTruthy() })
    expect(screen.queryByRole('heading', { name: en['exams.title'], level: 2 })).toBeNull()
    act(() => { library.navigate({ kind: 'exams', module: 'pediatric' }) })
    expect(screen.getByRole('heading', { name: en['exams.title'], level: 2 })).toBeTruthy()
    expect(library.currentTarget()).toMatchObject({ module: { id: 'pediatric' } })
    expect(library.currentTarget()?.lecture).toBeUndefined()
    fireEvent.click(within(trail).getByRole('button', { name: 'Pediatric' }))
    expect(library.state.getSnapshot().route).toEqual({ kind: 'module', module: 'pediatric' })
  } finally {
    cleanup()
    release()
    await ctx.fiber.dispose()
  }
})
