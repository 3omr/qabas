// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { FocusTimerSettings } from '../src/settings.ts'
import { FocusTimer, type FocusTimerProps } from '../src/client/FocusTimer.tsx'
import { en, type FocusTimerKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'
import { createFocusTimerStore } from '../src/client/store.ts'
import { MarketplaceAction } from '../src/client/MarketplaceAction.tsx'

let panel: ReturnType<ReturnType<typeof createFocusTimerStore>['create']>
let preference: ReturnType<typeof stubSettingsScope<FocusTimerSettings>>
let savePreference: ReturnType<typeof vi.fn<FocusTimerProps['savePreference']>>

beforeEach(() => {
  panel = createFocusTimerStore().create()
  preference = stubSettingsScope<FocusTimerSettings>()
  preference.publish({ status: 'ready', value: {}, revision: 1, writable: true })
  savePreference = vi.fn(async (minutes) => {
    preference.publish({ value: minutes === null ? {} : { minutes }, revision: 2 })
    return true
  })
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

function props(wide = true): FocusTimerProps {
  return { wide, actions: panel.actions,
    useStore: bindSnapshotSelector(panel),
    usePreference: bindSnapshotSelector(preference.scope), savePreference,
    t: ((key: FocusTimerKey, values: Record<string, string | number> = {}) =>
      (en[key]).replace(/\{(\w+)\}/gu, (_, name: string) => String(values[name]))) as FocusTimerProps['t'],
  } as FocusTimerProps
}

function open() { fireEvent.click(screen.getByRole('button', { name: en.title })) }
function duration(value: string) { fireEvent.change(screen.getByRole('spinbutton'), { target: { value } }) }
function click(name: string) { fireEvent.click(screen.getByRole('button', { name })) }
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms) }) }

it('opens the same running timer from the marketplace without adding another interval', () => {
  const close = vi.fn()
  render(<><FocusTimer {...props()} /><MarketplaceAction {...props()} close={close} /></>)
  click(en.open)
  expect(close).toHaveBeenCalledOnce()
  duration('2'); click(en.start); advance(12_000); click(en.close)
  expect(vi.getTimerCount()).toBe(1)
  click(en.open)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('timer').textContent).toBe('1:48')
  expect(vi.getTimerCount()).toBe(1)
  click(en.pause)
  expect(vi.getTimerCount()).toBe(0)
})

it('runs only after valid user input and preserves a paused countdown while the panel is closed', () => {
  const view = render(<FocusTimer {...props()} />)
  expect(vi.getTimerCount()).toBe(0)
  open()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.start }).disabled).toBe(true)
  for (const value of ['0', '-1', '0.5', '1441', '']) {
    duration(value)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.start }).disabled).toBe(true)
  }
  duration('1')
  expect(screen.getByRole('timer').textContent).toBe('1:00')
  click(en.start)
  expect(vi.getTimerCount()).toBe(1)
  expect(screen.getByRole<HTMLInputElement>('spinbutton').disabled).toBe(true)
  advance(12_000)
  expect(screen.getByRole('timer').textContent).toBe('0:48')
  click(en.pause)
  expect(vi.getTimerCount()).toBe(0)
  advance(50_000)
  expect(screen.getByRole('timer').textContent).toBe('0:48')
  click(en.close)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement?.getAttribute('title')).toBe(en.title)
  fireEvent.click(screen.getByRole('button', { name: 'Focus timer: 0:48' }))
  click(en.resume)
  click(en.close)
  advance(3_000)
  fireEvent.click(screen.getByRole('button', { name: 'Focus timer: 0:45' }))
  view.rerender(<FocusTimer {...props(false)} />)
  click(en.reset)
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByRole('timer').textContent).toBe('1:00')
  click(en.start)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('catches up after sleep, stops when complete, and clears state on a fresh mount', () => {
  const view = render(<FocusTimer {...props(false)} />)
  open(); duration('1'); click(en.start)
  act(() => { vi.setSystemTime(Date.now() + 120_000) })
  advance(1000)
  expect(screen.getByRole('timer').textContent).toBe('0:00')
  expect(screen.getByRole('status').textContent).toBe(en.done)
  expect(vi.getTimerCount()).toBe(0)
  click(en.start)
  act(() => { vi.setSystemTime(Date.now() + 120_000) })
  click(en.pause)
  expect(screen.getByRole('status').textContent).toBe(en.done)
  expect(vi.getTimerCount()).toBe(0)
  view.unmount()
  render(<FocusTimer {...props()} />)
  open()
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('')
  expect(screen.getByRole('status').textContent).toBe(en.idle)
})

it('uses English copy and accepts the documented maximum duration', () => {
  const close = vi.fn()
  render(<><FocusTimer {...props(true)} /><MarketplaceAction {...props(true)} close={close} /></>)
  click(en.open)
  expect(close).toHaveBeenCalledOnce()
  duration('1440')
  click(en.start)
  expect(screen.getByRole('timer').textContent).toBe('1440:00')
  expect(screen.getByRole('status').textContent).toBe(en.running)
  click(en.pause)
  click(en.reset)
  expect(screen.getByRole('status').textContent).toBe(en.idle)
})

it('loads and explicitly saves or clears a duration without persisting a countdown', async () => {
  preference.publish({ value: { minutes: 25 }, revision: 4 })
  const view = render(<FocusTimer {...props()} />)
  open()
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('25')
  expect(screen.getByText('Saved duration: 25 min')).toBeDefined()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.savePreference }).disabled).toBe(true)
  duration('30')
  await act(async () => { click(en.savePreference) })
  expect(savePreference).toHaveBeenCalledWith(30, 4)
  expect(screen.getByText('Saved duration: 30 min')).toBeDefined()
  click(en.start); advance(2000)
  act(() => { preference.publish({ value: { minutes: 15 }, revision: 3 }) })
  expect(screen.getByRole('timer').textContent).toBe('29:58')
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('30')
  expect(vi.getTimerCount()).toBe(1)
  view.unmount()
  render(<FocusTimer {...props()} />)
  expect(screen.getByRole('timer').textContent).toBe('15:00')
  expect(screen.getByRole('status').textContent).toBe(en.idle)
  await act(async () => { click(en.clearPreference) })
  expect(savePreference).toHaveBeenLastCalledWith(null, 3)
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('')
  expect(screen.getByText(en.noPreference)).toBeDefined()
})

it.each(['loading', 'unavailable', 'readonly', 'memory', 'no-revision'] as const)('keeps temporary timers usable with %s settings', (mode) => {
  if (mode === 'loading' || mode === 'unavailable') preference.publish({ status: mode })
  else if (mode === 'readonly') preference.publish({ writable: false })
  else if (mode === 'memory') preference.publish({ mode: 'memory' })
  else preference.publish({ revision: undefined })
  render(<FocusTimer {...props()} />)
  open(); duration('1')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.savePreference }).disabled).toBe(true)
  expect(screen.getByText(mode === 'loading' ? en.loadingPreference : en.unavailablePreference)).toBeDefined()
  click(en.start)
  expect(vi.getTimerCount()).toBe(1)
  expect(savePreference).not.toHaveBeenCalled()
})

it.each(['rejected', 'unconfirmed'] as const)('retains the draft after a %s save without a success message', async (outcome) => {
  savePreference.mockImplementationOnce(async () => {
    if (outcome === 'rejected') throw new Error('transport lost')
    return false
  })
  render(<FocusTimer {...props()} />)
  open(); duration('25')
  await act(async () => { click(en.savePreference) })
  expect(screen.getByRole('alert').textContent).toBe(en.unconfirmedPreference)
  expect(screen.getByRole<HTMLInputElement>('spinbutton').value).toBe('25')
  expect(screen.getByText(en.noPreference)).toBeDefined()
  duration('15')
  expect(screen.queryByRole('alert')).toBeNull()
  await act(async () => { click(en.savePreference) })
  expect(screen.getByText('Saved duration: 15 min')).toBeDefined()
})

it.each([true, false])('does not publish a late save after unmount (resolved=%s)', async (resolve) => {
  let settle!: (value: boolean) => void
  let reject!: (error: Error) => void
  savePreference.mockReturnValueOnce(new Promise<boolean>((done, fail) => { settle = done; reject = fail }))
  const view = render(<FocusTimer {...props()} />)
  open(); duration('25')
  const button = screen.getByRole('button', { name: en.savePreference })
  act(() => { button.click(); button.click() })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.savingPreference }).disabled).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('spinbutton').disabled).toBe(true)
  click(en.savingPreference)
  expect(savePreference).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => { if (resolve) settle(true); else reject(new Error('closed')) })
  expect(preference.listenerCount()).toBe(0)
})
