/** Model-only CLI mapping and managed process cancellation without live agy. */
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage, createAssistantMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../src/adapter.ts'
import { Config } from '../src/config.ts'
import { renderPrompt } from '../src/prompt.ts'

const fixture = fileURLToPath(new URL('./fixtures/agy.mjs', import.meta.url))
let ctx: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  ctx = undefined
  directory = undefined
})
const request = (model: string): GenerateOptions => ({ provider: 'agy', model,
  messages: [createUserMessage({ content: [{ type: 'text', text: 'Explain shock' }], source: { kind: 'user' } })],
  tools: [{ name: 'library', description: 'Search the library', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
})
async function adapter() {
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  // The protocol fixture runs with Node on every platform; the real subprocess
  // provider still owns process trees, cancellation and output collection.
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const processOwner = Object.create(ctx.subprocess) as LocalSubprocessRuntime
  processOwner.spawn = spec => spawn({ ...spec, argv: [process.execPath, fixture, ...spec.argv.slice(1)] })

  return new AgyAdapter(processOwner, Config({ executable: process.execPath, graceMs: 200, defaultModel: 'gemini-3.8-flash-low',
    effort: 'low', timeoutMs: 180000, maxOutputBytes: 4194304, googleFallback: true }))
}
async function collect(adapter: AgyAdapter, options: GenerateOptions) {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  expect(chunks.filter(chunk => chunk.type === 'finish')).toHaveLength(1)
  expect(chunks.at(-1)?.type).toBe('finish')
  return chunks
}

describe('agy model adapter', () => {
  it('returns text and token usage from a model-only CLI request', async () => {
    const chunks = await collect(await adapter(), request('text'))
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'Hello student' } })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })
  it('publishes a Qabas tool call with raw object arguments', async () => {
    const chunks = await collect(await adapter(), request('tool'))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toMatchObject({ type: 'block-end', index: 1, block: {
      type: 'tool-call', name: 'library', arguments: '{"query":"shock"}',
    } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
  it('passes a conversation larger than one argv value through stdin', async () => {
    const options = request('size')
    const large = { ...options, messages: [createUserMessage({ content: [{ type: 'text', text: 'شرح '.repeat(80_000) }], source: { kind: 'user' } })] }
    const chunks = await collect(await adapter(), large)
    const text = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
    expect(text).toMatchObject({ block: { text: `prompt bytes ${String(Buffer.byteLength(renderPrompt(large)))}` } })
    expect(Buffer.byteLength(renderPrompt(large))).toBeGreaterThan(256 * 1024)
  })
  it('publishes decoded answer text while the CLI is still waiting to finish', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agy-stream-test-'))
    const ready = join(directory, 'ready.json')
    const instance = await adapter()
    const controller = new AbortController()
    const stream = instance.stream({ ...request(`stream:${ready}`), signal: controller.signal })[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
      expect((await stream.next()).value).toEqual({ type: 'text-delta', index: 0, text: 'Hello' })
      let facts: { parent: number } | undefined
      // The fixture is a fresh Node process; under a loaded worker pool it can take longer than vi.waitFor's 1 s default to start.
      await vi.waitFor(async () => { facts = JSON.parse(await readFile(ready, 'utf8')) as typeof facts; expect(facts).toBeDefined() }, { timeout: 30_000, interval: 50 })
      expect(() => process.kill(facts!.parent, 0)).not.toThrow()
      await writeFile(ready + '.release', '')
      const chunks: StreamChunk[] = []
      for (let item = await stream.next(); !item.done; item = await stream.next()) chunks.push(item.value)
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: ' student' })
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    } finally {
      controller.abort()
      await stream.return?.()
      await instance.dispose()
    }
  })
  it('unwraps a fenced schema response inside structured_output.text', async () => {
    const chunks = await collect(await adapter(), request('nested'))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Unwrapped answer' })
  })
  it.each([
    ['unknown', 'AGY_INVALID_TOOL_CALL'], ['array', 'AGY_INVALID_TOOL_CALL'], ['invalid-json', 'AGY_INVALID_TOOL_CALL'],
    ['reset', 'TRANSPORT'], ['eligibility', 'TRANSPORT'], ['signin', 'AGY_NOT_SIGNED_IN'], ['quota', 'AGY_QUOTA'],
  ])('%s produces a terminal %s failure without publishing partial content', async (model, code) => {
    const chunks = await collect(await adapter(), request(model))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
  })
  it.each([['partial-unknown', 'AGY_INVALID_TOOL_CALL'], ['mismatch', 'AGY_INVALID_RESPONSE']])(
    'retains provisional text but publishes no executable calls on %s', async (model, code) => {
      const chunks = await collect(await adapter(), request(model))
      expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
      expect(chunks.some(chunk => chunk.type === 'tool-call-delta' || chunk.type === 'block-end')).toBe(false)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
    },
  )
  it('parses the tab-separated catalog and prioritizes the configured default', async () => {
    expect(await (await adapter()).listModels('agy')).toEqual([
      { provider: 'agy', id: 'gemini-3.8-flash-low', name: 'Gemini Flash', inputModalities: ['text'] },
      { provider: 'agy', id: 'other', name: 'Other model', inputModalities: ['text'] },
    ])
  })
  it('cancellation settles only after the CLI and its child exit', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agy-test-'))
    const ready = join(directory, 'ready.json')
    const controller = new AbortController()
    const running = collect(await adapter(), { ...request(`wait:${ready}`), signal: controller.signal })
    let facts: { parent: number; child: number; cwd: string } | undefined
    // The fixture is a fresh Node process; under a loaded worker pool it can take longer than vi.waitFor's 1 s default to start.
    await vi.waitFor(async () => { facts = JSON.parse(await readFile(ready, 'utf8')) as typeof facts; expect(facts).toBeDefined() }, { timeout: 30_000, interval: 50 })
    controller.abort()
    const settled = await running
    expect(settled).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(settled.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    for (const pid of [facts!.parent, facts!.child]) expect(() => process.kill(pid, 0)).toThrow()
    await expect(readdir(facts!.cwd)).rejects.toThrow()
  })
})

it('renders the same logged request deterministically, including tool history and definitions', () => {
  const options = request('text')
  options.system = 'Teach medicine'
  options.messages.push(createAssistantMessage({ content: [{ type: 'tool-call', id: ToolCallId('call-1'), name: 'library', arguments: '{"query":"shock"}' }], source: { provider: 'agy', model: 'text' } }))
  options.messages.push(createUserMessage({ content: [{ type: 'tool-result', toolCallId: ToolCallId('call-1'), content: [{ type: 'text', text: 'Library evidence' }] }], source: { kind: 'user' } }))
  expect(renderPrompt(options)).toBe(renderPrompt(structuredClone(options)))
  expect(renderPrompt(options)).toMatchSnapshot()
})
