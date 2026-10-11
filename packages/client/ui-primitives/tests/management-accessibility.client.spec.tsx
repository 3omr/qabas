// @vitest-environment jsdom
/** Dialog ownership and actionable toast focus remain usable during management writes. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Modal } from '../src/Modal.tsx'
import { Toast } from '../src/Toast.tsx'

afterEach(cleanup)
it('traps dialog Tab and restores the trigger after Escape', () => {
  const close = vi.fn()
  const trigger = document.createElement('button')
  document.body.append(trigger); trigger.focus()
  const view = render(<Modal open onClose={close} title="Edit" closeLabel="Close"><input aria-label="Title" /><button>Save</button></Modal>)
  screen.getByRole('button', { name: 'Save' }).focus()
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  view.unmount(); expect(document.activeElement).toBe(trigger); trigger.remove()
})
it('keeps actionable undo available until explicit dismissal', () => {
  vi.useFakeTimers()
  try {
    const done = vi.fn()
    const undo = vi.fn()
    render(<Toast text="Removed" dismissLabel="Dismiss" action={{ label: 'Undo', onClick: undo }} onDone={done} />)
    screen.getByRole('button', { name: 'Undo' }).focus()
    vi.advanceTimersByTime(30000)
    expect(done).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(undo).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); expect(done).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
