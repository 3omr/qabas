/** Keyless provider recovery through real Agent steps and pi-ai HTTP responses. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PiAi from '../src/index.ts'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { fallbackModels, RecoveryMemory } from '../src/recovery-memory.ts'
import { PiAiAdapter } from '../src/adapter.ts'
import { memoryAuth } from './auth-double.ts'
import { resolveProfiles } from '../src/config.ts'
import { textEvents } from './mock-server.ts'

const quota = { status: 429, body: JSON.stringify({ error: { message: 'GenerateRequestsPerDay quota exceeded' } }) }
const unsupported = { status: 400, body: JSON.stringify({ error: { message: 'Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.' } }) }
let context: Context | undefined
let directory: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Mock the external HTTP transport while Loader, SDK, and Agent remain real. */
function scriptedProvider(script: { status?: number; body?: string; events?: string[] }[]) {
  const requests: unknown[] = []
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('expected serialized provider JSON')
    requests.push(JSON.parse(init.body) as unknown)
    const response = script.shift()
    if (response === undefined) throw new Error('provider response script exhausted')
    const body = response.events === undefined ? response.body
      : response.events.map(event => `data: ${event}\n\n`).join('')
    return new Response(body, { status: response.status ?? 200, headers: {
      'content-type': response.events === undefined ? 'application/json' : 'text/event-stream',
    } })
  })
  return { url: 'https://recovery.test/v1', requests }
}

async function composition(baseURL: string, provider = 'google', modelIds = ['gemini-3.8-flash', 'gemini-3.7-flash'], options: { enabled?: boolean | undefined; efforts?: string[]; storage?: boolean; pi?: typeof PiAi } = {}): Promise<Context> {
  vi.stubEnv('PI_RECOVERY_KEY', 'key')
  directory ??= await mkdtemp(join(tmpdir(), 'pi-recovery-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    ...options.storage ? ['- name: storage', '- name: storageJson', '  config:', `    root: ${JSON.stringify(join(directory, 'state'))}`,
      '- name: storageDomain', '  config:', '    backend: json'] : [],
    '- name: llm', '- name: sessions', '- name: projections', '- name: systemPrompt', '- name: tools', '- name: agents',
    '- name: loop', '  config:', '    agents: []',
    '- name: pi', '  config:', '    providers:', `      ${provider}:`,
    '        apiKeyEnv: PI_RECOVERY_KEY', '        api: openai-completions',
    `        baseURL: ${baseURL}`,
    ...options.enabled === undefined ? [] : [`        dailyQuotaFallback: ${String(options.enabled)}`, '        dailyQuotaResetTimeZone: UTC'], '        models:',
    ...modelIds.flatMap(id => [`          - id: ${id}`, `            name: ${id}`, '            reasoningEfforts:',
      '              off:', ...(options.efforts ?? ['minimal', 'low', 'medium']).map(level => `              ${level}: ${level}`)]), '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['storage', Storage], ['storageJson', StorageJson], ['storageDomain', StorageDomain],
    ['llm', LlmRuntime], ['sessions', SessionStore], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime],
    ['agents', AgentRegistry], ['loop', AgentLoop], ['pi', options.pi ?? PiAi], ['projections', SessionProjectionRegistry],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined(); expect(ctx.get('llm')?.listProviders()).toHaveLength(1) })
  return ctx
}

async function turn(ctx: Context, id: string, provider: string, model: string, pinned: boolean | 'selection' = false, effort?: string) {
  const loop = ctx.get('agentLoop')
  if (loop === undefined) throw new Error('Loader did not register agentLoop')
  const agent = await loop.create(SessionId(id), pinned === true ? { provider, model, allowModelFallback: false } : { provider, model })
  if (pinned === 'selection') installModelSelection(agent.ctx, {
    current: { provider, model }, assembled: undefined, allowFallback: false,
  })
  if (!pinned) agent.ctx.on('agent/request', async (_payload, next) => ({
    ...await next(), provider, model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue lecture' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return agent.session.snapshotEvents()
}

describe('daily model recovery', () => {
  it('filters specialized ids and names, preserving catalog ties for newest main versions', () => {
    const ids = ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-4-preview', 'gemini-4-lite',
      'gemini-4-image', 'gemini-4-live', 'gemini-4-tts', 'gemini-4-embedding', 'gemini-4-computer-use',
      'gemini-4-deep-research', 'gemini-4-customtools', 'gemma-9', 'gemini-4-audio', 'gemini-4-banana']
    expect(fallbackModels([...ids.map(id => ({ provider: 'google', id, name: id })),
      { provider: 'google', id: 'gemini-5', name: 'Preview' }]).map(model => model.id))
      .toEqual(['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-2.5-flash'])
  })

  it.each([
    ['2026-10-02T06:59:59Z', '2026-10-02T07:00:00Z'],
    ['2026-12-02T07:59:59Z', '2026-12-02T08:00:00Z'],
  ])('expires observations at Pacific midnight across summer and winter (%s)', (before, after) => {
    const memory = new RecoveryMemory()
    memory.exhaust('google', 'flash', 'America/Los_Angeles', Date.parse(before))
    expect(memory.isExhausted('google', 'flash', 'America/Los_Angeles', Date.parse(before))).toBe(true)
    expect(memory.isExhausted('google', 'pro', 'America/Los_Angeles', Date.parse(before))).toBe(false)
    expect(memory.isExhausted('other', 'flash', 'America/Los_Angeles', Date.parse(before))).toBe(false)
    expect(memory.isExhausted('google', 'flash', 'America/Los_Angeles', Date.parse(after))).toBe(false)
  })

  it('retries the same step and skips exhausted models in another session', async () => {
    const models = ['gemini-71.8-flash', 'gemini-71.7-flash', 'gemini-99-preview']
    const server = scriptedProvider([quota, { events: textEvents }, { events: textEvents }])
    const ctx = await composition(server.url, 'google', models)
    const events = await turn(ctx, 'recover-one', 'google', models[0]!)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/model-fallback').map(event => event.data)).toEqual([{
      turn: 1, step: 1, from: { provider: 'google', model: models[0], name: models[0] },
      to: { provider: 'google', model: models[1], name: models[1] }, reason: 'DAILY_QUOTA_EXHAUSTED',
    }])
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    const second = await turn(ctx, 'recover-two', 'google', models[0]!)
    expect(second.filter(event => event.type === 'request/header').at(-1)).toMatchObject({ data: { header: { config: { model: models[1] } } } })
    expect(server.requests.map(request => (request as { model: string }).model)).toEqual([models[0], models[1], models[1]])
  })

  it.each([
    [404, 'This model models/gemini-81.7-flash is no longer available to new users.'],
    [404, 'Model not found'],
    [400, 'Model is no longer available'],
  ])('continues past unavailable models (%s %s) and never selects them again', async (status, message) => {
    const models = [`gemini-81.8-flash-${status}-${message.length}`, `gemini-81.7-flash-${status}-${message.length}`,
      `gemini-81.6-flash-${status}-${message.length}`]
    const server = scriptedProvider([quota, { status, body: JSON.stringify({ error: { message } }) },
      { events: textEvents }, { events: textEvents }])
    const ctx = await composition(server.url, 'google', models)
    const events = await turn(ctx, 'unavailable', 'google', models[0]!)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'llm/model-fallback').map(event => event.data.reason))
      .toEqual(['DAILY_QUOTA_EXHAUSTED', 'MODEL_UNAVAILABLE'])
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    await turn(ctx, 'unavailable-again', 'google', models[1]!)
    expect(server.requests.map(request => (request as { model: string }).model))
      .toEqual([models[0], models[1], models[2], models[2]])
  })

  it('rejects a known unavailable pinned model before dispatching another request', async () => {
    const model = 'gemini-83.8-flash'
    const server = scriptedProvider([{ status: 404, body: 'Model not found' }])
    const ctx = await composition(server.url, 'google', [model], { enabled: false })
    await turn(ctx, 'learn-retired', 'google', model, true)
    const events = await turn(ctx, 'pin-retired', 'google', model, true)
    expect(events.at(-1)).toMatchObject({ data: { reason: { error: { code: 'MODEL_UNAVAILABLE' } } } })
    expect(server.requests).toHaveLength(1)
  })

  it.each([false, true])('loads persisted exclusions after restart and honors the quota reset (reset=%s)', async (reset) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T06:59:59Z'))
    const models = [`gemini-82.8-flash-${reset}`, `gemini-82.7-flash-${reset}`, `gemini-82.6-flash-${reset}`]
    const server = scriptedProvider([quota, { status: 404, body: 'Model not found' },
      { events: textEvents }, { events: textEvents }])
    const first = await composition(server.url, 'google', models, { storage: true })
    await turn(first, 'before-restart', 'google', models[0]!)
    const stored = JSON.parse(await readFile(join(directory!, 'state', 'llm_pi_ai_recovery.json'), 'utf8')) as unknown
    expect(JSON.stringify(stored)).toContain('2026-10-02')
    expect(JSON.stringify(stored)).toContain('unavailable')
    await first.fiber.dispose()
    context = undefined
    // Reload the adapter modules to discard their process singleton, as a new server does.
    vi.resetModules()
    const restartedPi = await import('../src/index.ts')
    const { recoveryMemory: restartedMemory } = await import('../src/recovery-memory.ts')
    expect(restartedMemory.observation('google', models[0]!)).toBeUndefined()
    if (reset) clock.mockReturnValue(Date.parse('2026-10-02T07:00:00Z'))
    const second = await composition(server.url, 'google', models, { storage: true, pi: restartedPi })
    const events = await turn(second, 'after-restart', 'google', models[0]!)
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(server.requests.map(request => (request as { model: string }).model))
      .toEqual([models[0], models[1], models[2], reset ? models[0] : models[2]])
    expect(restartedMemory.observation('google', models[1]!)?.kind).toBe('unavailable')
  })

  it('lists every exhausted eligible model when no writing model remains', async () => {
    const models = ['gemini-72.8-flash', 'gemini-72.7-flash']
    const server = scriptedProvider([quota, quota])
    const ctx = await composition(server.url, 'google', models)
    const events = await turn(ctx, 'all-exhausted', 'google', models[0]!)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: {
      kind: 'error', error: { code: 'DAILY_QUOTA_EXHAUSTED' },
    } } })
    expect(JSON.stringify(events.at(-1))).toContain(models[0])
    expect(JSON.stringify(events.at(-1))).toContain(models[1])
    expect(server.requests).toHaveLength(2)
  })

  it.each([['other', false, undefined], ['google', true, undefined], ['google', 'selection', undefined], ['google', false, false]] as const)('keeps %s pinned=%s enabled=%s terminal', async (provider, pinned, enabled) => {
    const model = 'gemini-73.8-flash'
    const server = scriptedProvider([quota])
    const ctx = await composition(server.url, provider, [model, 'gemini-73.7-flash'], { enabled })
    const events = await turn(ctx, `terminal-${provider}`, provider, model, pinned)
    expect(events.some(event => event.type === 'llm/model-fallback')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { error: { code: 'DAILY_QUOTA_EXHAUSTED' } } } })
    expect(server.requests).toHaveLength(1)
  })

  it('requires a reset zone for non-google opt-ins and rejects invalid zones', () => {
    expect(() => resolveProfiles({ other: { dailyQuotaFallback: true } })).toThrow('requires dailyQuotaResetTimeZone')
    expect(() => resolveProfiles({ google: { dailyQuotaResetTimeZone: 'not/a/zone' } })).toThrow('invalid dailyQuotaResetTimeZone')
  })
})

describe('thinking-level recovery', () => {
  it('retries MINIMAL with LOW once and remembers the working default', async () => {
    const model = 'gemini-74.8-flash'
    const server = scriptedProvider([unsupported, { events: textEvents }, { events: textEvents }])
    const ctx = await composition(server.url, 'google', [model])
    const events = await turn(ctx, 'thinking-one', 'google', model, false, 'minimal')
    expect(events.filter(event => event.type === 'llm/thinking-fallback').map(event => event.data)).toEqual([{
      turn: 1, step: 1, provider: 'google', model, from: 'minimal', to: 'low', reason: 'UNSUPPORTED_THINKING_LEVEL',
    }])
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    await turn(ctx, 'thinking-two', 'google', model, false, 'minimal')
    expect(server.requests.map(request => (request as { reasoning_effort?: string }).reasoning_effort)).toEqual(['minimal', 'low', 'low'])
  })

  it('ends the step when the single correction is also rejected', async () => {
    const model = 'gemini-75.8-flash'
    const server = scriptedProvider([unsupported, unsupported])
    const ctx = await composition(server.url, 'google', [model])
    const events = await turn(ctx, 'thinking-terminal', 'google', model, false, 'minimal')
    expect(events.filter(event => event.type === 'llm/thinking-fallback')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ data: { reason: { error: { code: 'INVALID_REQUEST' } } } })
    expect(server.requests).toHaveLength(2)
  })
})


it.each([
  [{ low: 'low', medium: 'medium' }, 'LOW'],
  [false, undefined],
] as const)('keeps Gemini 3.x provider-default requests away from implicit MINIMAL (%s)', async (efforts, expected) => {
  const server = scriptedProvider([{ events: [JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  })] }])
  const profiles = resolveProfiles({ google: {
    baseURL: server.url, models: [{ id: 'gemini-3.8-flash', reasoningEfforts: efforts }],
  } })
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: () => Promise.resolve('key'), auth: memoryAuth() })
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'google', model: 'gemini-3.8-flash', messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })] })) chunks.push(chunk)
  expect(chunks.at(-1), JSON.stringify(chunks.at(-1))).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect((server.requests[0] as { generationConfig?: { thinkingConfig?: { thinkingLevel?: string } } })
    .generationConfig?.thinkingConfig?.thinkingLevel).toBe(expected)
})

it.each([
  [['minimal', 'medium'], 'medium'],
  [['minimal'], 'off'],
])('corrects thinking using the declared supported levels %j', async (efforts, expected) => {
  const model = `gemini-76.8-${expected}`
  const server = scriptedProvider([unsupported, { events: textEvents }])
  const ctx = await composition(server.url, 'google', [model], { efforts })
  const events = await turn(ctx, `thinking-${expected}`, 'google', model, false, 'minimal')
  expect(events.find(event => event.type === 'llm/thinking-fallback')?.data).toMatchObject({ from: 'minimal', to: expected })
  expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
})
