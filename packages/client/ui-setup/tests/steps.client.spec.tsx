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
    render(<LibraryStep {...props} progress={{ index: 3, total: 4 }} workspace={workspace} openLibrary={openLibrary} t={t} />)
    expect(screen.getByText(en['library.lead.reading'])).toBeTruthy()
    act(() => { workspace.set({ path: '/study', modules: 3 }) })
    expect(screen.getByText(/Found 3 modules in \/study/u)).toBeTruthy()
    act(() => { workspace.set({ path: '/study', modules: 0 }) })
    expect(screen.getByText(/There are no modules in \/study/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en['library.open'] }))
    expect(openLibrary).toHaveBeenCalledOnce()
    expect(base.complete).toHaveBeenCalledOnce()
  })
})
