// @vitest-environment jsdom
/** Production regression: never-staged jobs must send through real Cordis session scopes. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import * as SessionController from '../../../api/session-controller/src/client/index.ts'
import { FakeApiClient, fakeRemote } from '../../../api/session-controller/tests/fake-api.client.ts'
import TypertRegistry from '../../../typert/registry/src/index.ts'
import * as UiSession from '../../ui-session/src/client/index.ts'
import * as UiConversation from '../../ui-conversation/src/client/index.ts'
import * as UiChat from '../../ui-chat/src/client/index.ts'
import * as UiQuestions from '../../ui-user-questions/src/client/index.ts'
import * as UiLibrary from '../src/client/index.ts'
import { stepLine } from '../src/client/JobsTray.tsx'
import { conversationStarter, sentence } from '../src/client/chat-actions.ts'
import { requireConversation } from '../src/client/conversation.ts'
import type { LibraryTarget } from '../src/client/service.ts'

const target: LibraryTarget = {
  module: { id: 'eye', displayName: 'عيون', root: '/study/modules/eye', notebooks: [] },
  lecture: { title: 'Orbit 👁️', parts: 5, sources: ['Orbit.mp3'], state: 'pending', inNotebookOnly: false },
}
const roots: Context[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose()
  localStorage.clear()
})

type QuestionListener = (
  this: Context,
  request: { questions: readonly AskUserQuestionItem[] },
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

function toolResult(callId: string, text: string): Omit<SessionWireEvent, 'seq' | 'time'> {
  return { type: 'tool/result', surfaceOp: 'append', data: {
    turn: 1, step: 1, message: {
      id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
    },
  } }
}

async function bench() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry).await()
  await ctx.plugin(SlotRegistry).await()
  const api = new FakeApiClient()
  const namespaces = fakeRemote(api)
  const listeners = new Map<string, (...args: never[]) => unknown>()
  ctx.provide('remote', {
    ...namespaces,
    $host: { home: '/study', isLoopback: true },
    $on: (event: string, listener: (...args: never[]) => unknown) => ctx.effect(() => {
      listeners.set(event, listener)
      return () => { listeners.delete(event) }
    }),
    transcriberEngine: {
      listModules: async () => ({ ok: true, value: { workspace: '/study', modules: [] } }),
      listLectures: async () => ({ ok: true, value: { lectures: [], materials: [] } }),
    },
  } as never)
  for (const [name, namespace] of Object.entries(namespaces)) ctx.provide(`remote.${name}`, namespace)
  ctx.provide('remote.transcriberEngine', ctx.remote.transcriberEngine)
  ctx.provide('connection', {
    generation: { getSnapshot: () => ({ id: 1, host: { home: '/study' } }), subscribe: () => () => {} },
  } as never)
  ctx.provide('fileUpload', { available: false } as never)
  const panels: string[] = []
  ctx.provide('layout', { selectPanel: (panel: string) => { panels.push(panel) } } as never)
  ctx.provide('uiWorkspace', { openSession: (id: SessionId) => { ctx.sessions.open(id) } } as never)
  ctx.provide('sidebarRight', {} as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.slots.installLocale(locale)
  await ctx.plugin(SessionController).await()
  await ctx.plugin(UiSession).await()
  const conversationFiber = ctx.plugin(UiConversation)
  await conversationFiber.await()
  await ctx.plugin(UiChat).await()
  await ctx.plugin(UiQuestions).await()
  const libraryFiber = ctx.plugin(UiLibrary, { jobConcurrency: 1, startupPanel: 'conversation' })
  await libraryFiber.await()
  await vi.waitFor(() => {
    expect(ctx.sessions.list.getSnapshot().phase).toBe('ready')
    expect(ctx.library.state.getSnapshot().workspace).toBe('/study')
    expect(ctx.get('conversation')).toBeDefined()
  })
  const jobs = ctx.libraryJobs
  const read = (id: string) => jobs.jobs.getSnapshot().find(job => job.id === id)!
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.(...args as never[])
  let seq = 0
  const append = (sessionId: SessionId, event: Omit<SessionWireEvent, 'seq' | 'time'>) =>
    api.pushFollow(sessionId, { type: 'event', event: { ...event, seq: seq++, time: seq } })
  const ask = (sessionId: SessionId, questions: readonly AskUserQuestionItem[]) => {
    const listener = listeners.get('user-questions/request') as QuestionListener
    return listener.call(ctx.sessions.scope(sessionId)!, { questions }, async () => {
      throw new Error('background question unexpectedly delegated')
    })
  }
  return { ctx, api, jobs, read, panels, emit, append, ask, libraryFiber, conversationFiber }
}

describe('library actions over the real client plugins', () => {
  it('sends, tracks tools, answers ask_user_question, and finishes a never-staged audit session', async () => {
    const b = await bench()
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => {
      expect(b.read(id).error).toBeUndefined()
      expect(b.api.callsOf('session.prompt')).toHaveLength(1)
    })
    expect(b.api.callsOf('session.create')).toEqual([expect.objectContaining({ cwd: '/study', agentPreset: 'transcriber' })])
    expect(b.api.callsOf('session.prompt')[0]).toMatchObject({
      sessionId: b.read(id).sessionId, content: [{ type: 'text', text: sentence('audit', target) }],
    })
    expect(b.ctx.sessions.list.getSnapshot().current).toBeUndefined()
    expect(b.panels).toEqual([])
    const sessionId = b.read(id).sessionId as SessionId
    const binding = b.ctx.sessions.binding(sessionId)!
    expect(binding.session.getSnapshot().openState).toBe('open')
    expect(b.api.activeFollows(sessionId)).toBe(1)
    b.emit('api-session/status', sessionId, true)
    await b.append(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await b.append(sessionId, { type: 'step/start', data: { turn: 1, step: 1 } })
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'begin', name: 'mcp__transcriber__begin_lecture', arguments: '{"module":"eye","lecture":"Orbit"}',
    } })
    await b.append(sessionId, toolResult('begin', JSON.stringify({ uploaded: ['Orbit.mp3'] })))
    await vi.waitFor(() => { expect(b.read(id).step).toEqual({ tool: 'begin_lecture', uploaded: true }) })
    const uploadedProgress = stepLine(b.read(id).step, b.ctx.locale.bind('library'))
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'draft', name: 'mcp__transcriber__read_draft', arguments: '{"part":2,"parts":5}',
    } })
    await vi.waitFor(() => { expect(b.read(id)).toMatchObject({ status: 'running', step: { tool: 'read_draft', part: 2, parts: 5 } }) })
    const progress = b.read(id).step
    await b.append(sessionId, toolResult('draft', 'draft part'))
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'write', name: 'mcp__transcriber__write_parts_with_agy', arguments: '{}',
    } })
    for (const done of [0, 1, 3, 5]) {
      await b.append(sessionId, { type: 'tool/progress', data: {
        rootCallId: 'write', callId: 'write', done, total: 5, message: `part ${Math.min(done + 1, 5)} of 5`,
      } })
      await vi.waitFor(() => { expect(b.read(id).progress).toEqual({ done, total: 5, message: `part ${Math.min(done + 1, 5)} of 5` }) })
    }
    const partProgress = b.read(id).progress
    await b.append(sessionId, toolResult('write', 'staged'))
    await vi.waitFor(() => { expect(b.read(id).progress).toBeUndefined() })
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'question', name: 'ask_user_question', arguments: '{}',
    } })
    const questions = [{ id: 'missing', question: 'فين السلايد؟' }]
    const answering = b.ask(sessionId, questions)
    await vi.waitFor(() => { expect(b.read(id)).toMatchObject({ status: 'waiting', question: { questions } }) })
    const pending = b.ctx.uiSession.pendingInteractions.getSnapshot().get(sessionId)!
    expect(b.read(id).question?.key).toBe(pending.key)
    const answer = { answers: [{ id: 'missing', selected: [], custom: 'على الجهاز' }] }
    await b.jobs.answer(id, answer)
    await expect(answering).resolves.toEqual(answer)
    expect(b.read(id).question).toBeUndefined()
    expect(b.read(id).status).toBe('running')
    await b.append(sessionId, toolResult('question', JSON.stringify(answer)))
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'finalize', name: 'mcp__transcriber__finalize', arguments: '{}',
    } })
    await b.append(sessionId, toolResult('finalize', '[SOURCE-WARNING] Continuing without supporting document notes.pdf: no usable text\nsaved'))
    await b.append(sessionId, { type: 'step/end', data: { turn: 1, step: 1 } })
    await b.append(sessionId, { type: 'step/start', data: { turn: 1, step: 2 } })
    await b.append(sessionId, { type: 'assistant/message', surfaceOp: 'append', data: {
      turn: 1, step: 2, stream: [], message: {
        id: 'answer', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' },
        content: [{ type: 'text', text: 'التفريغ جاهز' }],
      },
    } })
    await b.append(sessionId, { type: 'step/end', data: { turn: 1, step: 2 } })
    await b.append(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    b.emit('api-session/status', sessionId, false)
    await vi.waitFor(() => {
      expect(b.read(id)).toMatchObject({ status: 'done', step: { tool: 'finalize' }, summary: 'التفريغ جاهز' })
      expect(b.api.activeFollows(sessionId)).toBe(0)
      expect(binding.session.getSnapshot().openState).toBe('cold')
    })
    expect(b.ctx.sessions.list.getSnapshot().current).toBeUndefined()
    expect(b.panels).toEqual([])
    expect({
      request: sentence('audit', target), uploadedProgress, progress, partProgress, questions,
      status: b.read(id).status, step: b.read(id).step, summary: b.read(id).summary, note: b.read(id).note,
    }).toMatchSnapshot()
  })


  it('projects nested writer progress and preserves finalize success through a blocked closing turn', async () => {
    const b = await bench()
    const id = b.jobs.start('redo', target)
    await vi.waitFor(() => { expect(b.api.callsOf('session.prompt')).toHaveLength(1) })
    const sessionId = b.read(id).sessionId as SessionId
    b.emit('api-session/status', sessionId, true)
    await b.append(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await b.append(sessionId, { type: 'step/start', data: { turn: 1, step: 1 } })
    await b.append(sessionId, { type: 'tool/call', data: {
      turn: 1, step: 1, callId: 'code', name: 'run_code', arguments: '{}',
    } })
    await b.append(sessionId, { type: 'tool/ptc-dispatch-start', data: {
      rootCallId: 'code', parentCallId: 'code', subCallId: 'write', name: 'mcp__transcriber__write_parts_with_agy', arguments: {},
    } })
    await b.append(sessionId, { type: 'tool/progress', data: {
      rootCallId: 'code', callId: 'write', done: 3, total: 5, message: 'part 4 of 5',
    } })
    await vi.waitFor(() => { expect(b.read(id)).toMatchObject({ step: { tool: 'write_parts_with_agy' },
      progress: { done: 3, total: 5, message: 'part 4 of 5' } }) })
    await b.append(sessionId, { type: 'tool/ptc-dispatch', data: {
      rootCallId: 'code', parentCallId: 'code', subCallId: 'write', name: 'mcp__transcriber__write_parts_with_agy', arguments: {},
      isError: false, content: [{ type: 'text', text: 'staged' }],
    } })
    await vi.waitFor(() => { expect(b.read(id).progress).toBeUndefined() })
    await b.append(sessionId, { type: 'tool/ptc-dispatch-start', data: {
      rootCallId: 'code', parentCallId: 'code', subCallId: 'final', name: 'mcp__transcriber__finalize', arguments: {},
    } })
    await b.append(sessionId, { type: 'tool/ptc-dispatch', data: {
      rootCallId: 'code', parentCallId: 'code', subCallId: 'final', name: 'mcp__transcriber__finalize', arguments: {},
      isError: false, content: [{ type: 'text', text: 'Finalized reviewed transcript. Updated index.' }],
    } })
    await vi.waitFor(() => { expect(b.read(id).goalReached).toBe(true) })
    await b.append(sessionId, toolResult('code', 'saved'))
    await b.append(sessionId, { type: 'step/end', data: { turn: 1, step: 1 } })
    await b.append(sessionId, { type: 'turn/end', data: { turn: 1,
      reason: { kind: 'error', error: { code: 'PI_AI_ERROR', message: 'Provider stopped with: PROHIBITED_CONTENT' } },
    } })
    b.emit('api-session/status', sessionId, false)
    await vi.waitFor(() => { expect(b.read(id)).toMatchObject({ status: 'done', note: 'Provider stopped with: PROHIBITED_CONTENT' }) })
    expect(b.read(id).error).toBeUndefined()
    expect(JSON.parse(localStorage.getItem('dsh.library.jobs') ?? '[]')).toMatchObject([
      { status: 'done', goalReached: true, note: 'Provider stopped with: PROHIBITED_CONTENT' },
    ])
  })

  it('cancels a running background session through its scoped Conversation provider', async () => {
    const b = await bench()
    const id = b.jobs.start('audit', target)
    await vi.waitFor(() => { expect(b.api.callsOf('session.prompt')).toHaveLength(1) })
    const sessionId = b.read(id).sessionId as SessionId
    b.emit('api-session/status', sessionId, true)
    await b.append(sessionId, { type: 'turn/start', data: { turn: 1 } })
    await vi.waitFor(() => { expect(b.read(id).status).toBe('running') })
    await b.jobs.cancel(id)
    expect(b.api.callsOf('session.cancel')).toEqual([{ sessionId }])
    expect(b.read(id).status).toBe('running')
    await b.append(sessionId, { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
    b.emit('api-session/status', sessionId, false)
    await vi.waitFor(() => {
      expect(b.read(id).status).toBe('stopped')
      expect(b.api.activeFollows(sessionId)).toBe(0)
    })
    expect(b.ctx.sessions.list.getSnapshot().current).toBeUndefined()
  })

  it('completes a lecture through the pipeline Remote without a Session in the mounted library', async () => {
    const b = await bench()
    const ready = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    Object.assign(b.ctx.remote.transcriberEngine, {
      runLecturePipeline: async function* () {
        yield { type: 'progress', step: 'write_parts_with_agy', done: 1, total: 3, message: 'write_parts_with_agy: part 2 of 3' }
        ready.resolve(undefined)
        await finish.promise
        yield { type: 'outcome', outcome: { status: 'finalized',
          paths: { transcript: '/study/Orbit.md', index: '/study/Index.md' }, summary: 'ready', note: '1 question that could not be validated was left out'  } }
      },
    })
    const id = b.jobs.start('transcribe', target)
    try {
      await ready.promise
      expect(b.read(id)).toMatchObject({ status: 'running', progress: { done: 1, total: 3 } })
      finish.resolve(undefined)
      await vi.waitFor(() => { expect(b.read(id)).toMatchObject({ status: 'done', goalReached: true, note: '1 question that could not be validated was left out' }) })
      const job = b.read(id)
      expect({ status: job.status, goalReached: job.goalReached, note: job.note, error: job.error, summary: job.summary }).toMatchSnapshot()
      expect(b.api.callsOf('session.create')).toEqual([])
      expect(b.api.callsOf('session.prompt')).toEqual([])
    } finally { finish.resolve(undefined) }
  })

  it('submits an explicit assistant conversation from the library plugin context', async () => {
    const b = await bench()
    await conversationStarter(b.libraryFiber.ctx, () => '/study')('hello')
    expect(b.api.callsOf('session.prompt')[0]).toMatchObject({ content: [{ type: 'text', text: 'hello' }] })
    expect(b.ctx.sessions.list.getSnapshot().current).toBe('fk-new')
    expect(b.panels).toEqual(['conversation'])
  })

  it('reports unavailable scopes and Conversation providers instead of skipping a request', async () => {
    const b = await bench()
    expect(() => requireConversation(b.ctx, 'missing' as SessionId)).toThrow('resolved no scope')
    const sessionId = await b.ctx.sessions.create({ cwd: '/study', agentPreset: 'transcriber' })
    await b.conversationFiber.dispose()
    expect(() => requireConversation(b.ctx, sessionId)).toThrow('conversation service unavailable')
    expect(b.api.callsOf('session.prompt')).toEqual([])
  })
})
