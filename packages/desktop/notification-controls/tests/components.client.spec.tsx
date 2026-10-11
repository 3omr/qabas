// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { NotificationPreferences } from '../src/settings.ts'
import { NotificationControls, type NotificationControlsProps } from '../src/client/NotificationControls.tsx'
import { en, type NotificationControlsKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

let preference: ReturnType<typeof stubSettingsScope<NotificationPreferences>>
let save: ReturnType<typeof vi.fn<NotificationControlsProps['save']>>
beforeEach(() => {
  preference = stubSettingsScope<NotificationPreferences>()
  preference.publish({ status: 'ready', value: { completed: true, failed: true }, revision: 3, writable: true })
  save = vi.fn(async (field, enabled) => {
    preference.publish({ value: { ...preference.scope.getSnapshot().value!, [field]: enabled }, revision: 4 })
    return true
  })
})
afterEach(cleanup)

function props(): NotificationControlsProps {
  return { close: vi.fn(), save, usePreference: bindSnapshotSelector(preference.scope),
    t: ((key: NotificationControlsKey) => en[key]) as NotificationControlsProps['t'] } as NotificationControlsProps
}
function open() { fireEvent.click(screen.getByText(en.configure)) }

it('changes independent switches through their observed revision', async () => {
  render(<NotificationControls {...props()} />)
  open()
  const copy = en
  const completed = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.completed })
  const failed = screen.getByRole<HTMLInputElement>('checkbox', { name: copy.failed })
  expect(completed.checked).toBe(true)
  await act(async () => { fireEvent.click(completed) })
  expect(save).toHaveBeenLastCalledWith('completed', false, 3)
  expect(completed.checked).toBe(false)
  expect(failed.checked).toBe(true)
  await act(async () => { fireEvent.click(failed) })
  expect(save).toHaveBeenLastCalledWith('failed', false, 4)
  expect(failed.checked).toBe(false)
  expect(screen.getByText(copy.removal)).toBeDefined()
})

it.each(['loading', 'unavailable', 'readonly', 'memory', 'no-revision', 'no-value'] as const)('does not offer writes with %s settings', (mode) => {
  if (mode === 'loading' || mode === 'unavailable') preference.publish({ status: mode })
  else if (mode === 'readonly') preference.publish({ writable: false })
  else if (mode === 'memory') preference.publish({ mode: 'memory' })
  else if (mode === 'no-value') preference.publish({ value: undefined })
  else preference.publish({ revision: undefined })
  render(<NotificationControls {...props()} />)
  open()
  expect(screen.getByRole('status').textContent).toBe(mode === 'loading' ? en.loading : en.unavailable)
  for (const checkbox of screen.queryAllByRole('checkbox')) fireEvent.click(checkbox)
  expect(save).not.toHaveBeenCalled()
})

it.each(['rejected', 'unconfirmed'] as const)('retains observed switches after a %s write', async (outcome) => {
  save.mockImplementationOnce(async () => { if (outcome === 'rejected') throw new Error('lost'); return false })
  render(<NotificationControls {...props()} />)
  open()
  const completed = screen.getByRole<HTMLInputElement>('checkbox', { name: en.completed })
  await act(async () => { fireEvent.click(completed) })
  expect(completed.checked).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(en.unconfirmed)
  await act(async () => { fireEvent.click(completed) })
  expect(completed.checked).toBe(false)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each([true, false])('ignores late save settlement after unmount (resolved=%s)', async (success) => {
  let resolve!: (value: boolean) => void
  let reject!: (error: Error) => void
  save.mockReturnValueOnce(new Promise<boolean>((done, fail) => { resolve = done; reject = fail }))
  const view = render(<NotificationControls {...props()} />)
  open()
  const completed = screen.getByRole('checkbox', { name: en.completed })
  act(() => { completed.click(); completed.click() })
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('status').textContent).toBe(en.saving)
  view.unmount()
  await act(async () => { if (success) resolve(true); else reject(new Error('closed')) })
  expect(preference.listenerCount()).toBe(0)
})
