import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Api, Context as PiContext, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => {
  streamSimple.mockReset()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(provider = 'local-gateway'): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      [provider]: {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(adapter: PiAiAdapter, provider = 'local-gateway'): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider,
    model: 'local-model',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('paces later SDK requests after learning a minute quota from the first failure', async () => {
    vi.useFakeTimers()
    let attempts = 0
    streamSimple.mockImplementation(() => {
      attempts += 1
      throw new Error('429 ' + JSON.stringify({ error: { details: [{ violations: [{
        quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '5',
      }] }, { retryDelay: '19s' }] } }))
    })
    const adapter = gatewayAdapter('learned-quota')
    await drain(adapter, 'learned-quota')
    const pending = drain(adapter, 'learned-quota')
    await vi.advanceTimersByTimeAsync(18_999)
    expect(attempts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(attempts).toBe(2)
  })

  it('retains Retry-After from an HTTP 429 before the SDK flattens the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '25' } })))
    streamSimple.mockImplementation(async function* (_model: Model<Api>, _context: PiContext, options: SimpleStreamOptions) {
      await options.fetch?.('https://quota.test/v1')
      throw new Error('429 rate limit')
    })
    const chunks = await drain(gatewayAdapter())
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 25_000 } },
    })
  })

  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })
})
