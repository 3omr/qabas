/** Fixed libraries are created on first use; explicit developer overrides remain isolated. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEngineCommand, TranscriberEngine, type TranscriberDoctorCommand } from '../src/index.ts'
import { defaultLibraryPath, resolveWorkspace } from '../src/workspace.ts'

let root: string
let environment: NodeJS.ProcessEnv
const signal = (): AbortSignal => new AbortController().signal
const execute = promisify(execFile)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qabas-fixed-library-'))
  environment = { HOME: root, USERPROFILE: root, DSH_HOME: join(root, 'old-home') }
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const endpoint = (): TranscriberEngine => new TranscriberEngine(new Context(), { environment })

async function legacyModule(): Promise<string> {
  const module = join(root, 'Qabas Library', 'modules', 'surgery')
  for (const folder of ['Lecture', 'Questions', 'Transcripts']) await mkdir(join(module, folder), { recursive: true })
  await writeFile(join(module, 'module.json'), JSON.stringify({ schema_version: 1, module_id: 'surgery', display_name: 'Surgery', notebook: { id: 'kept-notebook' } }))
  await writeFile(join(module, 'Lecture', 'recording.mp3'), Buffer.from([0, 1, 2, 255]))
  return module
}

describe('fixed app library', () => {
  it('finishes real legacy adoption before the direct workspace Remote returns its count', async () => {
    const source = await legacyModule()
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      const engine = new TranscriberEngine(ctx, { environment })
      const result = await engine.workspace(signal())
      expect(result.modules).toBe(1)
      const target = join(result.path, 'modules', 'surgery', 'Lecture', 'recording.mp3')
      expect(await readFile(target)).toEqual(await readFile(join(source, 'Lecture', 'recording.mp3')))
      await writeFile(target, 'edited in new library')
      expect((await engine.workspace(signal())).modules).toBe(1)
      expect(await readFile(target, 'utf8')).toBe('edited in new library')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('adopts legacy modules before a Loader composition resolves the initial MCP command', async () => {
    await legacyModule()
    const ctx = new Context()
    class FixtureEngine extends TranscriberEngine {
      constructor(owner: Context) { super(owner, { environment }) }
    }
    let adoptedBeforeLaunch = false
    let initialCount: number | undefined
    const consumer = {
      async apply(dependent: Context, command: TranscriberDoctorCommand) {
        adoptedBeforeLaunch = existsSync(join(command.cwd, 'modules', 'surgery', 'module.json'))
        initialCount = (await dependent.transcriberEngine.workspace(signal())).modules
      },
    }
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-api-transcriber-engine'",
      '- name: test-mcp-consumer',
      '  inject: [transcriberEngine]',
      '  config: !!js >',
      '    ctx.transcriberEngine.mcpCommand', '',
    ].join('\n'))
    try {
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      const modules = new Map<string, unknown>([
        ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
        ['@deepseek-ai/dsh-api-transcriber-engine', FixtureEngine],
        ['test-mcp-consumer', consumer],
      ])
      ctx.loader.internal = {
        version: 'v2',
        async import(specifier: string) {
          if (!modules.has(specifier)) throw new Error(`Unexpected fixture plugin: ${specifier}`)
          return modules.get(specifier)
        },
      } as unknown as NonNullable<typeof ctx.loader.internal>
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
      await ctx.loader.await()
      expect(adoptedBeforeLaunch).toBe(true)
      expect(initialCount).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('refuses a divergent legacy collision before returning a workspace count', async () => {
    await legacyModule()
    const target = join(defaultLibraryPath(environment), 'modules', 'surgery', 'Lecture')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'recording.mp3'), 'independent new recording')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    try {
      const engine = new TranscriberEngine(ctx, { environment })
      const operation = engine.workspace(signal())
      await expect(operation).rejects.toHaveProperty('code', 'transcriber-engine/workspace-unavailable')
      await expect(operation).rejects.toThrow('collision')
      expect(await readFile(join(target, 'recording.mp3'), 'utf8')).toBe('independent new recording')
    } finally {
      await ctx.fiber.dispose()
    }
  }, 30_000)

  it('maps workspace preparation to the bundled frozen subcommand', () => {
    environment.TRANSCRIBER_ENGINE_ROOT = join(root, 'engine')
    const executable = join(environment.TRANSCRIBER_ENGINE_ROOT, process.platform === 'win32' ? 'transcriber-engine.exe' : 'transcriber-engine')
    const command = buildEngineCommand('prepare_workspace.py', [], environment, path => path === executable || path === defaultLibraryPath(environment))
    expect(command.argv).toEqual([executable, 'prepare-workspace', '--workspace', defaultLibraryPath(environment)])
  })

  it('ignores a saved selection and creates the default library and modules on first use', async () => {
    const old = join(root, 'selected')
    await mkdir(old)
    const pointer = join(environment.DSH_HOME as string, 'transcriber', 'workspace.json')
    await mkdir(join(environment.DSH_HOME as string, 'transcriber'), { recursive: true })
    await writeFile(pointer, JSON.stringify({ path: old }))
    expect(resolveWorkspace(environment)).toEqual({ path: join(root, 'qabas', 'Qabas Library'), source: 'default' })
    expect(await endpoint().workspace(signal())).toEqual({ path: join(root, 'qabas', 'Qabas Library'), source: 'default', exists: true, modules: 0 })
    await mkdir(join(defaultLibraryPath(environment), 'modules', 'surgery'))
    await mkdir(join(defaultLibraryPath(environment), 'modules', '.temporary'))
    expect((await endpoint().workspace(signal())).modules).toBe(1)
    expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ path: old })
  })

  it('creates an explicit override and ignores blank overrides', async () => {
    await legacyModule()
    environment.TRANSCRIBER_WORKSPACE = join(root, 'developer-library')
    expect(await endpoint().workspace(signal())).toEqual({ path: environment.TRANSCRIBER_WORKSPACE, source: 'env', exists: true, modules: 0 })
    environment.TRANSCRIBER_WORKSPACE = '   '
    expect(resolveWorkspace(environment)).toEqual({ path: join(root, 'qabas', 'Qabas Library'), source: 'default' })
  })

  it('agrees with Python for the same isolated home, independent of child cwd', async () => {
    const repo = resolve(import.meta.dirname, '../../../..')
    const venv = join(repo, 'engine', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const python = existsSync(venv) ? venv : process.platform === 'win32' ? 'python' : 'python3'
    const code = 'import sys; sys.path.insert(0, sys.argv[1]); from library_workspace import workspace_path; print(workspace_path())'
    const { stdout } = await execute(python, ['-c', code, join(repo, 'engine', 'scripts')], {
      cwd: root, env: { ...process.env, ...environment, TRANSCRIBER_WORKSPACE: '' },
    })
    expect(stdout.trim()).toBe(defaultLibraryPath(environment))
  })

  it.each(['library', 'modules'])('refuses a regular file occupying the %s directory', async (target) => {
    const library = defaultLibraryPath(environment)
    await mkdir(join(root, 'qabas'), { recursive: true })
    if (target === 'modules') await mkdir(library)
    await writeFile(target === 'modules' ? join(library, 'modules') : library, 'occupied')
    await expect(endpoint().workspace(signal())).rejects.toHaveProperty('code', 'transcriber-engine/workspace-unavailable')
  })

  it('refuses a linked default library before creating anything through it', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await mkdir(join(root, 'qabas'))
    await symlink(outside, defaultLibraryPath(environment), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(endpoint().workspace(signal())).rejects.toHaveProperty('code', 'transcriber-engine/workspace-unavailable')
    expect(existsSync(join(outside, 'modules'))).toBe(false)
  })

  it('refuses cancellation before creating the library', async () => {
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(endpoint().workspace(cancellation.signal)).rejects.toHaveProperty('code', 'gateway/cancelled')
  })
})
