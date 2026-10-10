// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import { TaskList } from '../src/client/TaskList.tsx'
import type { TaskRead, TaskCancellation } from '../src/types.ts'
import { en, type DelegationKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(cleanup)
type Props = ComponentProps<typeof TaskList>
function bench(status: SessionJob['status'] = 'running') {
  const sessionId = SessionId('parent')
  const job: SessionJob = { id: JobId('subagent-1'), kind: 'subagent', label: 'Fixture task', status, startedAt: 0 }
  const state = { jobsBySession: { [sessionId]: [job] } } as unknown as SessionListState
  const readJob = vi.fn<Props['readJob']>(async () => ({ kind: 'ready', status: 'completed', text: 'Result <script>literal</script>', truncated: false }))
  const cancelJob = vi.fn<Props['cancelJob']>(async () => 'requested')
  const props: Props = { sessionId, generation: 3, readJob, cancelJob, useSessions: select => select(state),
    t: ((key: DelegationKey) => en[key]) as Props['t'] }
  return { props, job, state, readJob, cancelJob }
}
const click = (name: string) => { fireEvent.click(screen.getByRole('button', { name })) }

it('renders only subagent state and never reads or cancels on mount', () => {
  const b = bench()
  const view = render(<TaskList {...b.props} />)
  expect(screen.getByText(en['job.running'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.readResult })).toBeNull()
  expect(b.readJob).not.toHaveBeenCalled()
  expect(b.cancelJob).not.toHaveBeenCalled()
  b.state.jobsBySession = { [b.props.sessionId]: [{ ...b.job, kind: 'bash' }] }
  view.rerender(<TaskList {...b.props} />)
  expect(screen.getByText(en.noTasks)).toBeTruthy()
  view.rerender(<TaskList {...b.props} sessionId={SessionId('other')} />)
  expect(screen.getByText(en.noTasks)).toBeTruthy()
})

it('requires cancellation review and keeps stopping distinct from final cleanup', async () => {
  const b = bench()
  const view = render(<TaskList {...b.props} />)
  click(en.cancelTask)
  expect(b.cancelJob).not.toHaveBeenCalled()
  click(en.keepTask)
  expect(screen.queryByRole('group')).toBeNull()
  click(en.cancelTask); click(en.confirmCancel)
  await screen.findByText(en['cancel.requested'])
  expect(b.cancelJob).toHaveBeenCalledExactlyOnceWith(b.props.sessionId, b.job.id, 3)
  expect(screen.getByText(en['job.running'])).toBeTruthy()
  b.state.jobsBySession = { [b.props.sessionId]: [{ ...b.job, status: 'stopping' }] }
  view.rerender(<TaskList {...b.props} />)
  expect(screen.getByText(en['job.stopping'])).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.cancelTask })).toBeNull()
  b.state.jobsBySession = { [b.props.sessionId]: [{ ...b.job, status: 'killed' }] }
  view.rerender(<TaskList {...b.props} />)
  expect(screen.getByText(en['job.killed'])).toBeTruthy()
  expect(screen.getByRole('button', { name: en.readResult })).toBeTruthy()
})

it('reads final text explicitly, renders it as text and names truncation and empty output', async () => {
  const b = bench('completed')
  render(<TaskList {...b.props} />)
  click(en.readResult)
  await screen.findByText('Result <script>literal</script>')
  expect(document.querySelector('script')).toBeNull()
  expect(b.readJob).toHaveBeenCalledExactlyOnceWith(b.props.sessionId, b.job.id, 3)
  b.readJob.mockResolvedValueOnce({ kind: 'ready', status: 'completed', text: '', truncated: true })
  click(en.readResult)
  await screen.findByText(en.emptyResult)
  expect(screen.getByText(en.truncatedResult)).toBeTruthy()
})

it.each(['pending', 'unavailable', 'reject'] as const)('reports a %s result without exposing raw transport errors', async (kind) => {
  const b = bench('failed')
  if (kind === 'reject') b.readJob.mockRejectedValueOnce(new Error('/private/output'))
  else b.readJob.mockResolvedValueOnce({ kind })
  render(<TaskList {...b.props} />)
  click(en.readResult)
  await screen.findByText(kind === 'pending' ? en.resultPending : en.resultUnavailable)
  expect(screen.queryByText('/private/output')).toBeNull()
  expect(b.readJob).toHaveBeenCalledOnce()
})

it.each(['already-finished', 'unconfirmed', 'reject'] as const)('reports %s cancellation without automatic retry', async (kind) => {
  const b = bench()
  if (kind === 'reject') b.cancelJob.mockRejectedValueOnce(new Error('/private/cancel'))
  else b.cancelJob.mockResolvedValueOnce(kind)
  render(<TaskList {...b.props} />)
  click(en.cancelTask); click(en.confirmCancel)
  await screen.findByText(kind === 'already-finished' ? en['cancel.already-finished'] : en['cancel.unconfirmed'])
  expect(screen.queryByText('/private/cancel')).toBeNull()
  expect(b.cancelJob).toHaveBeenCalledOnce()
})

it.each(['read', 'cancel'] as const)('prevents duplicate %s and ignores late success after unmount', async (kind) => {
  const b = bench(kind === 'read' ? 'completed' : 'running')
  const pendingRead = Promise.withResolvers<TaskRead>()
  const pendingCancel = Promise.withResolvers<TaskCancellation>()
  b.readJob.mockReturnValueOnce(pendingRead.promise)
  b.cancelJob.mockReturnValueOnce(pendingCancel.promise)
  const view = render(<TaskList {...b.props} />)
  if (kind === 'cancel') click(en.cancelTask)
  const button = screen.getByRole('button', { name: kind === 'read' ? en.readResult : en.confirmCancel })
  act(() => { button.click(); button.click() })
  expect(kind === 'read' ? b.readJob : b.cancelJob).toHaveBeenCalledOnce()
  expect(screen.getByText(en.taskBusy)).toBeTruthy()
  view.unmount()
  await act(async () => {
    pendingRead.resolve({ kind: 'unavailable' })
    pendingCancel.resolve('requested')
  })
})

it('ignores a late failure after the session view is removed', async () => {
  const b = bench('completed')
  const pending = Promise.withResolvers<TaskRead>()
  b.readJob.mockReturnValueOnce(pending.promise)
  const view = render(<TaskList {...b.props} />)
  click(en.readResult)
  view.unmount()
  await act(async () => { pending.reject(new Error('gone')); await pending.promise.catch(() => {}) })
  expect(screen.queryByRole('alert')).toBeNull()
})
