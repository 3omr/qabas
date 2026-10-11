// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { DelegationLauncher, type DelegationProps, type DelegationReceipt } from '../src/client/DelegationLauncher.tsx'
import { MarketplaceAction } from '../src/client/MarketplaceAction.tsx'
import { createDelegationStore } from '../src/client/store.ts'
import { en, type DelegationKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)

function bench() {
  const panel = createDelegationStore().create()
  const id = SessionId('parent')
  const selected = { id, displayTitle: 'Project', cwd: '/workspace/project', running: false, blank: false, updatedAt: 0 }
  const sessions = { current: id, byId: { [id]: selected }, jobsBySession: {} } as SessionListState
  const providers = vi.fn(async () => ['fixture', 'other'])
  const submit = vi.fn<DelegationProps['submit']>(async () => ({ kind: 'success', text: 'Queued fixture job' }))
  const props: DelegationProps = {
    wide: true, actions: panel.actions, useStore: bindSnapshotSelector(panel), providers, submit,
    readJob: vi.fn(), cancelJob: vi.fn(),
    t: ((key: DelegationKey) => en[key]) as DelegationProps['t'],
    useSessions: select => select(sessions),
    useConnectionGeneration: select => select({ id: 1, host: { home: '/test' } }),
  } as DelegationProps
  return { props, panel, sessions, providers, submit, id }
}

const click = (name: string) => { fireEvent.click(screen.getByRole('button', { name })) }
const task = (value: string) => { fireEvent.change(screen.getByRole('textbox'), { target: { value } }) }
const provider = (value: string) => { fireEvent.change(screen.getByRole('combobox'), { target: { value } }) }
const consent = () => { fireEvent.click(screen.getByRole('checkbox')) }
const sendEnabled = () => !screen.getByRole<HTMLButtonElement>('button', { name: en.send }).disabled
async function open() { click(en.title); await screen.findByRole('option', { name: 'fixture' }) }

it('shares the marketplace launcher, requires exact consent and never submits on opening', async () => {
  const b = bench()
  const close = vi.fn()
  render(<><DelegationLauncher {...b.props} /><MarketplaceAction {...b.props} close={close} /></>)
  expect(b.providers).not.toHaveBeenCalled()
  click(en.open)
  await screen.findByRole('option', { name: 'fixture' })
  expect(close).toHaveBeenCalledOnce()
  expect(b.submit).not.toHaveBeenCalled()
  expect(sendEnabled()).toBe(false)
  provider('fixture'); task('Review tests'); consent()
  expect(sendEnabled()).toBe(true)
  consent()
  expect(sendEnabled()).toBe(false)
  consent(); task('Review source')
  expect(sendEnabled()).toBe(false)
  consent(); provider('other')
  expect(sendEnabled()).toBe(false)
  consent(); task('   '); consent()
  expect(sendEnabled()).toBe(false)
  task('Review tests'); consent()
  click(en.send)
  await screen.findByText(en.submitted)
  expect(b.submit).toHaveBeenCalledExactlyOnceWith(b.id, 'other', 'Review tests')
  expect(sendEnabled()).toBe(false)
  click(en.close)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement?.getAttribute('title')).toBe(en.title)
  click(en.open)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Review tests')
})

it('invalidates review when session or connection changes and ignores old receipts', async () => {
  const b = bench()
  const view = render(<DelegationLauncher {...b.props} />)
  await open(); provider('fixture'); task('Review'); consent()
  const other = SessionId('other')
  b.sessions.byId[other] = { ...b.sessions.byId[b.id]!, id: other, displayTitle: 'Other project' }
  b.sessions.current = other
  view.rerender(<DelegationLauncher {...b.props} />)
  expect(sendEnabled()).toBe(false)
  consent()
  const pending = Promise.withResolvers<DelegationReceipt | null>()
  b.submit.mockReturnValueOnce(pending.promise)
  click(en.send)
  view.rerender(<DelegationLauncher {...b.props} useConnectionGeneration={select => select(undefined)} />)
  expect(screen.getByText(en.disconnected)).toBeTruthy()
  await act(async () => { pending.resolve({ kind: 'success' }); await pending.promise })
  expect(screen.queryByText(en.submitted)).toBeNull()
  view.rerender(<DelegationLauncher {...b.props} useConnectionGeneration={select => select({ id: 2, host: { home: '/new' } })} />)
  await screen.findByRole('option', { name: 'fixture' })
  expect(sendEnabled()).toBe(false)
  expect(b.submit).toHaveBeenCalledExactlyOnceWith(other, 'fixture', 'Review')
})

it('requires a current session and supports the English narrow-sidebar entry', async () => {
  const b = bench()
  b.sessions.current = undefined
  render(<DelegationLauncher {...b.props} wide={false} />)
  click(en.title)
  await screen.findByText(en.noSession)
  expect(screen.getByRole<HTMLInputElement>('checkbox').disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.send }).disabled).toBe(true)
  expect(b.submit).not.toHaveBeenCalled()
})

it('refreshes failed or empty reads without reusing stale provider results', async () => {
  const b = bench()
  const pending = Promise.withResolvers<string[]>()
  b.providers.mockReturnValueOnce(pending.promise)
  render(<DelegationLauncher {...b.props} />)
  click(en.title)
  expect(screen.getByText(en.loading)).toBeTruthy()
  b.providers.mockRejectedValueOnce(new Error('/private/account'))
  click(en.refresh)
  await screen.findByText(en.failed)
  await act(async () => { pending.resolve(['stale']); await pending.promise })
  expect(screen.queryByRole('option', { name: 'stale' })).toBeNull()
  expect(screen.queryByText('/private/account')).toBeNull()
  b.providers.mockResolvedValueOnce([])
  click(en.refresh)
  await screen.findByText(en.empty)
  click(en.refresh)
  await screen.findByRole('option', { name: 'fixture' })
  provider('fixture'); task('Review'); consent(); click(en.refresh)
  await screen.findByRole('option', { name: 'fixture' })
  expect(sendEnabled()).toBe(false)
})

it.each(['reject', 'unconfirmed'] as const)('keeps the draft and warns against retry after %s', async (mode) => {
  const b = bench()
  if (mode === 'reject') b.submit.mockRejectedValueOnce(new Error('/private/path'))
  else b.submit.mockResolvedValueOnce(null)
  render(<DelegationLauncher {...b.props} />)
  await open(); provider('fixture'); task('Review'); consent(); click(en.send)
  await screen.findByText(en.unconfirmed)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Review')
  expect(screen.queryByText('/private/path')).toBeNull()
  expect(b.submit).toHaveBeenCalledOnce()
  expect(sendEnabled()).toBe(false)
})

it.each([true, false])('contains duplicate clicks and late submission after unmount (resolved=%s)', async (resolve) => {
  const b = bench()
  const pending = Promise.withResolvers<DelegationReceipt | null>()
  b.submit.mockReturnValueOnce(pending.promise)
  const view = render(<DelegationLauncher {...b.props} />)
  await open(); provider('fixture'); task('Review'); consent()
  const send = screen.getByRole('button', { name: en.send })
  act(() => { send.click(); send.click() })
  expect(b.submit).toHaveBeenCalledOnce()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: en.sending }).disabled).toBe(true)
  view.unmount()
  await act(async () => {
    if (resolve) pending.resolve({ kind: 'success' })
    else pending.reject(new Error('closed'))
    await pending.promise.catch(() => {})
  })
})

it('ignores a provider read that rejects after closing the panel', async () => {
  const b = bench()
  const pending = Promise.withResolvers<string[]>()
  b.providers.mockReturnValueOnce(pending.promise)
  render(<DelegationLauncher {...b.props} />)
  click(en.title); click(en.close)
  await act(async () => { pending.reject(new Error('closed')); await pending.promise.catch(() => {}) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('shows the actual command refusal and accepts an outcome without text', async () => {
  const b = bench()
  b.submit.mockResolvedValueOnce({ kind: 'error', text: 'Provider unavailable' })
  render(<DelegationLauncher {...b.props} />)
  await open(); provider('fixture'); task('Review'); consent(); click(en.send)
  await screen.findByText('Provider unavailable')
  expect(screen.getByRole('alert').textContent).toContain(en.submitted)
  b.submit.mockResolvedValueOnce({ kind: 'success' })
  consent(); click(en.send)
  await screen.findByRole('status')
  expect(screen.queryByText('Provider unavailable')).toBeNull()
})
