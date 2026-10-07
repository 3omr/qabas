/** Fixed app library location and its session-free local inventory. */

import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveQabasLibrary } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { buildEngineCommand, readCollected, type TranscriberDoctorInternals } from './doctor.ts'
import type { TranscriberWorkspace } from './types.ts'

type WorkspaceSelection = Pick<TranscriberWorkspace, 'path' | 'source'>

/**
 * Locate Qabas Library under the operating-system user's home.
 * @param environment - process environment, or an isolated Host test environment.
 * @returns the default absolute directory, independent of cwd and DSH_HOME.
 */
export function defaultLibraryPath(environment: NodeJS.ProcessEnv = process.env): string {
  return resolveQabasLibrary({ ...environment, TRANSCRIBER_WORKSPACE: undefined })
}

/**
 * Select the developer override or the app's fixed library directory.
 * @param environment - Host environment; saved workspace selections are not read.
 * @returns absolute path and its source.
 */
export function resolveWorkspace(environment: NodeJS.ProcessEnv = process.env): WorkspaceSelection {
  const supplied = environment.TRANSCRIBER_WORKSPACE?.trim()
  return { path: resolveQabasLibrary(environment), source: supplied ? 'env' : 'default' }
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
  if (resolveWorkspace(environment).source === 'default') {
    for (let candidate = join(path, 'modules'); candidate !== dirname(candidate); candidate = dirname(candidate)) {
      let metadata
      try { metadata = lstatSync(candidate) } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        throw error
      }
      if (metadata.isSymbolicLink()) {
        throw new Error(`Library preparation refuses symlink or junction: ${candidate}`)
      }
    }
  }
  mkdirSync(join(path, 'modules'), { recursive: true })
  return path
}

/**
 * Adopt legacy modules through the engine before publishing library readiness.
 * @param signal - request or service-lifetime cancellation.
 * @param internals - engine resolution and test environment.
 * @param spawn - Host subprocess provider.
 * @param limits - deployment output cap, termination grace, and existing module-operation deadline.
 * @returns after the engine has retained the originals and checkpointed its copies.
 */
export async function adoptLegacyModules(
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  limits: { readonly mcpOutputMaxBytes: number; readonly mcpGraceMs: number; readonly createModuleTimeoutMs: number },
): Promise<void> {
  throwIfCancelled(signal)
  const selection = resolveWorkspace(internals.environment)
  if (selection.source === 'env' || !existsSync(join(selection.path, '..', '..', 'Qabas Library', 'modules'))) return
  const command = buildEngineCommand('prepare_workspace.py', [], internals.environment, internals.fileExists)
  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => { deadline.abort() }, limits.createModuleTimeoutMs)
  try {
    const environment = internals.environment ?? process.env
    const handle = spawn({
      argv: command.argv,
      cwd: command.cwd,
      env: { HOME: environment.HOME, USERPROFILE: environment.USERPROFILE, TRANSCRIBER_WORKSPACE: environment.TRANSCRIBER_WORKSPACE },
      stdio: { stdin: 'ignore', stdout: { maxBytes: limits.mcpOutputMaxBytes }, stderr: { maxBytes: limits.mcpOutputMaxBytes } },
      graceMs: limits.mcpGraceMs,
      signal: combined,
    })
    const outcome = await handle.done
    await handle.waitForExit()
    throwIfCancelled(signal)
    if (deadline.signal.aborted) throw new Error(`Legacy module adoption timed out after ${limits.createModuleTimeoutMs} ms`)
    if (outcome.exitCode !== 0) throw new Error(readCollected(handle.collected.stderr) || `Legacy module adoption exited with ${outcome.exitCode}`)
  } catch (error: unknown) {
    throwIfCancelled(signal)
    const detail = error instanceof Error ? error.message : String(error)
    throw new RemoteError('transcriber-engine/workspace-unavailable', `Library operation failed: ${detail}`, { detail })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Refuse a cancelled operation with the gateway's cancellation error.
 * @param signal - caller cancellation, read again after each await.
 */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
}

/**
 * Create the library on first use and count immediate module directories.
 * @param signal - caller cancellation.
 * @param environment - Host environment or isolated test environment.
 * @param prepare - engine preparation completed before inventory reads.
 * @returns live path, source, existence, and module count.
 */
export async function runWorkspace(
  signal: AbortSignal,
  environment?: NodeJS.ProcessEnv,
  prepare?: () => Promise<void>,
): Promise<TranscriberWorkspace> {
  throwIfCancelled(signal)
  try {
    const selection = resolveWorkspace(environment)
    prepareWorkspace(environment)
    await prepare?.()
    const entries = await readdir(join(selection.path, 'modules'), { withFileTypes: true })
    throwIfCancelled(signal)
    return { ...selection, exists: true, modules: entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).length }
  } catch (error: unknown) {
    if (error instanceof RemoteError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new RemoteError('transcriber-engine/workspace-unavailable', `Library operation failed: ${detail}`, { detail })
  }
}
