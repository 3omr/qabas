// @vitest-environment jsdom
/** Hidden jobs consume real Client Session feeds and Chat definitions over a programmable Remote. */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { ClientSessions } from '../../../api/session-controller/src/client/sessions/service.ts'
import { FakeApiClient, fakeRemote, ok, deferred } from '../../../api/session-controller/tests/fake-api.client.ts'
import { registerConversationNodes } from '../../ui-chat/src/client/conversation-nodes/register.ts'
import { PendingQuestion } from '../../ui-user-questions/src/client/contract/slots.ts'
import { LibraryJobs } from '../src/client/jobs.ts'
import { LibraryService } from '../src/client/service.ts'
import type { LibraryTarget } from '../src/client/service.ts'

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  localStorage.clear()
})
const target: LibraryTarget = {
  module: { id: 'eye', displayName: 'عيون', root: '/study/modules/eye', notebooks: [] },
  lecture: { title: 'Orbit 👁️', parts: 5, sources: ['Orbit.mp3'], state: 'pending', inNotebookOnly: false },
}

async function bench(api = new FakeApiClient()) {
  const ctx = new Context()
  roots.push(ctx)
  const remote = fakeRemote(api)
  const signals: AbortSignal[] = []
  const sessions = new ClientSessions(ctx, { ...remote, session: { ...remote.session,
    follow: (request, signal) => {
      if (signal !== undefined) signals.push(signal)
      return remote.session.follow(request, signal)
    },
  } })
  await sessions.refresh()
  new UiConversation(ctx, sessions)
  registerConversationNodes(ctx)
  const pending = createSnapshotStore<SessionPendingInteractionSnapshot>(new Map())
  ctx.provide('uiSession', { pendingInteractions: pending })
  const panels = vi.fn()
  ctx.provide('layout', { selectPanel: panels })
  const library = new LibraryService(ctx, {
    listModules: async () => ({ ok: true, value: { workspace: '/study', modules: [] } }),
    listLectures: async () => ({ ok: true, value: { lectures: [], materials: [] } }),
  })
  await library.loadModules()
  class Conversation extends Service {
    constructor() { super(ctx, 'conversation') }
    async send(text: string): Promise<void> {
      const session = this.ctx.sessions.sessionOf(this.ctx)!
      const accepted = await session.prompt([{ type: 'text', text }], 'queue')
      if (!accepted.ok) throw new Error(accepted.error.message)
    }
    async cancel(): Promise<void> {
      const accepted = await this.ctx.sessions.sessionOf(this.ctx)!.cancel()
      if (!accepted.ok) throw new Error(accepted.error.message)
    }
  }
  new Conversation()
  let next = api.calls.filter(call => call.method === 'session.create').length
  api.onCreate = async () => ok({ sessionId: `hidden-${++next}` as SessionId })
  let jobs!: LibraryJobs
  const fiber = ctx.plugin({ apply(owner: Context) { jobs = new LibraryJobs(owner, 1) } })
  await fiber.await()
  const read = (id: string) => jobs.jobs.getSnapshot().find(job => job.id === id)!
  const sequences = new Map<SessionId, number>()
  const history = new Map<SessionId, SessionWireEvent[]>()
  const push = async (id: string, type: string, data: SessionWireEvent['data'], surfaceOp?: 'append') => {
    const sessionId = read(id).sessionId as SessionId
    const seq = sequences.get(sessionId) ?? 0
    sequences.set(sessionId, seq + 1)
    const event: SessionWireEvent = { type, seq, time: seq + 1, data, ...surfaceOp === undefined ? {} : { surfaceOp } }
    const records = history.get(sessionId) ?? []
    records.push(event)
    history.set(sessionId, records)
    await api.pushFollow(sessionId, { type: 'event', event })
  }
  const startTurn = async (id: string) => {
    await vi.waitFor(() => { expect(read(id).sessionId).toBeDefined() })
    await vi.waitFor(() => { expect(sessions.binding(read(id).sessionId as SessionId)?.session.getSnapshot().openState).toBe('open') })
    sessions.handleSessionStatus(read(id).sessionId as SessionId, true)
    await push(id, 'turn/start', { turn: 1 })
    await push(id, 'step/start', { turn: 1, step: 1 })
    await vi.waitFor(() => { expect(read(id).status).toBe('running') })
  }
  const finish = async (id: string, text: string) => {
    const time = (sequences.get(read(id).sessionId as SessionId) ?? 0) + 1
    await push(id, 'assistant/message', {
      turn: 1, step: 1, message: {
        id: `assistant-${id}`, role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'text', text }],
      }, stream: [{ type: 'text-chunks', time0: time, index: 0, dt: [], texts: [text] }],
    }, 'append')
    await push(id, 'step/end', { turn: 1, step: 1 })
    sessions.handleSessionStatus(read(id).sessionId as SessionId, false)
    await push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(read(id).status).toBe('done') })
  }
  return { ctx, api, sessions, signals, jobs, fiber, read, push, startTurn, finish, pending, panels, history }
}

describe('never-opened library jobs', () => {
  it('observes tool progress, shares questions, finishes, releases history, and starts queued work', async () => {
    const b = await bench()
    const first = b.jobs.start('transcribe', target)
    const second = b.jobs.start('audit', target)
    expect(b.read(second).status).toBe('queued')
    await b.startTurn(first)
    await b.push(first, 'tool/call', {
      turn: 1, step: 1, callId: 'read', name: 'mcp__transcriber__read_draft', arguments: '{"part":2,"parts":5}',
    })
    await vi.waitFor(() => { expect(b.read(first).step).toEqual({ tool: 'read_draft', part: 2, parts: 5 }) })
    const sessionId = b.read(first).sessionId as SessionId
    const question = new PendingQuestion(sessionId, [{ id: 'slides', question: 'فين السلايد؟' }])
    b.ctx.effect(() => () => { question.abort(new Error('fixture disposed')) }, 'fixture question')
    void question.result.then(() => { b.pending.set(new Map()) }, () => { b.pending.set(new Map()) })
    b.pending.set(new Map([[sessionId, question]]))
    expect(b.read(first).status).toBe('waiting')
    expect(b.read(second).status).toBe('queued')
    const answer = { answers: [{ id: 'slides', selected: [], custom: 'على الجهاز' }] }
    await b.jobs.answer(first, answer)
    expect(await question.result).toEqual(answer)
    expect(b.read(first).question).toBeUndefined()
    await b.push(first, 'tool/call', { turn: 1, step: 1, callId: 'finalize', name: 'mcp__transcriber__finalize', arguments: '{}' })
    await b.push(first, 'tool/result', { turn: 1, step: 1, message: {
      id: 'finalized', role: 'user', source: { kind: 'tool', callId: 'finalize' }, content: [{
        type: 'tool-result', toolCallId: 'finalize', content: [{ type: 'text', text: 'saved' }], isError: false,
      }],
    } }, 'append')
    await b.finish(first, 'التفريغ جاهز')
    expect(b.read(first).summary).toBe('التفريغ جاهز')
    expect(b.signals[0]?.aborted).toBe(true)
    await b.startTurn(second)
    await b.finish(second, 'المصادر كاملة')
    expect(b.read(second).summary).toBe('المصادر كاملة')
    expect(b.signals[1]?.aborted).toBe(true)
    expect(b.api.followStarts).toEqual(['hidden-1', 'hidden-2'])
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()
    expect(b.panels).not.toHaveBeenCalled()
    b.jobs.dismiss(first)
    expect(b.jobs.jobs.getSnapshot().map(job => job.id)).toEqual([second])
  })

  it('reattaches a persisted job through a cold controller without selecting or resending it', async () => {
    const b = await bench()
    const id = b.jobs.start('audit', target)
    await b.startTurn(id)
    const sessionId = b.read(id).sessionId as SessionId
    await b.ctx.fiber.dispose()
    await b.push(id, 'assistant/message', { turn: 1, step: 1, message: {
      id: 'completed-offline', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: 'المصادر كاملة' }],
    }, stream: [{ type: 'text-chunks', time0: 3, index: 0, dt: [], texts: ['المصادر كاملة'] }] }, 'append')
    await b.push(id, 'step/end', { turn: 1, step: 1 })
    await b.push(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    b.api.onList = async () => ok({ items: [{ sessionId, updatedAt: 1, running: false, blank: false }] }) as never
    b.api.onHistory = async ({ sessionId: requested }) => ok({
      records: (b.history.get(requested) ?? []).map(event => ({ type: 'event' as const, event })), hasMore: false,
    })
    const reloaded = await bench(b.api)
    await vi.waitFor(() => { expect(reloaded.jobs.jobs.getSnapshot()[0]?.status).toBe('done') })
    expect(reloaded.jobs.jobs.getSnapshot()[0]).toMatchObject({ id, sessionId, summary: 'المصادر كاملة' })
    expect(reloaded.api.calls.filter(call => call.method === 'session.prompt')).toHaveLength(1)
    expect(reloaded.sessions.list.getSnapshot().current).toBeUndefined()
    expect(reloaded.panels).not.toHaveBeenCalled()
    expect(reloaded.signals[0]?.aborted).toBe(true)
  })

  it('releases a watch on disposal during its first opening without sending the prompt', async () => {
    const b = await bench()
    const opening = deferred<Awaited<ReturnType<typeof b.api.onHistory>>>()
    b.api.onHistory = () => opening.promise
    b.jobs.start('transcribe', target)
    await vi.waitFor(() => { expect(b.signals).toHaveLength(1) })
    const disposing = b.fiber.dispose()
    await vi.waitFor(() => { expect(b.signals[0]?.aborted).toBe(true) })
    opening.resolve(ok({ records: [], hasMore: false }))
    await disposing
    expect(b.api.calls.filter(call => call.method === 'session.prompt')).toEqual([])
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()
  })
})
