/** A real cordis.yml mounts the session-free library service with deployment limits. */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it, vi } from 'vitest'
import TranscriberEngine from '../src/index.ts'

it('lists and edits the library through a Loader composition before any Session exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qabas-loader-'))
  const ctx = new Context()
  const configPath = join(root, 'cordis.yml')
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  vi.stubEnv('TRANSCRIBER_WORKSPACE', root)
  vi.stubEnv('TRANSCRIBER_SKILL_ROOT', root)
  try {
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-api-transcriber-engine'",
      '  config:', '    maxTextBytes: 8', '    maxImageBytes: 2',
      '    mcpOutputMaxBytes: 512', '    mcpGraceMs: 7', '',
    ].join('\n'))
    await import('node:fs/promises').then(disk => disk.mkdir(join(root, 'scripts')))
    await writeFile(join(root, 'scripts', 'mcp_server.py'), '')
    await writeFile(join(root, 'lecture.md'), 'draft')
    await writeFile(join(root, 'figure.png'), Buffer.from([1, 2, 3]))
    const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
      const stdin = spec.stdio.stdin
      if (typeof stdin !== 'object') throw new Error('fixture expected MCP input')
      const request = JSON.parse(stdin.data.split('\n')[1] ?? '') as { params: { name: string; arguments: Record<string, unknown> } }
      let text = JSON.stringify({ id: 2, result: { content: [{ type: 'text', text: JSON.stringify(
        stdin.data.includes('list_modules')
          ? { workspace: root, modules: [{ module: 'toxo', display_name: 'Toxicology', notebooks: [], root }] }
          : { module: 'toxo', lectures: [], materials: [] },
      ) }] } })
      const done = (async () => {
        if (request.params.name === 'create_module') {
          expect(request.params.arguments).toEqual({ module: 'toxo', display_name: 'Toxicology', confirmed: true })
          await mkdir(join(root, 'modules', 'toxo'))
          text = JSON.stringify({ id: 2, result: { content: [{ text: 'Created Toxicology notebook' }] } })
        }
        return { exitCode: 0, signal: null }
      })()
      return {
        stdin: undefined, stdout: undefined, stderr: undefined,
        collected: { stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) } },
        done, terminate() {}, waitForExit: async () => true,
      }
    })
    ctx.provide('subprocess', { spawn } as never)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-api-transcriber-engine') throw new Error('Unexpected fixture plugin: ' + specifier)
        return TranscriberEngine
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const signal = new AbortController().signal
    const workspace = await ctx.transcriberEngine.setWorkspace({ path: root, create: true }, signal)
    expect(workspace).toEqual({ path: root, source: 'file', exists: true, modules: 0 })
    const created = await ctx.transcriberEngine.createModule({ module: 'toxo', displayName: 'Toxicology' }, signal)
    expect({ created, workspace: { ...await ctx.transcriberEngine.workspace(signal), path: '<workspace>' } }).toMatchInlineSnapshot(`
      {
        "created": "Created Toxicology notebook",
        "workspace": {
          "exists": true,
          "modules": 1,
          "path": "<workspace>",
          "source": "file",
        },
      }
    `)
    expect(JSON.parse(await readFile(join(root, 'home', 'transcriber', 'workspace.json'), 'utf8'))).toEqual({ path: root })
    const inventory = await ctx.transcriberEngine.listModules(signal)
    expect(inventory.modules.map(({ module, display_name, notebooks }) => ({ module, display_name, notebooks }))).toMatchInlineSnapshot(`
      [
        {
          "display_name": "Toxicology",
          "module": "toxo",
          "notebooks": [],
        },
      ]
    `)
    expect(await ctx.transcriberEngine.listLectures({ module: 'toxo' }, signal)).toEqual({ module: 'toxo', lectures: [], materials: [] })
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ graceMs: 7, stdio: { stdout: { maxBytes: 512 } } })
    const before = await ctx.transcriberEngine.readFile({ path: 'lecture.md' }, signal)
    await ctx.transcriberEngine.writeFile({ path: 'lecture.md', text: 'final', expectedVersion: before.version }, signal)
    expect(await readFile(join(root, 'lecture.md'), 'utf8')).toBe('final')
    await expect(ctx.transcriberEngine.readFileBytes({ path: 'figure.png' }, signal)).rejects.toMatchObject({ code: 'transcriber-engine/file-too-large' })
    expect(ctx.get('sessions')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
