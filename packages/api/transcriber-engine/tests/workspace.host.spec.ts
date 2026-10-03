/** Fixed libraries are created on first use; explicit developer overrides remain isolated. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TranscriberEngine } from '../src/index.ts'
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

describe('fixed app library', () => {
  it('ignores a saved selection and creates the default library and modules on first use', async () => {
    const old = join(root, 'selected')
    await mkdir(old)
    const pointer = join(environment.DSH_HOME as string, 'transcriber', 'workspace.json')
    await mkdir(join(environment.DSH_HOME as string, 'transcriber'), { recursive: true })
    await writeFile(pointer, JSON.stringify({ path: old }))
    expect(resolveWorkspace(environment)).toEqual({ path: join(root, 'Qabas Library'), source: 'default' })
    expect(await endpoint().workspace(signal())).toEqual({ path: join(root, 'Qabas Library'), source: 'default', exists: true, modules: 0 })
    await mkdir(join(defaultLibraryPath(environment), 'modules', 'surgery'))
    await mkdir(join(defaultLibraryPath(environment), 'modules', '.temporary'))
    expect((await endpoint().workspace(signal())).modules).toBe(1)
    expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ path: old })
  })

  it('creates an explicit override and ignores blank overrides', async () => {
    environment.TRANSCRIBER_WORKSPACE = join(root, 'developer-library')
    expect(await endpoint().workspace(signal())).toEqual({ path: environment.TRANSCRIBER_WORKSPACE, source: 'env', exists: true, modules: 0 })
    environment.TRANSCRIBER_WORKSPACE = '   '
    expect(resolveWorkspace(environment)).toEqual({ path: join(root, 'Qabas Library'), source: 'default' })
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
    if (target === 'modules') await mkdir(library)
    await writeFile(target === 'modules' ? join(library, 'modules') : library, 'occupied')
    await expect(endpoint().workspace(signal())).rejects.toHaveProperty('code', 'transcriber-engine/workspace-unavailable')
  })

  it('refuses cancellation before creating the library', async () => {
    const cancellation = new AbortController()
    cancellation.abort()
    await expect(endpoint().workspace(cancellation.signal)).rejects.toHaveProperty('code', 'gateway/cancelled')
  })
})
