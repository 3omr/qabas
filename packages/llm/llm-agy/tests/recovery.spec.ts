/** Cross-provider recovery through Loader, real Agent steps and session events. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import * as Agy from '../src/index.ts'

let context: Context | undefined
let directory: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  context = undefined
  directory = undefined
})

class GoogleFixture extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async listModels(provider: string) { return [{ provider, id: 'gemini-3.8-flash', name: 'Gemini Flash' }] }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Google answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Google answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function composition(key: boolean, fallback = true) {
  directory = await mkdtemp(join(tmpdir(), 'agy-recovery-'))
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    '- name: llm', '- name: sessions', '- name: projections', '- name: systemPrompt', '- name: tools', '- name: agents',
    '- name: subprocess', '- name: credentials', '  config:', `    GEMINI_API_KEY: ${key ? 'saved-student-key' : "''"}`,
    '- name: loop', '  config:', '    agents: []', '- name: agy', '  config:',
    `    executable: ${JSON.stringify(process.execPath)}`, `    googleFallback: ${fallback}`, '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['sessions', SessionStore], ['projections', SessionProjectionRegistry],
    ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop],
    ['subprocess', LocalSubprocessRuntime], ['credentials', MemoryCredentials], ['agy', Agy],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await vi.waitFor(() => { expect(ctx.get('agentLoop')).toBeDefined() })
  const fixture = fileURLToPath(new URL('./fixtures/agy.mjs', import.meta.url))
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  ctx.subprocess.spawn = spec => spawn({ ...spec, argv: [process.execPath, fixture, ...spec.argv.slice(1)] })
  const google = new GoogleFixture()
  ctx.effect(() => ctx.llm.registerAdapter(['google'], google))
  return { ctx, google }
}

it.each([
  { key: true, pin: false, enabled: true, expected: true },
  { key: false, pin: false, enabled: true, expected: false },
  { key: true, pin: true, enabled: true, expected: false },
  { key: true, pin: false, enabled: false, expected: false },
])('Google fallback respects saved key and policy: %j', async ({ key, pin, enabled, expected }) => {
  const { ctx, google } = await composition(key, enabled)
  const agent = await ctx.agentLoop.create(SessionId('agy-fallback'), { provider: 'agy', model: 'signin' })
  if (pin) installModelSelection(agent.ctx, { current: { provider: 'agy', model: 'signin' }, assembled: undefined, allowFallback: false })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Explain shock' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  const fallback = events.filter(event => event.type === 'llm/model-fallback')
  expect(fallback).toHaveLength(expected ? 1 : 0)
  expect(google.requests).toHaveLength(expected ? 1 : 0)
  if (expected) {
    expect(fallback[0]).toMatchObject({ data: { reason: 'AGY_NOT_SIGNED_IN', from: { provider: 'agy' }, to: { provider: 'google' } } })
    expect(events.filter(event => event.type === 'request/header').at(-1)).toMatchObject({ data: { header: { config: { provider: 'google' } } } })
    expect(events.at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
  }
})

it('unmounting the adapter withdraws its route and discovery registration', async () => {
  const { ctx } = await composition(false)
  const runtime = ctx.registry.get(Agy)
  if (runtime === undefined) throw new Error('agy plugin missing from Loader')
  expect(ctx.llm.listProviders().some(provider => provider.id === 'agy')).toBe(true)
  for (const fiber of runtime.fibers) await fiber.dispose()
  expect(ctx.llm.listProviders().some(provider => provider.id === 'agy')).toBe(false)
})
