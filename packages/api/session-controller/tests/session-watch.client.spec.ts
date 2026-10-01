/** Retained background history shares the opened feed and releases its Remote iterator. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ClientSessions } from '../src/client/sessions/service.ts'
import { FakeApiClient, deferred, fakeRemote, ok, err, type RuntimeRemotes } from './fake-api.client.ts'

const id = 'background' as SessionId
const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

async function bench(configure?: (remote: RuntimeRemotes) => RuntimeRemotes) {
  const ctx = new Context()
  roots.push(ctx)
  const api = new FakeApiClient()
  const remote = fakeRemote(api)
  const signals: AbortSignal[] = []
  const sessions = new ClientSessions(ctx, { ...configure?.(remote) ?? remote, session: { ...remote.session,
    follow: (request, signal) => {
      if (signal !== undefined) signals.push(signal)
      return remote.session.follow(request, signal)
    },
  } })
  await sessions.refresh()
  sessions.handleSessionAdded({ sessionId: id, updatedAt: 1, running: false, blank: false })
  await vi.waitFor(() => { expect(sessions.list.getSnapshot().ids).toContain(id) })
  const binding = sessions.binding(id)!
  return { ctx, api, sessions, signals, binding }
}

describe('background Session watches', () => {
  it('shares one hidden feed until its last idempotent release and can watch again', async () => {
    const b = await bench()
    const first = b.sessions.watch(id)
    const second = b.sessions.watch(id)
    await Promise.all([first.ready, second.ready])
    expect(b.api.followStarts).toEqual([id])
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()
    expect(b.binding.session.getSnapshot().openState).toBe('open')
    await first.release()
    await first.release()
    expect(b.signals[0]?.aborted).toBe(false)
    expect(b.binding.session.getSnapshot().openState).toBe('open')
    await second.release()
    expect(b.signals[0]?.aborted).toBe(true)
    expect(b.binding.session.getSnapshot().openState).toBe('cold')
    const again = b.sessions.watch(id)
    await again.ready
    expect(b.api.followStarts).toEqual([id, id])
    await again.release()
  })

  it('joins the same teardown when an abort listener releases the watch reentrantly', async () => {
    const b = await bench()
    const watch = b.sessions.watch(id)
    await watch.ready
    let reentrant: Promise<void> | undefined
    b.signals[0]!.addEventListener('abort', () => { reentrant = watch.release() }, { once: true })
    const closing = watch.release()
    expect(reentrant).toBe(closing)
    await closing
    expect(b.binding.session.getSnapshot().openState).toBe('cold')
  })

  it.each(['before', 'during'] as const)('preserves a feed opened %s the background watch', async (timing) => {
    const b = await bench()
    if (timing === 'before') {
      b.sessions.open(id)
      await vi.waitFor(() => { expect(b.binding.session.getSnapshot().openState).toBe('open') })
    }
    const watch = b.sessions.watch(id)
    await watch.ready
    if (timing === 'during') {
      b.sessions.open(id)
      await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().current).toBe(id) })
    }
    await watch.release()
    expect(b.signals[0]?.aborted).toBe(false)
    expect(b.api.followStarts).toEqual([id])
    b.sessions.clear()
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().current).toBeUndefined() })
    expect(b.binding.session.getSnapshot().openState).toBe('open')
  })

  it('closes a pending opening without letting its late snapshot replace a newer watch', async () => {
    const b = await bench()
    const gate = deferred<Awaited<ReturnType<typeof b.api.onHistory>>>()
    b.api.onHistory = () => gate.promise
    const first = b.sessions.watch(id)
    await vi.waitFor(() => { expect(b.signals).toHaveLength(1) })
    const closing = first.release()
    expect(b.signals[0]?.aborted).toBe(true)
    b.api.onHistory = async () => ok({ records: [], hasMore: false })
    const second = b.sessions.watch(id)
    await second.ready
    gate.resolve(ok({ records: [{ type: 'event', event: {
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1 },
    } }], hasMore: false }))
    await Promise.all([closing, first.ready])
    expect(b.binding.eventSource.getSnapshot().entries).toEqual([])
    expect(b.binding.session.getSnapshot().openState).toBe('open')
    expect(b.signals[1]?.aborted).toBe(false)
    await second.release()
  })

  it('leaves opening business errors observable and permits retry after release', async () => {
    const b = await bench()
    b.api.onHistory = async () => err(new RemoteError('session/not-found', 'missing', { sessionId: id }))
    const failed = b.sessions.watch(id)
    await failed.ready
    expect(b.binding.session.getSnapshot().openError?.message).toBe('missing')
    await failed.release()
    b.api.onHistory = async () => ok({ records: [], hasMore: false })
    const retry = b.sessions.watch(id)
    await retry.ready
    expect(b.binding.session.getSnapshot().openState).toBe('open')
    await retry.release()
  })

  it('rejects opening assembly faults and releases their retention before retry', async () => {
    const b = await bench((remote) => {
      let broken = true
      return { ...remote, $stream: (options) => {
        if (broken) { broken = false; throw new Error('assembly failed') }
        return remote.$stream(options)
      } }
    })
    const failed = b.sessions.watch(id)
    await expect(failed.ready).rejects.toThrow('assembly failed')
    await failed.release()
    expect(b.api.followStarts).toEqual([])
    const retry = b.sessions.watch(id)
    await retry.ready
    await retry.release()
    expect(b.binding.session.getSnapshot().openState).toBe('cold')
  })

  it('disposes retained feeds with their scope and makes late releases harmless', async () => {
    const b = await bench()
    const watch = b.sessions.watch(id)
    await watch.ready
    await b.ctx.fiber.dispose()
    expect(b.signals[0]?.aborted).toBe(true)
    await watch.release()
    await watch.release()
    expect(() => b.sessions.watch('unknown' as SessionId)).toThrow('unknown session')
  })

  it('does not let a removed scope release a replacement scope with the same identity', async () => {
    const b = await bench()
    const old = b.sessions.watch(id)
    await old.ready
    b.sessions.handleSessionRemoved(id)
    await vi.waitFor(() => { expect(b.sessions.binding(id)).toBeUndefined() })
    b.sessions.handleSessionAdded({ sessionId: id, updatedAt: 2, running: false, blank: false })
    await vi.waitFor(() => { expect(b.sessions.list.getSnapshot().ids).toContain(id) })
    const replacement = b.sessions.watch(id)
    await replacement.ready
    await old.release()
    expect(b.signals[1]?.aborted).toBe(false)
    await replacement.release()
    expect(b.signals[1]?.aborted).toBe(true)
  })
})
