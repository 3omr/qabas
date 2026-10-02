/** Live library setup uses private temporary roots and preserves committed settings on refusal. */

import * as disk from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriberEngine, runDependencyInstall } from '../src/index.ts'
import { buildDoctorCommand } from '../src/doctor.ts'
import { resolveWorkspace, workspaceFilePath } from '../src/workspace.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof disk>() }))

let root: string
let environment: NodeJS.ProcessEnv
let endpoint: TranscriberEngine
const signal = (): AbortSignal => new AbortController().signal
const setting = (): string => workspaceFilePath(environment)
async function save(contents: unknown): Promise<void> {
  await disk.mkdir(join(root, 'home', 'transcriber'), { recursive: true })
  await disk.writeFile(setting(), JSON.stringify(contents))
}

beforeEach(async () => {
  root = await disk.mkdtemp(join(tmpdir(), 'qabas-workspace-'))
  environment = { DSH_HOME: join(root, 'home'), TRANSCRIBER_WORKSPACE: root }
  endpoint = new TranscriberEngine(new Context(), { environment })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await disk.rm(root, { recursive: true, force: true })
})

describe('session-free workspace setup', () => {
  it('resolves the same Harness home rules without another package dependency', () => {
    expect(workspaceFilePath({})).toBe(join(homedir(), '.dsh', 'transcriber', 'workspace.json'))
    expect(workspaceFilePath({ DSH_HOME: '  ' })).toBe(workspaceFilePath({}))
    expect(workspaceFilePath({ DSH_HOME: '~' })).toBe(join(homedir(), 'transcriber', 'workspace.json'))
    for (const prefix of ['~/', '~\\']) expect(workspaceFilePath({ DSH_HOME: prefix + 'data' })).toBe(join(homedir(), 'data', 'transcriber', 'workspace.json'))
    vi.stubEnv('DSH_HOME', environment.DSH_HOME)
    expect(workspaceFilePath()).toBe(setting())
  })

  it('reports env and cwd fallbacks, including missing and non-directory workspaces', async () => {
    expect(await endpoint.workspace(signal())).toEqual({ path: root, source: 'env', exists: true, modules: 0 })
    delete environment.TRANSCRIBER_WORKSPACE
    expect(resolveWorkspace(environment)).toEqual({ path: process.cwd(), source: 'cwd' })
    environment.TRANSCRIBER_WORKSPACE = join(root, 'missing')
    expect(await endpoint.workspace(signal())).toEqual({ path: join(root, 'missing'), source: 'env', exists: false, modules: 0 })
    await disk.writeFile(join(root, 'regular'), '')
    environment.TRANSCRIBER_WORKSPACE = join(root, 'regular')
    expect((await endpoint.workspace(signal())).exists).toBe(false)
    environment.TRANSCRIBER_WORKSPACE = join(root, 'regular', 'child')
    expect((await endpoint.workspace(signal())).exists).toBe(false)
  })

  it.each(['malformed', 'relative', 'missing', 'file', 'invalid-fields', 'directory'] as const)(
    'ignores a %s workspace setting and preserves the env fallback', async (kind) => {
      await save({ path: root })
      if (kind === 'malformed') await disk.writeFile(setting(), '{')
      if (kind === 'relative') await save({ path: 'relative' })
      if (kind === 'missing') await save({ path: join(root, 'absent') })
      if (kind === 'file') { await disk.writeFile(join(root, 'file'), ''); await save({ path: join(root, 'file') }) }
      if (kind === 'invalid-fields') await save({ path: 3 })
      if (kind === 'directory') { await disk.rm(setting()); await disk.mkdir(setting()) }
      expect(await endpoint.workspace(signal())).toEqual({ path: root, source: 'env', exists: true, modules: 0 })
    },
  )

  it('creates and atomically replaces settings, and reports only immediate module directories', async () => {
    const path = join(root, 'new library')
    const expected = { path, source: 'file', exists: true, modules: 0 }
    expect(await endpoint.setWorkspace({ path, create: true }, signal())).toEqual(expected)
    expect(JSON.parse(await disk.readFile(setting(), 'utf8'))).toEqual({ path })
    expect((await disk.stat(join(path, 'modules'))).isDirectory()).toBe(true)
    await disk.mkdir(join(path, 'modules', 'toxo', 'Lecture'), { recursive: true })
    await disk.mkdir(join(path, 'modules', 'endo'))
    await disk.writeFile(join(path, 'modules', 'ignored.txt'), '')
    expect(await endpoint.workspace(signal())).toEqual({ ...expected, modules: 2 })
    expect(await endpoint.setWorkspace({ path: root, create: false }, signal())).toEqual({ path: root, source: 'file', exists: true, modules: 0 })
    expect(await disk.readdir(join(root, 'home', 'transcriber'))).toEqual(['workspace.json'])
  })

  it('uses file selection immediately in command construction, reads, and imports', async () => {
    const path = join(root, 'chosen')
    await endpoint.setWorkspace({ path, create: true }, signal())
    await disk.mkdir(join(path, 'modules', 'toxo'))
    await disk.writeFile(join(path, 'modules', 'toxo', 'module.json'), '{}')
    await disk.writeFile(join(path, 'lecture.md'), 'chosen lecture')
    await disk.writeFile(join(root, 'source.pdf'), 'slides')
    const command = buildDoctorCommand('presence', environment, () => true)
    expect(command.cwd).toBe(path)
    expect(command.argv.slice(2, 4)).toEqual(['--workspace', path])
    expect((await endpoint.readFile({ path: 'lecture.md' }, signal())).text).toBe('chosen lecture')
    await endpoint.importFiles({ module: 'toxo', destination: 'Lecture', paths: [join(root, 'source.pdf')] }, signal())
    expect(await disk.readFile(join(path, 'modules', 'toxo', 'Lecture', 'source.pdf'), 'utf8')).toBe('slides')
    const other = join(root, 'other')
    await disk.mkdir(other)
    await disk.writeFile(join(other, 'lecture.md'), 'another lecture')
    await save({ path: other })
    expect((await endpoint.readFile({ path: 'lecture.md' }, signal())).text).toBe('another lecture')
  })

  it('uses the saved library for authentication and dependency installer processes', async () => {
    const path = join(root, 'chosen')
    await endpoint.setWorkspace({ path, create: true }, signal())
    const specs: SubprocessSpawnSpec[] = []
    const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
      specs.push(spec)
      return { stdin: undefined, stdout: undefined, stderr: undefined, collected: {},
        done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true }
    }
    const resolveExecutable = async (command: string): Promise<string> => command
    const auth = new TranscriberEngine(new Context(), { environment, spawn, resolveExecutable })
    expect(await auth.authStatus(signal())).toEqual({ connected: true, reason: 'connected' })
    const installation = runDependencyInstall({
      dependency: { name: 'nlm', install_command: 'pipx install notebooklm-mcp-cli', install_route: 'user' },
      signal: signal(), internals: { environment }, spawn, resolveExecutable,
      reProbe: async () => ({ platform: 'linux', live: false, python: { version: '3.12', minimum_version: '3.10', supported: true },
        dependencies: [], ok: true, exit_code: 0 }),
    })
    const frames = []
    for await (const frame of installation) frames.push(frame)
    expect(frames.some(frame => frame.type === 'settled')).toBe(true)
    expect(specs.map(spec => spec.cwd)).toEqual([path, path])
  })

  it.each(['relative', 'missing', 'file', 'file-create', 'blocked-modules'] as const)('refuses a %s directory without changing the saved workspace', async (kind) => {
    await save({ path: root })
    const file = join(root, 'file')
    await disk.writeFile(file, '')
    const directory = join(root, 'blocked')
    await disk.mkdir(directory)
    await disk.writeFile(join(directory, 'modules'), '')
    const paths = { relative: 'relative', missing: join(root, 'missing'), file, 'file-create': file, 'blocked-modules': directory }
    await expect(endpoint.setWorkspace({ path: paths[kind], create: kind === 'file-create' || kind === 'blocked-modules' }, signal())).rejects.toMatchObject({ code: kind === 'file-create' || kind === 'blocked-modules' ? 'transcriber-engine/workspace-unavailable' : 'gateway/bad-request' })
    expect(JSON.parse(await disk.readFile(setting(), 'utf8'))).toEqual({ path: root })
  })

  it('keeps the old setting and removes staging after a failed rename', async () => {
    await save({ path: root })
    const replacement = join(root, 'replacement')
    await disk.mkdir(replacement)
    vi.spyOn(disk, 'rename').mockRejectedValue(new Error('rename denied'))
    await expect(endpoint.setWorkspace({ path: replacement, create: false }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/workspace-unavailable' })
    expect(JSON.parse(await disk.readFile(setting(), 'utf8'))).toEqual({ path: root })
    expect(await disk.readdir(join(root, 'home', 'transcriber'))).toEqual(['workspace.json'])
  })

  it('reports filesystem inspection errors rather than presenting an empty library', async () => {
    await disk.writeFile(join(root, 'modules'), '')
    await expect(endpoint.workspace(signal())).rejects.toMatchObject({ code: 'transcriber-engine/workspace-unavailable' })
    vi.spyOn(disk, 'stat').mockRejectedValue(Object.assign(new Error('stat denied'), { code: 'EACCES' }))
    await expect(endpoint.workspace(signal())).rejects.toMatchObject({ code: 'transcriber-engine/workspace-unavailable' })
    vi.spyOn(disk, 'stat').mockRejectedValue('stat failed')
    await expect(endpoint.workspace(signal())).rejects.toMatchObject({ code: 'transcriber-engine/workspace-unavailable', details: { detail: 'stat failed' } })
  })

  it.each(['workspace', 'setWorkspace'] as const)('refuses a cancelled %s call before touching disk', async (method) => {
    const abort = new AbortController()
    abort.abort()
    const operation = method === 'workspace' ? endpoint.workspace(abort.signal) : endpoint.setWorkspace({ path: root, create: false }, abort.signal)
    await expect(operation).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(await disk.readdir(root)).toEqual([])
  })

  it('cancels before rename and keeps an already committed setting after cancellation', async () => {
    await save({ path: root })
    const abort = new AbortController()
    const write = disk.writeFile
    vi.spyOn(disk, 'writeFile').mockImplementation(async (...args) => { await write(...args); abort.abort() })
    await expect(endpoint.setWorkspace({ path: root, create: false }, abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(await disk.readdir(join(root, 'home', 'transcriber'))).toEqual(['workspace.json'])
    vi.restoreAllMocks()
    const committed = new AbortController()
    const rename = disk.rename
    vi.spyOn(disk, 'rename').mockImplementation(async (...args) => { await rename(...args); committed.abort() })
    expect(await endpoint.setWorkspace({ path: root, create: false }, committed.signal)).toMatchObject({ path: root, source: 'file' })
    expect(resolveWorkspace(environment).source).toBe('file')
  })

  it('reads default environment selection through the Remote', async () => {
    vi.stubEnv('DSH_HOME', environment.DSH_HOME)
    vi.stubEnv('TRANSCRIBER_WORKSPACE', root)
    expect(await new TranscriberEngine(new Context()).workspace(signal())).toEqual({ path: resolve(root), source: 'env', exists: true, modules: 0 })
  })
})
