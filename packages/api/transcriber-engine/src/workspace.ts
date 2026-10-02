/** Live workspace selection and atomic persistence for session-free library setup. */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { TranscriberSetWorkspaceRequest, TranscriberWorkspace } from './types.ts'

const savedWorkspace = z.object({ path: z.string().refine(isAbsolute) })
const setWorkspaceRequest = savedWorkspace.extend({ create: z.boolean() })
type WorkspaceSelection = Pick<TranscriberWorkspace, 'path' | 'source'>

/**
 * Locate the engine's workspace setting under the Harness home.
 * @param environment - Host environment or the test's isolated environment.
 * @returns absolute path to transcriber/workspace.json.
 */
export function workspaceFilePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.DSH_HOME
  const home = configured !== undefined && configured.trim() !== '' ? configured : join(homedir(), '.dsh')
  const expanded = home === '~' ? homedir() : home.startsWith('~/') || home.startsWith('~\\') ? join(homedir(), home.slice(2)) : home
  return resolve(expanded, 'transcriber', 'workspace.json')
}

/**
 * Select the workspace on each operation, matching the engine's saved-file fallback.
 * @param environment - environment carrying DSH_HOME and TRANSCRIBER_WORKSPACE.
 * @returns absolute workspace path and the source that won; unreadable or invalid settings fall back.
 */
export function resolveWorkspace(environment: NodeJS.ProcessEnv = process.env): WorkspaceSelection {
  const fallback: WorkspaceSelection = environment.TRANSCRIBER_WORKSPACE
    ? { path: resolve(environment.TRANSCRIBER_WORKSPACE), source: 'env' }
    : { path: process.cwd(), source: 'cwd' }
  try {
    const parsed = savedWorkspace.safeParse(JSON.parse(readFileSync(workspaceFilePath(environment), 'utf8')) as unknown)
    if (parsed.success && statSync(parsed.data.path).isDirectory()) return { path: parsed.data.path, source: 'file' }
  } catch {
    return fallback
  }
  return fallback
}

/**
 * Resolve the workspace before applying an operation's path policy.
 * @param environment - Host environment or a test's isolated environment.
 * @returns the selected absolute workspace path.
 */
export function engineWorkspacePath(environment?: NodeJS.ProcessEnv): string {
  return resolveWorkspace(environment).path
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
}

function unavailableWorkspace(error: unknown): never {
  if (error instanceof RemoteError) throw error
  const detail = error instanceof Error ? error.message : String(error)
  throw new RemoteError('transcriber-engine/workspace-unavailable', `Workspace operation failed: ${detail}`, { detail })
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false
    throw error
  }
}

async function describeWorkspace(selection: WorkspaceSelection): Promise<TranscriberWorkspace> {
  const exists = await directoryExists(selection.path)
  let modules = 0
  if (exists) {
    try {
      modules = (await readdir(join(selection.path, 'modules'), { withFileTypes: true })).filter(entry => entry.isDirectory()).length
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return { ...selection, exists, modules }
}

/**
 * Read the selected library directory and count its immediate module directories.
 * @param signal - caller cancellation.
 * @param environment - Host environment or a test's isolated environment.
 * @returns live path, winning source, directory existence, and module count.
 */
export async function runWorkspace(signal: AbortSignal, environment?: NodeJS.ProcessEnv): Promise<TranscriberWorkspace> {
  checkCancelled(signal)
  try {
    const workspace = await describeWorkspace(resolveWorkspace(environment))
    checkCancelled(signal)
    return workspace
  } catch (error: unknown) {
    return unavailableWorkspace(error)
  }
}

/**
 * Persist a student-selected library directory using a same-directory atomic rename.
 * @param request - absolute directory and permission to create it and modules/.
 * @param signal - cancellation before rename; committed settings cannot be undone by cancellation.
 * @param environment - Host environment or a test's isolated environment.
 * @returns the saved directory's status; directories created before a refusal remain on disk.
 */
export async function runSetWorkspace(
  request: TranscriberSetWorkspaceRequest, signal: AbortSignal, environment?: NodeJS.ProcessEnv,
): Promise<TranscriberWorkspace> {
  const parsed = setWorkspaceRequest.safeParse(request)
  if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Workspace requires an absolute path and a create boolean', {})
  checkCancelled(signal)
  const path = resolve(parsed.data.path)
  const file = workspaceFilePath(environment)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    if (parsed.data.create) await mkdir(join(path, 'modules'), { recursive: true })
    if (!await directoryExists(path)) throw new RemoteError('gateway/bad-request', 'Workspace must be an existing directory', {})
    const workspace = await describeWorkspace({ path, source: 'file' })
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify({ path }) + '\n', { flag: 'wx', mode: 0o600, signal })
    checkCancelled(signal)
    await rename(temporary, file)
    return workspace
  } catch (error: unknown) {
    checkCancelled(signal)
    return unavailableWorkspace(error)
  } finally {
    await rm(temporary, { force: true }).catch(unavailableWorkspace)
  }
}
