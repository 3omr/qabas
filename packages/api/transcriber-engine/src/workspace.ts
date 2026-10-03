/** Fixed app library location and its session-free local inventory. */

import { mkdirSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { TranscriberWorkspace } from './types.ts'

type WorkspaceSelection = Pick<TranscriberWorkspace, 'path' | 'source'>

/**
 * Locate Qabas Library under the operating-system user's home.
 * @param environment - process environment, or an isolated Host test environment.
 * @returns the default absolute directory, independent of cwd and DSH_HOME.
 */
export function defaultLibraryPath(environment: NodeJS.ProcessEnv = process.env): string {
  const home = process.platform === 'win32'
    ? environment.USERPROFILE ?? (environment.HOMEDRIVE && environment.HOMEPATH ? environment.HOMEDRIVE + environment.HOMEPATH : homedir())
    : environment.HOME ?? homedir()
  return resolve(home, 'Qabas Library')
}

/**
 * Select the developer override or the app's fixed library directory.
 * @param environment - Host environment; saved workspace selections are not read.
 * @returns absolute path and its source.
 */
export function resolveWorkspace(environment: NodeJS.ProcessEnv = process.env): WorkspaceSelection {
  const supplied = environment.TRANSCRIBER_WORKSPACE?.trim()
  return supplied ? { path: resolve(supplied), source: 'env' } : { path: defaultLibraryPath(environment), source: 'default' }
}

/**
 * Resolve the workspace before applying an operation's path policy.
 * @param environment - Host environment or isolated test environment.
 * @returns the selected absolute workspace path.
 */
export function engineWorkspacePath(environment?: NodeJS.ProcessEnv): string {
  return resolveWorkspace(environment).path
}

/**
 * Prepare a real engine process's working directory synchronously.
 * @param environment - Host environment or isolated test environment.
 * @returns the directory supplied to the process.
 */
export function prepareWorkspace(environment?: NodeJS.ProcessEnv): string {
  const path = engineWorkspacePath(environment)
  mkdirSync(join(path, 'modules'), { recursive: true })
  return path
}

/**
 * Create the library on first use and count immediate module directories.
 * @param signal - caller cancellation.
 * @param environment - Host environment or isolated test environment.
 * @returns live path, source, existence, and module count.
 */
export async function runWorkspace(signal: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<TranscriberWorkspace> {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
  try {
    const selection = resolveWorkspace(environment)
    await mkdir(join(selection.path, 'modules'), { recursive: true })
    const entries = await readdir(join(selection.path, 'modules'), { withFileTypes: true })
    if (signal.aborted) throw new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
    return { ...selection, exists: true, modules: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).length }
  } catch (error: unknown) {
    if (error instanceof RemoteError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new RemoteError('transcriber-engine/workspace-unavailable', `Library operation failed: ${detail}`, { detail })
  }
}
