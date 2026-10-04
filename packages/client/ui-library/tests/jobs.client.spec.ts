// @vitest-environment jsdom
/** Background work uses the same scoped controls and question carriers as conversation UI. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { EMPTY_CHAT_SNAPSHOT, isRunningTool, type ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'

import { PendingQuestion } from '../../ui-user-questions/src/client/contract/slots.ts'
import { LibraryJobs, jobActions, type LibraryJob } from '../src/client/jobs.ts'
import { LibraryService } from '../src/client/service.ts'
import { chatActions, conversationStarter, sentence } from '../src/client/chat-actions.ts'
import type { LibraryTarget } from '../src/client/service.ts'
import type { ToolCallBlock, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en } from '../src/client/locales.ts'

const target: LibraryTarget = {
  module: { id: 'eye', displayName: 'عيون', root: '/study/modules/eye', notebooks: [] },
  lecture: { title: 'Orbit 👁️', parts: 5, sources: ['Orbit.mp3'], state: 'pending', inNotebookOnly: false },
}
const roots: Context[] = []
const fibers: { dispose(): Promise<void> }[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const root of roots.splice(0)) await root.fiber.dispose()
  localStorage.clear()
  vi.restoreAllMocks()
})

async function bench(concurrency = 2) {
  const ctx = new Context()
  roots.push(ctx)
  const sessions = new TestSessions(async (task) => { await task() }, ctx)
  ctx.provide('sessions', sessions)
  const library = new LibraryService(ctx, {
    listModules: async () => ({ ok: true, value: { workspace: '/study', modules: [] } }),
    listLectures: async () => ({ ok: true, value: { lectures: [], materials: [] } }),
  })
  await library.loadModules()
  const refresh = vi.spyOn(library, 'loadModule')
  const panels = vi.fn()
  ctx.provide('layout', { selectPanel: panels })
  const pending = createSnapshotStore<SessionPendingInteractionSnapshot>(new Map())
  ctx.provide('uiSession', { pendingInteractions: pending })
  const chats = new Map<string, ReturnType<typeof createSnapshotStore<ChatSnapshot | undefined>>>()
  const binding = vi.fn((owner: SessionBinding) => ({ target: () => chats.get(owner.sessionId) }))
  ctx.provide('uiConversation', { binding })
  const sends = vi.fn(async (_id: string, _text: string) => {})
  const cancels = vi.fn(async (_id: string) => {})
  class Conversation extends Service {
    constructor() { super(ctx, 'conversation') }
    async send(text: string) { await sends(this.ctx.sessions.scopeOf(this.ctx) as string, text) }
    async cancel() { await cancels(this.ctx.sessions.scopeOf(this.ctx) as string) }
  }
  new Conversation()
  let nextSession = 0
  sessions.stubCreate(async () => {
    nextSession += 1
    const id = `session-${nextSession}`
    chats.set(id, createSnapshotStore<ChatSnapshot | undefined>(EMPTY_CHAT_SNAPSHOT))
    await sessions.add({ id }, { current: false })
    return id as SessionId
  })
  let jobs!: LibraryJobs
  const fiber = ctx.plugin({ apply(owner: Context) { jobs = new LibraryJobs(owner, concurrency) } })
  fibers.push(fiber)
  await fiber.await()
  const read = (id: string): LibraryJob => jobs.jobs.getSnapshot().find(job => job.id === id) as LibraryJob
  const running = async (id: string) => {
    await vi.waitFor(() => { expect(read(id).sessionId).toBeDefined() })
    await sessions.updateSessionSnapshot(read(id).sessionId as string, (draft) => { draft.running = true })
  }
  const chat = (id: string, calls: readonly ToolCallBlock[] = [], reason: string | { kind: 'error'; error: { message: string; code: string } } = 'completed') => {
    const sessionId = read(id).sessionId as string
    const snapshot = chats.get(sessionId)!
    const assistant = { kind: 'assistant' as const, seq: 5, time: 5, turn: 1, step: 1, blocks: [{ kind: 'text' as const, text: 'التفريغ جاهز' }] }
    const end = { type: 'turn/end', seq: 6, time: 6, data: { turn: 1, reason: typeof reason === 'string' ? { kind: reason } : reason } }
    snapshot.set({ ...EMPTY_CHAT_SNAPSHOT,
      legacy: { ...EMPTY_CHAT_SNAPSHOT.legacy,
        nodes: [...calls.filter(call => 'kind' in call), assistant],
        runningCalls: calls.filter(isRunningTool),
      },
      timeline: { turnOrder: [1], turns: new Map([[1, { end } as unknown as TurnLocation]]) },
    })
  }
  const idle = async (id: string) => {
    await sessions.updateSessionSnapshot(read(id).sessionId as string, (draft) => { draft.running = false })
  }
  return { ctx, sessions, library, jobs, pending, chats, sends, cancels, panels, refresh, read, running, chat, idle, fiber }
}

function call(tool: string, argsRaw = '{}', successful?: boolean, subCalls: readonly ToolCallBlock[] = []): ToolCallBlock {
  const name = `mcp__transcriber__${tool}`
  return successful === undefined
    ? { name, argsRaw, time: 1, turn: 1, step: 1, callId: tool, subCalls }
    : { kind: 'tool-result', call: { name, argsRaw }, callTime: 1, time: 2, seq: 4, callId: tool, isError: !successful, content: [], subCalls }
}

describe('LibraryJobs admission', () => {
  it('creates hidden transcriber sessions in FIFO order and keeps newest jobs first', async () => {
    const b = await bench()
    const ids = b.jobs.startMany('transcribe', [target, target, target])
    expect(b.jobs.jobs.getSnapshot().map(job => job.id)).toEqual([...ids].reverse())
    expect(b.read(ids[2]!).status).toBe('queued')
    await b.running(ids[0]!)
    await b.running(ids[1]!)
    expect(b.sessions.calls.filter(entry => entry.method === 'create')).toHaveLength(2)
    expect(b.sessions.calls[0]?.args).toEqual([{ cwd: '/study', agentPreset: 'transcriber' }])
    expect(b.sends).toHaveBeenCalledWith('session-1', sentence('transcribe', target))
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()
    expect(b.panels).not.toHaveBeenCalled()
    b.chat(ids[0]!, [call('finalize', '{}', true)])
    await b.idle(ids[0]!)
    await b.running(ids[2]!)
    expect(b.read(ids[0]!).status).toBe('done')
    expect(b.read(ids[0]!).summary).toBe('التفريغ جاهز')
    expect(b.read(ids[0]!).finishedAt).toEqual(expect.any(Number))
    expect(b.read(ids[2]!).sessionId).toBe('session-3')
    b.jobs.open(ids[1]!)
    expect(b.sessions.list.getSnapshot().current).toBe('session-2')
    expect(b.panels).toHaveBeenCalledWith('conversation')
  })

  it('requires lecture titles only for lecture jobs and leaves starting jobs alive before running', async () => {
    const b = await bench(1)
    expect(() => b.jobs.start('transcribe', { module: target.module })).toThrow('requires a lecture')
    expect(() => b.jobs.start('continue', { module: target.module })).toThrow('requires a lecture')
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => { expect(b.sends).toHaveBeenCalledTimes(1) })
    expect(b.read(id)).toMatchObject({ status: 'starting', module: 'eye', moduleName: 'عيون' })
    expect(b.read(id).lecture).toBeUndefined()
    const queued = b.jobs.start('questions', target)
    b.jobs.open(queued)
    await expect(b.jobs.answer(queued, { answers: [] })).rejects.toThrow('no pending question')
    b.jobs.dismiss(queued)
    expect(b.read(queued).status).toBe('queued')
    await b.jobs.cancel(queued)
    expect(b.read(queued).status).toBe('stopped')
    await b.jobs.cancel(queued)
    b.jobs.dismiss(queued)
    expect(b.jobs.jobs.getSnapshot()).toHaveLength(1)
    expect(() => { b.jobs.open('missing') }).toThrow('unknown library job')
    await expect(b.jobs.answer(id, { answers: [] })).rejects.toThrow('no pending question')
  })
})

describe('LibraryJobs progress and outcomes', () => {
  it.each(['transcribe', 'redo', 'continue'] as const)('keeps %s done after finalize when a later model turn fails', async (kind) => {
    const b = await bench()
    const id = b.jobs.start(kind, target)
    await b.running(id)
    const saved = call('finalize', '{}', true)
    b.chat(id, [saved])
    expect(b.read(id).goalReached).toBe(true)
    b.chat(id, [saved, { ...call('list_lectures'), time: 3 }],
      { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider stopped with: PROHIBITED_CONTENT' } })
    await b.idle(id)
    expect(b.read(id)).toMatchObject({ status: 'done', note: 'Provider stopped with: PROHIBITED_CONTENT' })
    expect(b.read(id).error).toBeUndefined()
  })

  it('persists nested source warnings through completion, reload and a later model error', async () => {
    const b = await bench()
    const id = b.jobs.startMany('transcribe', [target])[0]!
    await b.running(id)
    const warning = "Continuing without supporting document 'Lecture/notes.pdf': no usable text"
    const saved = call('finalize', '{}', true)
    if (!('kind' in saved)) throw new Error('expected a settled tool')
    const result = { ...saved, content: [{ type: 'text' as const, text: `[SOURCE-WARNING] ${warning}\n[SOURCE-WARNING] ${warning}\nSaved.` }] }
    b.chat(id, [call('dispatch', '{}', undefined, [result])], {
      kind: 'error', error: { code: 'PI_AI_ERROR', message: 'provider unavailable' },
    })
    await b.idle(id)
    expect(b.read(id)).toMatchObject({ status: 'done', note: `${warning}\nprovider unavailable` })
    await b.fiber.dispose()
    const restored = new LibraryJobs(b.ctx, 1)
    expect(restored.jobs.getSnapshot().find(job => job.id === id)).toMatchObject({ status: 'done', note: `${warning}\nprovider unavailable` })
  })

  it('records a session-level error after successful finalize as a note', async () => {
    const b = await bench()
    const id = b.jobs.start('transcribe', target)
    await b.running(id)
    b.chat(id, [call('finalize', '{}', true)])
    await b.sessions.updateSessionSnapshot(b.read(id).sessionId!, (draft) => { draft.lastAgentError = 'SAFETY' })
    expect(b.read(id)).toMatchObject({ status: 'done', goalReached: true, note: 'SAFETY' })
    expect(b.read(id).error).toBeUndefined()
  })

  it('does not treat a failed finalize as reaching the lecture goal', async () => {
    const b = await bench()
    const id = b.jobs.start('continue', target)
    await b.running(id)
    b.chat(id, [call('finalize', '{}', false)], { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'SAFETY' } })
    await b.idle(id)
    expect(b.read(id)).toMatchObject({ status: 'failed', error: 'SAFETY' })
    expect(b.read(id).note).toBeUndefined()
  })

  it('tracks only transcriber calls, parses draft parts, and refreshes at tool transitions and completion', async () => {
    const b = await bench()
    const id = b.jobs.start('continue', target)
    await b.running(id)
    b.chat(id, [{ ...call('other'), name: 'bash' }])
    expect(b.read(id).step).toBeUndefined()
    b.chat(id, [call('read_draft', '{"part":2,"parts":5}')])
    expect(b.read(id).step).toEqual({ tool: 'read_draft', part: 2, parts: 5 })
    expect(b.refresh).toHaveBeenCalledTimes(1)
    b.chat(id, [call('read_draft', '{"part":3,"parts":5}')])
    expect(b.read(id).step?.part).toBe(3)
    expect(b.refresh).toHaveBeenCalledTimes(1)
    b.chat(id, [call('stage_draft_part', '{"part":4,"parts":5}')])
    expect(b.refresh).toHaveBeenCalledTimes(2)
    b.chat(id, [call('finalize', '{}', false)])
    await b.idle(id)
    expect(b.read(id)).toMatchObject({ status: 'stopped', summary: 'التفريغ جاهز' })
    expect(b.refresh).toHaveBeenCalledTimes(4)
  })

  it.each(['audit', 'questions'] as const)('finishes %s only on a normal recorded turn ending', async (kind) => {
    const b = await bench()
    const [done, stopped] = b.jobs.startMany(kind, [target, target])
    await b.running(done!)
    await b.running(stopped!)
    b.chat(done!)
    b.chat(stopped!, [], 'aborted')
    await b.idle(done!)
    await b.idle(stopped!)
    expect(b.read(done!).status).toBe('done')
    expect(b.read(stopped!).status).toBe('stopped')
  })

  it('does not finish on an idle notification before the conversation terminal publication', async () => {
    const b = await bench()
    const id = b.jobs.start('transcribe', target)
    await b.running(id)
    await b.idle(id)
    expect(b.read(id).finishedAt).toBeUndefined()
    b.chat(id, [call('finalize', '{}', true)])
    expect(b.read(id).status).toBe('done')
  })

  it('surfaces session and startup failures and admits the next queued job', async () => {
    const b = await bench(1)
    b.sends.mockRejectedValueOnce(new Error('send refused'))
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => { expect(b.read(id).status).toBe('failed') })
    expect(b.read(id).error).toBe('send refused')
    const next = b.jobs.start('questions', target)
    await b.running(next)
    await b.sessions.updateSessionSnapshot(b.read(next).sessionId!, (draft) => { draft.lastAgentError = 'provider lost' })
    expect(b.read(next)).toMatchObject({ status: 'failed', error: 'provider lost' })
  })
})

describe('LibraryJobs questions and interruption', () => {
  it('shares the actual question carrier with the composer, including composer-side answers', async () => {
    const b = await bench(1)
    const id = b.jobs.start('audit', target)
    await b.running(id)
    const sessionId = b.read(id).sessionId as SessionId
    const questions = [{ id: 'missing', question: 'فين السلايد؟' }]
    const question = new PendingQuestion(sessionId, questions)
    void question.result.then(() => { b.pending.set(new Map()) })
    b.pending.set(new Map([[sessionId, question]]))
    expect(b.read(id)).toMatchObject({ status: 'waiting', question: { key: question.key, questions } })
    await b.idle(id)
    expect(b.read(id).status).toBe('waiting')
    const queued = b.jobs.start('questions', target)
    expect(b.read(queued).status).toBe('queued')
    await b.running(id)
    const answer = { answers: [{ id: 'missing', selected: [], custom: 'على الجهاز' }] }
    await b.jobs.answer(id, answer)
    expect(await question.result).toEqual(answer)
    expect(b.read(id).status).toBe('running')
    expect(b.read(id).question).toBeUndefined()
    const second = new PendingQuestion(sessionId, questions)
    void second.result.then(() => { b.pending.set(new Map()) })
    b.pending.set(new Map([[sessionId, second]]))
    await second.answer(answer)
    expect(b.read(id).status).toBe('running')
  })

  it('interrupts the session and holds its slot until it stops', async () => {
    const b = await bench(1)
    const id = b.jobs.start('transcribe', target)
    await b.running(id)
    const queued = b.jobs.start('audit', target)
    await b.jobs.cancel(id)
    expect(b.cancels).toHaveBeenCalledWith('session-1')
    expect(b.read(queued).status).toBe('queued')
    await b.idle(id)
    expect(b.read(id).status).toBe('stopped')
    await b.running(queued)
  })

  it('propagates a rejected interruption and still observes eventual success', async () => {
    const b = await bench()
    const id = b.jobs.start('transcribe', target)
    await b.running(id)
    b.cancels.mockRejectedValueOnce(new Error('stop refused'))
    await expect(b.jobs.cancel(id)).rejects.toThrow('stop refused')
    b.chat(id, [call('finalize', '{}', true)])
    await b.idle(id)
    expect(b.read(id).status).toBe('done')
  })
})

describe('LibraryJobs persistence', () => {
  it('reattaches sessions without resending and resumes the queued FIFO after reload', async () => {
    const b = await bench(1)
    const active = b.jobs.start('audit', target)
    await b.running(active)
    const queued = b.jobs.start('questions', target)
    await b.fiber.dispose()
    const restored = new LibraryJobs(b.ctx, 1)
    expect(restored.jobs.getSnapshot().map(job => job.id)).toEqual([queued, active])
    expect(restored.jobs.getSnapshot().find(job => job.id === active)?.status).toBe('running')
    b.chat(active)
    await b.idle(active)
    await vi.waitFor(() => { expect(b.sends).toHaveBeenCalledTimes(2) })
    expect(restored.jobs.getSnapshot().find(job => job.id === active)?.status).toBe('done')
    expect(restored.jobs.getSnapshot().find(job => job.id === queued)?.sessionId).toBe('session-2')
  })

  it('drops invalid persisted records instead of failing to start', async () => {
    const b = await bench()
    await b.fiber.dispose()
    localStorage.setItem('dsh.library.jobs', JSON.stringify([{ id: 'bad', kind: 'arbitrary' }]))
    expect(new LibraryJobs(b.ctx, 1).jobs.getSnapshot()).toEqual([])
  })
})

describe('jobActions and conversation starter', () => {
  it('preserves every action rule and starts background jobs with the action kind', async () => {
    const b = await bench()
    const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof chatActions>[0]
    const actions = jobActions(t, b.jobs)
    const previous = chatActions(t, async () => {})
    const start = vi.spyOn(b.jobs, 'start')
    for (const [index, action] of actions.entries()) {
      const fallback = previous[index]!
      expect({ id: action.id, order: action.order, scope: action.scope, label: action.label() })
        .toEqual({ id: fallback.id, order: fallback.order, scope: fallback.scope, label: fallback.label() })
      for (const candidate of [target, { module: target.module }, { ...target, lecture: { ...target.lecture!, state: 'draft' as const } }]) {
        expect(action.appliesTo(candidate)).toBe(fallback.appliesTo(candidate))
        expect(action.primary?.(candidate)).toBe(fallback.primary?.(candidate))
      }
      await action.run(target)
      expect(start).toHaveBeenLastCalledWith(action.id, target)
    }
  })

  it('keeps explicit assistant conversations visible and sends the sentence of every action', async () => {
    const b = await bench()
    const starter = conversationStarter(b.ctx, () => '/study')
    await starter(undefined)
    expect(b.panels).toHaveBeenCalledWith('conversation')
    expect(b.sends).not.toHaveBeenCalled()
    const t = ((key: keyof typeof en) => en[key]) as Parameters<typeof chatActions>[0]
    for (const action of chatActions(t, starter)) await action.run(target)
    expect(b.sends.mock.calls.map(([, text]) => text)).toEqual([
      'فرّغ محاضرة «Orbit 👁️» من موديول «عيون».',
      'فرّغ محاضرة «Orbit 👁️» من موديول «عيون» تاني من الأول، حتى لو اتفرّغت قبل كده.',
      'كمّل تفريغ محاضرة «Orbit 👁️» من موديول «عيون» من المسودة اللي اتحفظت، لحد ما يخلص.',
      'ابني فهرس الأسئلة لموديول «عيون».',
      'راجع مصادر موديول «عيون» وقولي لو في حاجة ناقصة.',
    ])
    await conversationStarter(b.ctx, () => undefined)('hello')
    expect(b.sessions.calls.at(-2)?.args).toEqual([{ agentPreset: 'transcriber' }])
    expect(sentence('transcribe', { module: target.module })).toContain('«»')
  })
})


describe('LibraryJobs lifecycle races', () => {
  it('cancels a job while session creation is pending without submitting its prompt', async () => {
    const b = await bench(1)
    const gate = Promise.withResolvers<undefined>()
    b.sessions.stubCreate(async () => {
      await gate.promise
      b.chats.set('late', createSnapshotStore(EMPTY_CHAT_SNAPSHOT))
      return b.sessions.add({ id: 'late' }, { current: false })
    })
    const id = b.jobs.start('transcribe', target)
    const cancelling = b.jobs.cancel(id)
    gate.resolve(undefined)
    await cancelling
    expect(b.read(id)).toMatchObject({ status: 'stopped', sessionId: 'late' })
    expect(b.sends).not.toHaveBeenCalled()
    expect(b.cancels).not.toHaveBeenCalled()
  })

  it('persists a late-created session during disposal without starting or losing it', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<undefined>()
    b.sessions.stubCreate(async () => {
      await gate.promise
      return b.sessions.add({ id: 'late' }, { current: false })
    })
    const id = b.jobs.start('audit', target)
    const disposing = b.fiber.dispose()
    gate.resolve(undefined)
    await disposing
    expect(b.read(id).sessionId).toBe('late')
    expect(b.sends).not.toHaveBeenCalled()
    expect(localStorage.getItem('dsh.library.jobs')).toContain('\"sessionId\":\"late\"')
  })

  it.each(['workspace', 'creation', 'binding'] as const)('reports a missing %s before sending', async (failure) => {
    const b = await bench()
    if (failure === 'workspace') {
      const { workspace: _workspace, ...state } = b.library.state.getSnapshot()
      b.library.state.set(state)
    } else if (failure === 'creation') {
      b.sessions.stubCreate(async () => { throw 'creation failed' })
    } else {
      vi.spyOn(b.sessions, 'binding').mockReturnValue(undefined)
    }
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => { expect(b.read(id).status).toBe('failed') })
    expect(b.read(id).error).toBeDefined()
    expect(b.sends).not.toHaveBeenCalled()
  })

  it('treats a removed session as stopped and a recorded turn error as failed', async () => {
    const b = await bench()
    const [removed, error] = b.jobs.startMany('audit', [target, target])
    await b.running(removed!)
    await b.running(error!)
    await b.sessions.updateSessionSnapshot(b.read(removed!).sessionId!, (draft) => { draft.removed = true })
    b.chat(error!, [], { kind: 'error', error: { message: 'model failed', code: 'UNKNOWN' } })
    await b.idle(error!)
    expect(b.read(removed!).status).toBe('stopped')
    expect(b.read(error!)).toMatchObject({ status: 'failed', error: 'model failed', summary: 'التفريغ جاهز' })
  })

  it('waits for a ready session list and reconciles uncreated and missing restored sessions', async () => {
    const b = await bench()
    await b.fiber.dispose()
    const orphan = { id: 'orphan', kind: 'audit', module: 'eye', moduleName: 'عيون', status: 'starting', startedAt: 1 }
    const missing = { ...orphan, id: 'missing', sessionId: 'missing', status: 'running' }
    localStorage.setItem('dsh.library.jobs', JSON.stringify([orphan, missing]))
    b.sessions.list.set({ ...b.sessions.list.getSnapshot(), phase: 'pending' })
    const restored = new LibraryJobs(b.ctx, 1)
    expect(restored.jobs.getSnapshot().map(job => job.status)).toEqual(['starting', 'running'])
    b.sessions.list.set({ ...b.sessions.list.getSnapshot(), phase: 'ready' })
    expect(restored.jobs.getSnapshot().map(job => job.status)).toEqual(['stopped', 'failed'])
    expect(restored.jobs.getSnapshot()[1]?.error).toContain('unavailable')
  })

  it('ignores other pending domains and waits for first-turn admission while idle', async () => {
    const b = await bench()
    const id = b.jobs.start('audit', target)
    await b.running(id)
    const sessionId = b.read(id).sessionId as SessionId
    b.pending.set(new Map([[sessionId, { key: 'approval', kind: 'approval', sessionId }]]) as unknown as SessionPendingInteractionSnapshot)
    expect(b.read(id).status).toBe('running')
    b.chat(id)
    await b.sessions.updateSessionSnapshot(sessionId, (draft) => { draft.running = false; draft.awaitingFirstTurn = true })
    expect(b.read(id).status).toBe('starting')
    await b.sessions.updateSessionSnapshot(sessionId, (draft) => { draft.awaitingFirstTurn = false })
    expect(b.read(id).status).toBe('done')
    b.jobs.dismiss(id)
    expect(b.jobs.jobs.getSnapshot()).toEqual([])
  })
})


describe('LibraryJobs delayed notifications', () => {
  it('keeps restored starting jobs attached and ignores notifications retained past disposal', async () => {
    const b = await bench()
    const id = b.jobs.start('continue', target)
    await vi.waitFor(() => { expect(b.sends).toHaveBeenCalledTimes(1) })
    await b.fiber.dispose()
    const session = b.sessions.behavior(b.read(id).sessionId!)
    let notify = () => {}
    const subscribe = session.subscribe.bind(session)
    vi.spyOn(session, 'subscribe').mockImplementation((listener) => { notify = listener; return subscribe(listener) })
    let restored!: LibraryJobs
    const fiber = b.ctx.plugin({ apply(ctx: Context) { restored = new LibraryJobs(ctx, 1) } })
    fibers.push(fiber)
    await fiber.await()
    expect(restored.jobs.getSnapshot()[0]?.status).toBe('starting')
    await fiber.dispose()
    const before = restored.jobs.getSnapshot()
    notify()
    expect(restored.jobs.getSnapshot()).toBe(before)
    restored.start('audit', target)
    expect(b.sends).toHaveBeenCalledTimes(1)
  })

  it('ignores pending-interaction changes before the session is created and late creation errors after disposal', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<SessionId>()
    b.sessions.stubCreate(() => gate.promise)
    const id = b.jobs.start('audit', target)
    b.pending.set(new Map())
    expect(b.read(id).status).toBe('starting')
    const disposing = b.fiber.dispose()
    gate.reject(new Error('late transport loss'))
    await disposing
    expect(b.read(id).status).toBe('starting')
  })

  it('drops a saved lecture job without its title and keeps one copy of a duplicate', async () => {
    const b = await bench()
    await b.fiber.dispose()
    const incomplete = { id: 'bad', kind: 'transcribe', module: 'eye', moduleName: 'عيون', status: 'stopped', startedAt: 1 }
    localStorage.setItem('dsh.library.jobs', JSON.stringify([incomplete]))
    expect(new LibraryJobs(b.ctx, 1).jobs.getSnapshot()).toEqual([])
    const valid = { ...incomplete, lecture: 'Orbit' }
    const { restoreJobs } = await import('../src/client/jobs.ts')
    expect(restoreJobs([valid, valid]).map(job => job.id)).toEqual(['bad'])
  })
})


describe('LibraryJobs retained-history failures', () => {
  it('reports a restored history-opening failure without resending the prompt', async () => {
    const b = await bench()
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => { expect(b.sends).toHaveBeenCalledTimes(1) })
    await b.fiber.dispose()
    vi.spyOn(b.sessions, 'watch').mockImplementation(() => ({
      ready: Promise.reject(new Error('history unavailable')),
      release: async () => {},
    }))
    const restored = new LibraryJobs(b.ctx, 1)
    await vi.waitFor(() => { expect(restored.jobs.getSnapshot()[0]?.status).toBe('failed') })
    expect(restored.jobs.getSnapshot()[0]).toMatchObject({ id, error: 'history unavailable' })
    expect(b.sends).toHaveBeenCalledTimes(1)
  })

  it('reports a retained-history cleanup failure while preserving the completed outcome', async () => {
    const b = await bench()
    const watch = b.sessions.watch.bind(b.sessions)
    vi.spyOn(b.sessions, 'watch').mockImplementation((id) => {
      const retained = watch(id)
      return { ...retained, release: async () => {
        await retained.release()
        throw new Error('iterator cleanup failed')
      } }
    })
    const logged = vi.spyOn(b.ctx.logger, 'error').mockImplementation(() => {})
    const id = b.jobs.start('audit', target)
    await b.running(id)
    b.chat(id)
    await b.idle(id)
    await vi.waitFor(() => { expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'iterator cleanup failed' })) })
    expect(b.read(id).status).toBe('done')
    expect(b.sessions.behavior(b.read(id).sessionId!).getSnapshot().openState).toBe('cold')
  })
})

describe('isLectureJob', () => {
  it('counts every kind that works on one lecture, redo included', async () => {
    const { isLectureJob } = await import('../src/client/jobs.ts')
    expect(['transcribe', 'redo', 'continue'].every(kind => isLectureJob(kind as never))).toBe(true)
    expect(isLectureJob('audit')).toBe(false)
    expect(isLectureJob('questions')).toBe(false)
  })
})

describe('restoreJobs', () => {
  it('drops stored jobs that no longer validate instead of throwing', async () => {
    const { restoreJobs } = await import('../src/client/jobs.ts')
    const good = { id: 'a', kind: 'audit', module: 'endo', moduleName: 'Endo', status: 'done', startedAt: 1 }
    const lectureless = { id: 'b', kind: 'redo', module: 'endo', moduleName: 'Endo', status: 'stopped', startedAt: 2 }
    expect(restoreJobs([good, lectureless, good, 'junk']).map(job => job.id)).toEqual(['a'])
    expect(restoreJobs({ not: 'a list' })).toEqual([])
  })
})
