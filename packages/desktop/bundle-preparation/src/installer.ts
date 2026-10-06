/** Offline pnpm candidate installation through the existing managed subprocess service. */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { scrubbedParentEnv, type SubprocessRuntime, type SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { boundedFile } from './files.ts'
import type { InstallerConfig, PreparedBundle, PreparedDependencies } from './types.ts'

/**
 * Run deployment-owned JavaScript through the configured Node and drain its process tree.
 * @param subprocess - local managed-process provider.
 * @param config - executable path and process limits.
 * @param args - Node arguments beginning with the trusted entry file.
 * @param cwd - private working directory.
 * @param env - scrubbed process environment.
 * @param signal - whole-operation cancellation.
 * @param subject - diagnostic subject, never child output.
 * @returns Bounded stdout after a normal zero exit; raw stderr is not published.
 * @throws The operation's cancellation reason when a cancelled child's outcome rejects.
 */
export async function runManaged(
  subprocess: SubprocessRuntime, config: InstallerConfig, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, signal: AbortSignal, subject: string,
): Promise<string> {
  signal.throwIfAborted()
  const child = subprocess.spawn({ argv: [config.nodeExecutable, ...args], cwd, env, graceMs: config.graceMs, signal,
    stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } } })
  try {
    const result = await child.done.catch((error: unknown) => {
      signal.throwIfAborted()
      throw error
    })
    signal.throwIfAborted()
    if (result.exitCode !== 0 || result.signal !== null) throw new Error(`bundle preparation: ${subject} failed; candidate was not enabled`)
    // This spawn explicitly requests collected stdout.
    const output = (child.collected.stdout as SubprocessOutputReader).readFrom(0)
    if (output.lossy) throw new Error('bundle preparation: package manager output exceeded its retained limit')
    return output.text.trim()
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}

/**
 * Remove all inherited entries except Windows OS locations, then supply private installer paths.
 * @param home - exclusively owned operation directory.
 * @param node - deployment-owned absolute Node path.
 * @returns An explicit subprocess overlay including tombstones for ambient values.
 */
export function installerEnvironment(home: string, node: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(scrubbedParentEnv())
    .map(([key, value]) => [key, /^(SYSTEMROOT|WINDIR|COMSPEC)$/iu.test(key) ? value : undefined]))
  return { ...env, HOME: home, USERPROFILE: home, PATH: dirname(node), TMP: home, TEMP: home, TMPDIR: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home,
    CI: 'true', npm_config_userconfig: join(home, 'empty.npmrc'), npm_config_globalconfig: join(home, 'global.npmrc'),
    npm_config_manage_package_manager_versions: 'false', npm_config_update_notifier: 'false',
    npm_config_ignore_scripts: 'true', npm_config_ignore_pnpmfile: 'true', npm_config_offline: 'true',
    npm_config_registry: 'http://127.0.0.1:1', npm_config_store_dir: join(home, 'store'),
    npm_config_cache_dir: join(home, 'cache'), npm_config_state_dir: join(home, 'state'),
  }
}

/**
 * Install one freshly verified tarball into a private, non-Profile project with no downloads or scripts.
 * The caller owns cleanup of the complete operation directory and cancellation.
 * @param subprocess - local execution-world provider matching the filesystem.
 * @param config - exact package-manager paths, version and process budgets.
 * @param prepared - freshly staged artifact owned by the calling operation.
 * @param signal - operation cancellation, including its whole-operation deadline.
 * @returns Candidate metadata after pnpm and installed identity verification; no activation occurs.
 */
export async function installCandidate(
  subprocess: SubprocessRuntime, config: InstallerConfig, prepared: PreparedBundle, signal: AbortSignal,
): Promise<PreparedDependencies> {
  const root = dirname(prepared.artifactPath)
  const home = join(root, 'installer-home')
  const candidateDirectory = join(root, 'candidate')
  await mkdir(home, { mode: 0o700 })
  await mkdir(candidateDirectory, { mode: 0o700 })
  await writeFile(join(home, 'empty.npmrc'), '', { flag: 'wx', mode: 0o600 })
  await writeFile(join(home, 'global.npmrc'), '', { flag: 'wx', mode: 0o600 })
  await writeFile(join(candidateDirectory, 'package.json'), JSON.stringify({ private: true, name: 'dsh-bundle-candidate', version: '0.0.0' }), { flag: 'wx', mode: 0o600 })
  const env = installerEnvironment(home, config.nodeExecutable)
  const run = (args: string[]): Promise<string> => runManaged(subprocess, config, [config.packageManagerEntry, ...args],
    candidateDirectory, env, signal, 'package manager')
  if (await run(['--version']) !== config.packageManagerVersion) throw new Error('bundle preparation: package manager version mismatch')
  await run(['add', `file:${prepared.artifactPath}`, '--offline', '--ignore-scripts', '--ignore-pnpmfile', '--ignore-workspace',
    '--config.auto-install-peers=false', '--config.package-import-method=copy', '--config.node-linker=isolated',
    '--config.manage-package-manager-versions=false', '--config.package-manager-strict=false', '--reporter=silent'])
  const packageDirectory = await realpath(join(candidateDirectory, 'node_modules', prepared.entry.packageName))
  const within = relative(await realpath(candidateDirectory), packageDirectory)
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('bundle preparation: installed package escaped its candidate directory')
  const installed = z.object({ name: z.literal(prepared.entry.packageName), version: z.literal(prepared.entry.version) })
  installed.parse(JSON.parse((await boundedFile(join(packageDirectory, 'package.json'), config.maxManifestBytes)).toString('utf8')))
  const lockfilePath = join(candidateDirectory, 'pnpm-lock.yaml')
  await boundedFile(lockfilePath, config.maxManifestBytes)
  signal.throwIfAborted()
  return { schemaVersion: 1, state: 'dependencies-prepared-not-enabled', prepared, candidateDirectory, packageDirectory,
    lockfilePath, receiptPath: join(root, 'dependencies.json'), packageManagerVersion: config.packageManagerVersion }
}
