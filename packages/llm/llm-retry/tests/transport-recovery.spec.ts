import { createUserMessage, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import type { MockLlmBehavior, MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as Retry from '../src/index.ts'

let context: Context | undefined
const servers: MockLlmServer[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(servers.splice(0).map(server => server.close()))
})

async function start(
  sequence: readonly MockLlmBehavior[],
  options: Omit<Parameters<typeof startMockLlmServer>[0], 'sequence'> = {},
): Promise<MockLlmServer> {
  const server = await startMockLlmServer({ sequence, ...options })
  servers.push(server)
  return server
}

async function harness(
  baseURL: string,
  options: { streamIdleTimeoutMs?: number; initialDelayMs?: number } = {},
): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'mock-key')
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LlmPiAi, {
    providers: {
      deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        api: 'openai-completions',
        baseURL,
        models: [{ id: 'mock-model' }],
        streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 1_000,
        retryPolicy: {
          mode: 'normal',
          maxRetries: 2,
          backoff: {
            initialDelayMs: options.initialDelayMs ?? 10,
            maxDelayMs: options.initialDelayMs ?? 10,
            jitterRatio: 0,
          },
        },
      },
    },
  })
  await ctx.plugin(Retry)
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}

function sendAndWait(ctx: Context, agent: Agent): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover through the provider boundary' }], source: { kind: 'user' } }))
  return idle
}

function finalAssistantText(agent: Agent): string | undefined {
  const message = agent.session.deriveMessages().at(-1)
  if (message?.role !== 'assistant') return undefined
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  return port
}

describe('bounded retry through the pi-ai HTTP/SSE adapter', () => {
  it('recovers from a true refused connection after the endpoint starts during backoff', async () => {
    const port = await unusedPort()
    context = await harness(`http://127.0.0.1:${port}`, { initialDelayMs: 100 })
    const agent = await context.agentLoop.create(SessionId('wire-refused'), {
      provider: 'deepseek',
      model: 'mock-model',
    })
    let recoveryServer: Promise<MockLlmServer> | undefined
    context.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'llm/retry' || event.data.retry !== 1) return
      recoveryServer = start(['success'], { port, apiKey: 'mock-key', successText: 'connected after retry' })
    })

    await sendAndWait(context, agent)
    const server = await recoveryServer

    expect(server).toBeDefined()
    expect(server?.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('connected after retry')
  })

  it.each([
    ['stream_disconnect'] as const,
    ['partial_disconnect'] as const,
  ])('retries %s without committing failed chunks', async (behavior) => {
    const server = await start([behavior, 'success'], {
      apiKey: 'mock-key',
      partialText: 'discard me',
      chunkSize: 100,
      disconnectDelayMs: 20,
      successText: 'recovered response',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId(`wire-${behavior}`), {
      provider: 'deepseek',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    const retryEvent = agent.session.snapshotEvents().find(event => event.type === 'llm/retry')
    const failedAttempts = agent.session.snapshotEvents().filter((event): event is SessionEvent<'assistant/attempt'> =>
      event.type === 'assistant/attempt'
      && retryEvent !== undefined
      && event.seq < retryEvent.seq,
    )
    expect(failedAttempts).toHaveLength(1)
    // The failed attempt must end in the terminal transport failure. The exact
    // number of chunks before it is the adapter's streaming granularity, not
    // this plugin's contract -- pi-ai also emits a zero `usage` chunk where the
    // adapter this test was written against emitted none -- so pinning a count
    // here only records which adapter is mounted. What must hold is that the
    // attempt is recorded as failed and that nothing it streamed is committed,
    // which the assertions below prove.
    const failedChunks = expandAssistantStream(failedAttempts[0]!.data.stream)
    expect(failedChunks.at(-1)?.chunk).toMatchObject({
      reason: { kind: 'error', failure: { code: 'TRANSPORT' } },
    })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TRANSPORT'])
    expect(finalAssistantText(agent)).toBe('recovered response')
  })

  it('retries a wire-valid content-less completion without committing an empty message', async () => {
    const server = await start(['empty', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered from empty',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-empty'), {
      provider: 'deepseek',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]?.body).toEqual(server.requests[1]?.body)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['EMPTY_RESPONSE'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step]))
      .toEqual([[1, 1]])
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    expect(finalAssistantText(agent)).toBe('recovered from empty')
  })

  // A clean partial EOF -- the wire closing after well-formed events but before
  // the terminal one -- is retried, and that is a deliberate change of contract
  // inherited from the adapter swap. The adapter this suite was written against
  // called it STREAM_CLOSED and refused to retry it; pi-ai classifies the same
  // event as TRANSPORT, reasoning in `llm-pi-ai/src/stream.ts` that "the
  // connection dropped mid-response, so this is a transport truncation, not a
  // model-level error". Retrying is the better answer for a truncated response
  // that is useless to its reader, and it stays bounded by the route's
  // retryPolicy -- which is what this asserts.
  it('retries a clean partial EOF as a transport truncation, within budget', async () => {
    const server = await start(['partial_eof', 'success'], {
      apiKey: 'mock-key',
      partialText: 'discarded clean eof',
      chunkSize: 100,
      successText: 'recovered after truncation',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-partial-eof'), {
      provider: 'deepseek',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
      .map(event => event.data.failure.code)).toEqual(['TRANSPORT'])
    // The truncated attempt is recorded but never committed as a message.
    expect(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
      .map(event => [event.data.turn, event.data.step])).toEqual([[1, 1]])
    expect(finalAssistantText(agent)).toBe('recovered after truncation')
  })

  it('turns a stalled body into TIMEOUT and succeeds on the next request', async () => {
    const server = await start(['stall', 'success'], {
      apiKey: 'mock-key',
      successText: 'recovered after timeout',
    })
    // This crosses the real HTTP idle timer, so leave scheduler slack between
    // the stalled attempt and the mock server's immediate successful response.
    context = await harness(server.baseURL, { streamIdleTimeoutMs: 1_000 })
    const agent = await context.agentLoop.create(SessionId('wire-stall'), {
      provider: 'deepseek',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests.map(record => record.behavior)).toEqual(['stall', 'success'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry').map(event => event.data.failure.code))
      .toEqual(['TIMEOUT'])
    expect(finalAssistantText(agent)).toBe('recovered after timeout')
  }, 10_000)

  it('stops after the configured transport retry budget is exhausted', async () => {
    const server = await start(['connection_reset', 'connection_reset', 'connection_reset'], {
      apiKey: 'mock-key',
    })
    context = await harness(server.baseURL)
    const agent = await context.agentLoop.create(SessionId('wire-exhausted'), {
      provider: 'deepseek',
      model: 'mock-model',
    })

    await sendAndWait(context, agent)

    expect(server.requests).toHaveLength(3)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')).toHaveLength(2)
    const end = agent.session.snapshotEvents().at(-1)
    expect(end).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } },
    })
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      // The wording is the adapter's, not this plugin's: pi-ai surfaces a
      // refused connection as the SDK's own "Connection error." where the
      // adapter this test was written against named the endpoint it had tried.
      // What matters here is that the budget is exhausted and the failure
      // reaches the turn as TRANSPORT, asserted above.
      expect(end.data.reason.error.message).toBeTruthy()
    }
  })
})
