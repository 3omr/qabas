/** Fixture watches expose the same retention and selection rules as the Client controller. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TestSessions } from '../src/sessions.ts'

const benches: { ctx: Context; sessions: TestSessions }[] = []
afterEach(async () => {
  for (const bench of benches.splice(0)) {
    await bench.sessions.disposeScopes()
    await bench.ctx.fiber.dispose()
  }
})
async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (task) => { await task() }, ctx)
  const id = await sessions.add({ id: 'hidden', snapshot: { openState: 'cold' } }, { current: false })
  benches.push({ ctx, sessions })
  return { sessions, id }
}

describe('fixture history watches', () => {
  it('retains a hidden feed until every caller releases it without selecting the Session', async () => {
    const b = await bench()
    const first = b.sessions.watch(b.id)
    const second = b.sessions.watch(b.id)
    await Promise.all([first.ready, second.ready])
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('open')
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()
    await first.release()
    await first.release()
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('open')
    await second.release()
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('cold')
    expect(b.sessions.calls.map(call => call.method)).toEqual(['watch', 'watch', 'releaseWatch', 'releaseWatch'])
    expect(() => b.sessions.watch('missing' as SessionId)).toThrow('not added')
  })

  it('joins reentrant releases from fixture lifecycle subscribers', async () => {
    const b = await bench()
    const watch = b.sessions.watch(b.id)
    await watch.ready
    const session = b.sessions.behavior(b.id)
    let reentrant: Promise<void> | undefined
    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().openState === 'cold') reentrant = watch.release()
    })
    try {
      const closing = watch.release()
      expect(reentrant).toBe(closing)
      await closing
      expect(b.sessions.calls.filter(call => call.method === 'releaseWatch')).toHaveLength(1)
    } finally {
      unsubscribe()
    }
  })

  it('preserves a feed once the Session has been opened in the panel', async () => {
    const b = await bench()
    const watch = b.sessions.watch(b.id)
    await watch.ready
    b.sessions.open(b.id)
    await watch.release()
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('open')
    expect(b.sessions.list.getSnapshot().current).toBe(b.id)
  })

  it('leaves a replacement fixture untouched when a removed fixture releases its watch', async () => {
    const b = await bench()
    const first = b.sessions.watch(b.id)
    await first.ready
    await b.sessions.remove(b.id)
    await b.sessions.add({ id: b.id, snapshot: { openState: 'cold' } }, { current: false })
    const replacement = b.sessions.watch(b.id)
    await replacement.ready
    await first.release()
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('open')
    await replacement.release()
    expect(b.sessions.behavior(b.id).getSnapshot().openState).toBe('cold')
  })
})
