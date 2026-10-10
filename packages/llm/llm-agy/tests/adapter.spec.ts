/** Model-only CLI mapping and managed process cancellation without live agy. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
    await vi.waitFor(async () => { facts = JSON.parse(await readFile(ready, 'utf8')) as typeof facts; expect(facts).toBeDefined() })
    controller.abort()
    expect((await running).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    for (const pid of [facts!.parent, facts!.child]) expect(() => process.kill(pid, 0)).toThrow()
    await expect(readFile(join(facts!.cwd, 'anything'))).rejects.toThrow()
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
