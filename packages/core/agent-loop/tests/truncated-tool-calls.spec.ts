/** Loader-composed recovery from the long Arabic tool-call failure. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function composition(adapter: MockAdapter): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-truncated-call-'))
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['sessions', Sessions], ['projections', Projections],
    ['prompt', SystemPrompt], ['tools', Tools], ['agents', Agents], ['loop', AgentLoop],
  ])
  const path = join(root, 'cordis.yml')
  await writeFile(path, [...modules.keys()].map(name => `- name: ${name}\n`).join(''))
  const context = new Context()
  ctx = context
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  context.loader.internal = {
    version: 'v2',
    async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected Loader module: ${name}`)
      return modules.get(name)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await context.loader.await()
  context.effect(() => context.llm.registerAdapter(['mock'], adapter))
  return context
}

function truncated(id: string, tool = 'stage_draft_part', code = 'TOOL_CALL_TRUNCATED'): StreamChunk[] {
  return [
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name: tool, argumentsDelta: '{"content":"محاضرة' },
    { type: 'finish', reason: { kind: 'error', failure: { code, message: 'Incomplete JSON segment at the end' } } },
  ]
}

it.each(['recovered', 'bounded', 'normal-error', 'reset', 'other-tool'] as const)('handles %s through the Loader-composed agent', async (scenario) => {
  const script: StreamChunk[][] = scenario === 'recovered'
    ? [truncated('first'), toolCallResponse('small', 'stage_draft_part', { content: 'small' }), textResponse('done')]
    : scenario === 'bounded' ? [truncated('first'), truncated('second')]
      : scenario === 'normal-error' ? [truncated('first', 'stage_draft_part', 'PI_AI_ERROR')]
        : scenario === 'reset' ? [truncated('first'), toolCallResponse('small', 'stage_draft_part', { content: 'small' }), truncated('next'), textResponse('done')]
          : [truncated('first'), truncated('second', 'other'), textResponse('done')]
  const requestCount = script.length
  const adapter = new MockAdapter(script)
  const context = await composition(adapter)
  const saved: string[] = []
  context.effect(() => context.tools.register(defineContentToolFixture({
    name: 'stage_draft_part', description: 'stage part', parameters: { content: { type: 'string' } },
    async execute(args) { saved.push(String(args['content'])); return [{ type: 'text', text: 'saved' }] },
  })))
  const agent = await context.agentLoop.create(SessionId('truncation-test'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stage the lecture' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const notices = events.filter(event => event.type === 'llm/tool-call-truncated')
  expect(notices.map(event => event.data)).toEqual(scenario === 'normal-error' ? [] : [
    { turn: 1, step: 1, tool: 'stage_draft_part', chars: 18 },
    ...scenario === 'bounded' || scenario === 'reset' || scenario === 'other-tool'
      ? [{ turn: 1, step: scenario === 'reset' ? 3 : 2, tool: scenario === 'other-tool' ? 'other' : 'stage_draft_part', chars: 18 }] : [],
  ])
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: scenario === 'normal-error'
    ? { kind: 'error', error: { code: 'PI_AI_ERROR' } }
    : scenario === 'bounded' ? { kind: 'error', error: { code: 'TOOL_CALL_TRUNCATED', message: expect.stringContaining('2 consecutive') as unknown } }
      : { kind: 'completed' } } })
  expect(saved).toEqual(scenario === 'recovered' || scenario === 'reset' ? ['small'] : [])
  expect(adapter.requests).toHaveLength(requestCount)
  if (scenario !== 'normal-error') {
    expect(adapter.requests[1]?.messages.at(-1)?.content).toMatchObject([{
      type: 'tool-result', toolCallId: 'first', isError: true,
      content: [{ type: 'text', text: expect.stringContaining('18 characters; re-send it in smaller pieces') as unknown }],
    }])
    expect(events.find(event => event.type === 'assistant/message')).toMatchObject({ data: { message: { content: [{ type: 'tool-call', id: 'first', arguments: '{"content":"محاضرة' }] } } })
  } else {
    expect(events.some(event => event.type === 'assistant/attempt')).toBe(true)
    expect(events.some(event => event.type === 'tool/call')).toBe(false)
  }
})

it.each([1, 2])('recovers an SDK-buffered call with honest unknown metadata, bounded at %i failures', async (failures) => {
  const failure: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TOOL_CALL_TRUNCATED', message: 'Response ended with incomplete JSON before the provider exposed a tool call; resend in smaller pieces.' } } }]
  const adapter = new MockAdapter(failures === 1 ? [failure, textResponse('smaller parts')] : [failure, failure])
  const context = await composition(adapter)
  const agent = await context.agentLoop.create(SessionId('buffered-test'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stage the lecture' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'tool/call')).toEqual([])
  expect(events.filter(event => event.type === 'llm/tool-call-truncated').map(event => event.data)).toEqual(
    Array.from({ length: failures }, (_, index) => ({ turn: 1, step: index + 1, tool: null, chars: null })),
  )
  expect(adapter.requests).toHaveLength(2)
  expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual([{
    type: 'text', text: 'Your response was cut off mid-JSON before a tool call could be read; re-send the call in smaller pieces, splitting content across more parts.',
  }])
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: failures === 1
    ? { kind: 'completed' }
    : { kind: 'error', error: { code: 'TOOL_CALL_TRUNCATED' } } } })
})

it('continues a truncated tool call after an earlier text ceiling in the same turn', async () => {
  const adapter = new MockAdapter([
    () => {
      agent.inbox.splice('next-step', 0, 0, [createUserMessage({ content: [{ type: 'text', text: 'continue with the tool' }], source: { kind: 'user' } })])
      return maxTokensResponse('partial text')
    },
    truncated('partial-call'),
    textResponse('Recovered.'),
  ])
  const context = await composition(adapter)
  const agent: Agent = await context.agentLoop.create(SessionId('earlier-text-ceiling'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stage the lecture' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(3)
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
})
