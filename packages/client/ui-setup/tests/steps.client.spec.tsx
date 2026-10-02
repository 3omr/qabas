// @vitest-environment jsdom
/**
 * The library step: it says what the workspace holds, and opens the library.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { LibraryStep } from '../src/client/steps.tsx'

const t = makeTranslate(en)
/** The coordinator's share of a step's props; the rest of the slot runtime is unused. */
function owner(): { stepId: string; complete: ReturnType<typeof vi.fn>; openSection: ReturnType<typeof vi.fn> } {
  return { stepId: 'x', complete: vi.fn(), openSection: vi.fn() }
}

afterEach(() => { cleanup() })

describe('LibraryStep', () => {
  it('reads, then says how many modules it found, and opens the library', () => {
    const base = owner()
    const workspace = createSnapshotStore<{ path?: string; modules?: number }>({})
    const openLibrary = vi.fn()
    const props = base as unknown as Parameters<typeof LibraryStep>[0]
    render(<LibraryStep {...props} progress={{ index: 3, total: 4 }} workspace={workspace} openLibrary={openLibrary}
      setFolder={vi.fn()} canSetFolder={createSnapshotStore(false)} t={t} />)
    expect(screen.getByText(en['library.lead.reading'])).toBeTruthy()
    act(() => { workspace.set({ path: '/study', modules: 3 }) })
    expect(screen.getByText(en['library.lead.found'].replace('{count}', '3'))).toBeTruthy()
    expect(screen.getByText('/study')).toBeTruthy()
    // The Host cannot move the library: no way to change it is offered.
    expect(screen.queryByRole('button', { name: en['library.folder.change'] })).toBeNull()
    act(() => { workspace.set({ path: '/study', modules: 0 }) })
    expect(screen.getByText(en['library.lead.empty'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['library.open'] }))
    expect(openLibrary).toHaveBeenCalledOnce()
    expect(base.complete).toHaveBeenCalledOnce()
  })

  it('moves the library to a folder the student types, and says why one was refused', async () => {
    const props = owner() as unknown as Parameters<typeof LibraryStep>[0]
    const setFolder = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: 'not a folder' })
      .mockResolvedValueOnce({ ok: true })
    render(<LibraryStep {...props} progress={undefined} workspace={createSnapshotStore({ path: '/app', modules: 0 })}
      openLibrary={vi.fn()} setFolder={setFolder} canSetFolder={createSnapshotStore(true)} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['library.folder.change'] }))
    const input = screen.getByLabelText(en['library.folder']) as HTMLInputElement
    expect(input.value).toBe('/app')
    fireEvent.change(input, { target: { value: ' /home/s/study ' } })
    fireEvent.click(screen.getByRole('button', { name: en['library.folder.use'] }))
    expect(await screen.findByText('not a folder')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['library.folder.use'] }))
    await vi.waitFor(() => { expect(screen.queryByLabelText(en['library.folder'])).toBeNull() })
    expect(setFolder).toHaveBeenLastCalledWith('/home/s/study')
    fireEvent.click(screen.getByRole('button', { name: en['library.folder.change'] }))
    fireEvent.click(screen.getByRole('button', { name: en['library.folder.cancel'] }))
    expect(screen.queryByLabelText(en['library.folder'])).toBeNull()
  })
})
