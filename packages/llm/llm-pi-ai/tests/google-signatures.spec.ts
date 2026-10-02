/** Production regression: transferred Gemini function calls must survive same-step fallback. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PiAi from '../src/index.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

interface GoogleRequest {
  model: string
  contents: { role: string; parts: { functionCall?: unknown; thoughtSignature?: string }[] }[]
}
const sdk = { requests: [] as GoogleRequest[], rejectQuota: false }

beforeEach(() => {
  // Keep pi-ai and Google's SDK real; emulate the SDK's external HTTP service.
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : typeof input === 'string' ? input : input.href
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) throw new Error(`unexpected URL ${url}`)
    if (typeof init?.body !== 'string') throw new Error('expected Google SDK JSON')
    const request = { ...JSON.parse(init.body) as Omit<GoogleRequest, 'model'>,
      model: /models\/([^:]+):/.exec(url)?.[1] ?? '' }
    sdk.requests.push(request)
    if (sdk.rejectQuota && request.model === 'gemini-3.8-flash') {
      return new Response(JSON.stringify({ error: { message: 'GenerateRequestsPerDay quota exceeded' } }), { status: 429 })
    }
    for (const content of request.contents) {
      for (const part of content.parts) {
        if (part.functionCall !== undefined && part.thoughtSignature !== 'skip_thought_signature_validator'
          && !(request.model === 'gemini-3.8-flash' && part.thoughtSignature === 'bW9kZWwtQQ==')) {
          return new Response(JSON.stringify({ error: { message:
            'Function call is missing a thought_signature in functionCall parts' } }), { status: 400 })
        }
      }
    }
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: 'continued' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }
    return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  })
})
let context: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  sdk.requests = []
  sdk.rejectQuota = false
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function history(model = 'gemini-3.8-flash', signature: string | undefined = 'bW9kZWwtQQ==', provider = 'google') {
  return [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'use echo' }] }),
    createAssistantMessage({ source: { provider, model, replayState: {
      response: { kind: 'pi-ai', version: 2, api: 'google-generative-ai', provider, model, stopReason: 'toolUse' },
      blocks: [{ type: 'tool-call', ...signature === undefined ? {} : { thoughtSignature: signature } }],
    } }, content: [{ type: 'tool-call', id: ToolCallId('echo-call'), name: 'echo', arguments: '{}' }] }),
    createToolResultMessage({ callId: ToolCallId('echo-call'), isError: false, content: [{ type: 'text', text: 'done' }] })] as const
}

it.each([
  ['gemini-3.7-flash', 'bW9kZWwtQQ==', 'google', 'skip_thought_signature_validator'],
  ['gemini-3.8-flash', 'bW9kZWwtQQ==', 'google', 'bW9kZWwtQQ=='],
  ['gemini-3.8-flash', '', 'google', 'skip_thought_signature_validator'],
  ['gemini-3.8-flash', 'foreign-invalid', 'google', 'skip_thought_signature_validator'],
  ['gemini-3.8-flash', 'bW9kZWwtQQ==', 'other', 'skip_thought_signature_validator'],
])('replays Google calls into %s with signature %s from %s', async (model, signature, provider, expected) => {
  const profiles = resolveProfiles({ google: { models: [{ id: model, reasoningEfforts: false }] } })
  const adapter = new PiAi.PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('key'), auth: memoryAuth() })
  const messages = history('gemini-3.8-flash', signature, provider)
  const before = JSON.stringify(messages)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'google', model, messages: [...messages] })) chunks.push(chunk)
  expect(chunks.at(-1), JSON.stringify(chunks)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(sdk.requests[0]?.contents.flatMap(content => content.parts).find(part => part.functionCall)?.thoughtSignature)
    .toBe(expected)
  expect(JSON.stringify(messages)).toBe(before)
})

async function composition(fallback = true): Promise<Context> {
  vi.stubEnv('GOOGLE_SIGNATURE_KEY', 'key')
  directory = await mkdtemp(join(tmpdir(), 'google-signature-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    '- name: llm', '- name: sessions', '- name: projections', '- name: systemPrompt', '- name: tools', '- name: agents',
    '- name: loop', '  config:', '    agents: []', '- name: pi', '  config:', '    providers:', '      google:',
    '        apiKeyEnv: GOOGLE_SIGNATURE_KEY', `        dailyQuotaFallback: ${String(fallback)}`, '        models:',
    '          - id: gemini-3.8-flash', '            reasoningEfforts: false',
    '          - id: gemini-3.7-flash', '            reasoningEfforts: false', '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
    ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop], ['pi', PiAi],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

it('continues the same Agent step after quota fallback with transferred tool history', async () => {
  sdk.rejectQuota = true
  vi.stubEnv('GOOGLE_SIGNATURE_KEY', 'key')
  const ctx = await composition()
  const agent = await ctx.agentLoop.create(SessionId('signature-fallback'), { provider: 'google', model: 'gemini-3.8-flash' })
  agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'google', model: 'gemini-3.8-flash' }))
  // Durable history emulates the preceding tool step before quota exhaustion.
  const [user, assistant, result] = history()
  agent.session.append('user/message', user, { surfaceOp: 'append' })
  agent.session.append('assistant/message', { turn: 0, step: 0, message: assistant, stream: [] }, { surfaceOp: 'append' })
  agent.session.append('tool/result', { turn: 0, step: 0, message: result }, { surfaceOp: 'append' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
  expect(events.find(event => event.type === 'llm/model-fallback'), JSON.stringify({ events, requests: sdk.requests })).toMatchObject({ data: { to: { model: 'gemini-3.7-flash' } } })
  expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  expect(sdk.requests.map(request => request.model)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash'])
})

it('uses a transferred signature after the user changes models between turns', async () => {
  const ctx = await composition(false)
  let model = 'gemini-3.8-flash'
  const agent = await ctx.agentLoop.create(SessionId('signature-user-selection'), { provider: 'google', model })
  agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'google', model }))
  const [user, assistant, result] = history()
  agent.session.append('user/message', user, { surfaceOp: 'append' })
  agent.session.append('assistant/message', { turn: 0, step: 0, message: assistant, stream: [] }, { surfaceOp: 'append' })
  agent.session.append('tool/result', { turn: 0, step: 0, message: result }, { surfaceOp: 'append' })
  const followup = (): void => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'continue' }] }))
  }
  followup()
  await agent.whenIdle()
  model = 'gemini-3.7-flash'
  agent.session.append('model/selection', { provider: 'google', model })
  followup()
  await agent.whenIdle()
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
  expect(sdk.requests.map(request => request.model)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash'])
  expect(sdk.requests.map(request => request.contents.flatMap(content => content.parts)
    .find(part => part.functionCall)?.thoughtSignature)).toEqual(['bW9kZWwtQQ==', 'skip_thought_signature_validator'])
  expect(agent.session.snapshotEvents().some(event => event.type === 'llm/model-fallback')).toBe(false)
})
