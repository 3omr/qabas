/** Restart-order recovery through the Web host's native Google route and sibling controller. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import SettingsController from '../../../api/settings-controller/src/index.ts'
import * as PiAi from '../src/index.ts'
import type { RecoveryObservation } from '../src/recovery-store.ts'

let context: Context | undefined
let directory: string | undefined
const model = 'gemini-2.5-flash'

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function observations(): Promise<RecoveryObservation[]> {
  const stored = JSON.parse(await readFile(join(directory!, 'storages', 'llm_pi_ai_recovery.json'), 'utf8')) as {
    tables: { models: Record<string, RecoveryObservation> }
  }
  return Object.values(stored.tables.models)
}

async function restartHost(): Promise<Context> {
  directory = await mkdtemp(join(tmpdir(), 'pi-native-key-reset-'))
  await mkdir(join(directory, 'storages'))
  const daily: RecoveryObservation = { kind: 'daily', provider: 'google', model, timeZone: 'America/Los_Angeles', resetDate: '2099-01-01' }
  const unavailable: RecoveryObservation = { kind: 'unavailable', provider: 'google', model: 'retired' }
  const other: RecoveryObservation = { ...daily, provider: 'other' }
  await writeFile(join(directory, 'storages', 'llm_pi_ai_recovery.json'), JSON.stringify({
    unit: { name: 'llm_pi_ai_recovery', version: 1 }, global: null,
    tables: { models: Object.fromEntries([daily, unavailable, other].map(observation => [
      JSON.stringify([observation.provider, observation.model]), observation,
    ])) },
  }))
  await writeFile(join(directory, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    google: {}\n')
  await writeFile(join(directory, '.credentials.yaml'), 'version: 1\nrefs:\n  GEMINI_API_KEY: old-fixture-key\n', { mode: 0o600 })
  vi.stubEnv('GEMINI_API_KEY', '')
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    '- name: llm', '- name: sessions', '- name: projections', '- name: systemPrompt', '- name: tools', '- name: agents',
    '- name: loop', '  config:', '    agents: []',
    '- name: settings', '  config:', `    path: ${JSON.stringify(join(directory, 'settings.yaml'))}`, '    watch: false',
    '- name: credentials', '  config:', `    path: ${JSON.stringify(join(directory, '.credentials.yaml'))}`, '    watch: false',
    // Base loads pi-ai before storage; Web mounts settings-controller as a sibling afterward.
    '- name: pi', '- name: storage', '- name: storageJson', '  config:', `    root: ${JSON.stringify(join(directory, 'storages'))}`,
    '- name: storageDomain', '  config:', '    backend: json', '- name: settingsController', '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(directory).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['llm', LlmRuntime], ['sessions', SessionStore], ['projections', SessionProjectionRegistry], ['systemPrompt', SystemPrompt],
    ['tools', ToolRuntime], ['agents', AgentRegistry], ['loop', AgentLoop], ['settings', FileSettingsProvider],
    ['credentials', LocalCredentialProvider], ['pi', PiAi], ['storage', Storage], ['storageJson', StorageJson],
    ['storageDomain', StorageDomain], ['settingsController', SettingsController],
  ])
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (!modules.has(specifier)) throw new Error(`unexpected module ${specifier}`)
    return modules.get(specifier)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await vi.waitFor(() => {
    expect(ctx.get('credentialsController')).toBeDefined()
    expect(ctx.get('storageDomain')).toBeDefined()
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('google')
  })
  return ctx
}

describe('native Google credential reset after host restart', () => {
  it.each(['save', 'replace', 'remove', 'check'] as const)('clears persisted quota before the first LLM request on %s', async (operation) => {
    let generated = 0
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url === 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1') return new Response('{}')
      if (!url.includes(`${model}:streamGenerateContent`)) throw new Error(`unexpected fixture URL ${url}`)
      generated++
      return new Response(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    const ctx = await restartHost()
    expect(ctx.storageDomain.get('llm_pi_ai_recovery')).toBeUndefined()
    if (operation === 'check') expect(await ctx.credentialsController.checkGeminiKey(new AbortController().signal)).toEqual({ status: 'works' })
    else if (operation === 'remove') await ctx.credentialsController.unset('GEMINI_API_KEY')
    else {
      if (operation === 'save') await ctx.credentials.unset(credentialRef('GEMINI_API_KEY'))
      await ctx.credentialsController.set('GEMINI_API_KEY', 'new-fixture-key')
    }
    expect((await observations()).some(observation => observation.provider === 'google' && observation.kind === 'daily')).toBe(false)
    // Supply a key without the controller reset so removal is also tested through a real request.
    if (operation === 'remove') await ctx.credentials.set(credentialRef('GEMINI_API_KEY'), 'next-fixture-key')
    const agent = await ctx.agentLoop.create(SessionId(`native-reset-${operation}`), { provider: 'google', model })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue lecture' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(generated).toBe(1)
    expect(await observations()).toEqual(expect.arrayContaining([
      { kind: 'unavailable', provider: 'google', model: 'retired' },
      expect.objectContaining({ kind: 'daily', provider: 'other' }),
    ]))
  })
})
