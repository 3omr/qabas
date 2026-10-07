import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as retry from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

class TransientOnceAdapter extends LlmAdapter {
  requests = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: ['RATE_LIMIT', 'SERVER'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'loader test provider retryPolicy')

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests === 1) throw new LlmError('429 Please retry in 0.02s', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 20 })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'recovered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-retry-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-retry', retry],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it.each([
    { scenario: 'recovers after a minute of overload', failures: 6, status: 503, delays: [3000, 6000, 12_000, 24_000, 48_000, 60_000], terminal: false },
    { scenario: 'bounds persistent overload at eight retries', failures: 9, status: 503, delays: [3000, 6000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000], terminal: true },
    { scenario: 'honors an overload Retry-After above the local cap', failures: 1, status: 503, delays: [75_150], terminal: false, retryAfter: '75' },
    { scenario: 'keeps RATE_LIMIT unlimited with provider waits', failures: 7, status: 429, delays: Array<number>(7).fill(75_025), terminal: false, retryAfter: '75' },
    { scenario: 'ends Google overload after two retries', failures: 3, status: 503, delays: [1000, 2000], terminal: true, provider: 'google' },
    { scenario: 'ends Google rate limits after two retries', failures: 3, status: 429, delays: [1000, 2000], terminal: true, provider: 'google' },
    { scenario: 'uses the explicit user budget and backoff', failures: 2, status: 503, delays: [20], terminal: true, userPolicy: true },
  ])('$scenario', async ({ failures, status, delays, terminal, retryAfter, userPolicy, provider = 'openai' }) => {
    vi.stubEnv('OPENAI_API_KEY', 'mock-key')
    const random = vi.spyOn(Math, 'random')
    const requests: unknown[] = []
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      requests.push(JSON.parse(init.body) as unknown)
      if (requests.length <= failures) {
        return new Response(JSON.stringify({ error: { message: status === 503 ? 'This model is currently experiencing high demand' : 'Rate limit exceeded' } }), {
          status,
          headers: { 'content-type': 'application/json', ...retryAfter === undefined ? {} : { 'Retry-After': retryAfter } },
        })
      }
      return new Response('data: {"choices":[{"delta":{"content":"recovered"},"index":0,"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      `      ${provider}:`,
      '        apiKeyEnv: OPENAI_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://overload.test/v1',
      '        models: [{id: mock}]',
      ...userPolicy ? [
        '        retryPolicy:',
        '          mode: normal',
        '          maxRetries: 1',
        '          backoff: {initialDelayMs: 20, maxDelayMs: 20, jitterRatio: 0}',
      ] : [],
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    vi.useFakeTimers()
    random.mockReturnValue(0.5)
    const agent = await loaded.agentLoop.create(SessionId('loader-overload'), { provider, model: 'mock' })
    const scheduled = new Promise<void>((resolve) => {
      const dispose = loaded.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'llm/retry') { dispose(); resolve() }
      })
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await scheduled
    await vi.advanceTimersByTimeAsync(delays[0]! - 1)
    expect(requests).toHaveLength(1)
    await vi.runAllTimersAsync()
    await idle

    expect(requests).toHaveLength(delays.length + 1)
    expect(requests.every(request => JSON.stringify(request) === JSON.stringify(requests[0]))).toBe(true)
    const events = agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
    expect(events.map(event => event.data.delayMs)).toEqual(delays)
    expect(events.map(event => event.data.retry)).toEqual(delays.map((_, index) => index + 1))
    expect(events.every(event => event.data.failure.code === (status === 503 ? 'OVERLOADED' : 'RATE_LIMIT'))).toBe(true)
    expect(events.every(event => status === 429 && provider !== 'google' ? event.data.mode === 'always' && !('maxRetries' in event.data)
      : event.data.mode === 'normal' && event.data.maxRetries === (userPolicy ? 1 : provider === 'google' ? 2 : 8))).toBe(true)
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: terminal ? 'error' : 'completed' } } })
    if (!terminal) expect(agent.session.deriveMessages().at(-1)).toMatchObject({ content: [{ type: 'text', text: 'recovered' }] })
    expect(vi.getTimerCount()).toBe(0)
  })

  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('loads provider-supplied policy and records recovery through the shipping loop', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)

    const adapter = new TransientOnceAdapter()
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = await loaded.agentLoop.create(SessionId('loader-retry'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toBe(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data))
      .toMatchObject([{ delayMs: 20, failure: { code: 'RATE_LIMIT', status: 429 } }])
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })
})
