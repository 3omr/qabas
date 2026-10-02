/** Host-side dependency installation routes and streamed process handling. */

import { Buffer } from 'node:buffer'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { engineWorkspacePath } from './workspace.ts'
import type {
  SubprocessHandle, SubprocessSpawnSpec, SubprocessOutputMode,
} from '@deepseek-ai/dsh-subprocess'
import type {
  TranscriberDependencyReport, TranscriberDoctorReport, TranscriberInstallFailureCode,
  TranscriberInstallFrame, TranscriberInstallLauncher, TranscriberInstallRoute,
} from './types.ts'

/** Process seams used by install tests without starting a package manager. */
export interface TranscriberInstallInternals {
  /** Environment entries used for executable lookup and child processes. */
  readonly environment?: NodeJS.ProcessEnv
  /** Executable lookup in the subprocess provider's execution world. */
  readonly resolveExecutable?: (
    command: string,
    environment?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<string>
  /** Process spawn seam used by fake install tests. */
  readonly spawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle
}

/** Inputs for one app-managed dependency installation. */
export interface TranscriberInstallExecution {
  readonly dependency: Pick<TranscriberDependencyReport, 'name' | 'install_command' | 'install_route'>
  readonly signal: AbortSignal
  readonly internals: TranscriberInstallInternals
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly resolveExecutable: TranscriberInstallInternals['resolveExecutable']
  readonly reProbe: (signal: AbortSignal) => Promise<TranscriberDoctorReport>
}

/** Terminal launchers tried when Linux has no graphical `pkexec` agent. */
export const TERMINAL_LAUNCHERS = [
  'gnome-terminal',
  'konsole',
  'xfce4-terminal',
  'x-terminal-emulator',
  'mate-terminal',
  'tilix',
  'kitty',
  'alacritty',
  'foot',
  'qterminal',
  'lxterminal',
] as const

const INSTALL_GRACE_MS = 5000
const PACKAGE_MANAGERS = new Set([
  'apt', 'apt-get', 'apk', 'choco', 'dnf', 'pacman', 'winget', 'yum', 'zypper',
])
const USER_MANAGERS = new Set(['brew', 'pipx', 'uv'])
const NON_INTERACTIVE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  apt: ['-y'],
  'apt-get': ['-y'],
  choco: ['-y'],
  dnf: ['-y'],
  pacman: ['--noconfirm'],
  winget: ['--accept-source-agreements', '--accept-package-agreements'],
  yum: ['-y'],
  zypper: ['--non-interactive'],
}
const TERMINAL_SCRIPT = [
  'read -e -r -p "$ " -i "$1" command',
  'status=0',
  'if [[ -n "$command" ]]; then bash -lc "$command"; status=$?; fi',
  'printf "\\nPress Enter to close this window... "',
  'read -r',
  'exit "$status"',
].join('; ')

type InstallAction = {
  readonly route: TranscriberInstallRoute
  readonly command: string
  readonly argv: readonly string[] | undefined
  readonly manager: string | undefined
}

type ResolvedInstallCommand = {
  readonly managerPath: string
  readonly argv: readonly string[]
}

type InstallProcessResult = {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

type InstallRuntime = Omit<TranscriberInstallExecution, 'dependency' | 'resolveExecutable'> & {
  readonly resolveExecutable: NonNullable<TranscriberInstallInternals['resolveExecutable']>
}

/**
 * Add the Host-owned route field to one engine dependency report.
 *
 * The dependency's name is deliberately not a parameter. The route follows
 * from the command alone, so no tool can be routed by being recognised.
 * @param command - platform-specific install command from the engine report.
 * @returns the route the Host can expose to the Client.
 */
export function installRouteOf(command: string | null): TranscriberInstallRoute {
  // No dependency is named here. The engine states one executable command per
  // platform, and the manager leading it decides the route -- `pipx` and `brew`
  // install into the user's own home and need no prompt, `apt` and `winget`
  // need root. A tool the engine describes some other way falls to 'manual'
  // and is shown as text rather than run blind.
  const tokens = command === null ? undefined : parseCommand(command)
  const manager = tokens === undefined ? undefined : packageManagerOf(tokens)
  if (manager === undefined) return 'manual'
  return USER_MANAGERS.has(manager) ? 'user' : 'privileged'
}

/**
 * Run one declared dependency installation and re-probe it before settling.
 * @param execution - dependency, process seams, cancellation, and fresh doctor callback.
 * @returns streamed route, output, and settlement frames.
 */
export async function* runDependencyInstall(
  execution: TranscriberInstallExecution,
): AsyncIterable<TranscriberInstallFrame> {
  const { dependency, signal, internals, spawn, resolveExecutable, reProbe } = execution
  signal.throwIfAborted()
  const action = installAction(dependency)
  if (action.route === 'manual' || action.argv === undefined) {
    yield plan(action, 'copy')
    yield failed('unsupported-tool')
    return
  }
  if (resolveExecutable === undefined) {
    yield plan(action, 'copy', action.manager)
    yield failed(action.manager === 'pipx' ? 'pipx-missing' : 'package-manager-missing')
    return
  }
  if (action.route === 'user') {
    yield* runUserInstall(action, dependency.name, { signal, internals, spawn, resolveExecutable, reProbe })
    return
  }
  yield* runPrivilegedInstall(action, dependency.name, { signal, internals, spawn, resolveExecutable, reProbe })
}

function installAction(
  dependency: Pick<TranscriberDependencyReport, 'name' | 'install_command' | 'install_route'>,
): InstallAction {
  const tokens = dependency.install_command === null ? undefined : parseCommand(dependency.install_command)
  const manager = tokens === undefined ? undefined : packageManagerOf(tokens)
  if (tokens === undefined || manager === undefined || dependency.install_route === 'manual') {
    return { route: 'manual', command: dependency.install_command ?? '', argv: undefined, manager }
  }
  const argv = nonInteractiveArgs(manager, removePrivilegePrefix(tokens))
  return {
    route: dependency.install_route,
    command: dependency.install_route === 'privileged' ? renderCommand(argv) : dependency.install_command ?? '',
    argv,
    manager,
  }
}

async function* runUserInstall(
  action: InstallAction,
  dependencyName: string,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal, internals, resolveExecutable } = runtime
  const manager = action.manager ?? action.argv?.[0]
  if (manager === undefined) {
    yield plan(action, 'copy')
    yield failed('unsupported-tool')
    return
  }
  const executable = await resolveOptional(resolveExecutable, manager, internals, signal)
  if (executable === undefined) {
    yield plan(action, 'copy', manager)
    yield failed(manager === 'pipx' ? 'pipx-missing' : 'package-manager-missing')
    return
  }
  yield plan(action, 'in-process')
  yield* runCapturedProcess(
    { ...action, argv: [executable, ...(action.argv?.slice(1) ?? [])] },
    dependencyName,
    runtime,
  )
}

async function* runPrivilegedInstall(
  action: InstallAction,
  dependencyName: string,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal, internals, resolveExecutable } = runtime
  const manager = action.manager
  const argv = action.argv
  if (manager === undefined || argv === undefined) {
    yield plan(action, 'copy')
    yield failed('unsupported-tool')
    return
  }
  const managerPath = await resolveOptional(resolveExecutable, manager, internals, signal)
  if (managerPath === undefined) {
    yield plan(action, 'copy', manager)
    yield failed('package-manager-missing')
    return
  }
  const pkexec = await resolveOptional(resolveExecutable, 'pkexec', internals, signal)
  if (pkexec !== undefined) {
    yield plan(action, 'pkexec')
    yield* runCapturedProcess(
      { ...action, argv: [pkexec, managerPath, ...argv.slice(1)] },
      dependencyName,
      runtime,
    )
    return
  }
  yield* runTerminalFallback(action, dependencyName, { managerPath, argv }, runtime)
}

async function* runTerminalFallback(
  action: InstallAction,
  dependencyName: string,
  resolvedCommand: ResolvedInstallCommand,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal, internals, resolveExecutable } = runtime
  const { managerPath, argv } = resolvedCommand
  const sudo = await resolveOptional(resolveExecutable, 'sudo', internals, signal)
  if (sudo === undefined) {
    yield plan(action, 'copy', 'pkexec and sudo')
    yield failed('pkexec-missing')
    return
  }
  const terminal = await firstTerminal(resolveExecutable, internals, signal)
  if (terminal === undefined) {
    yield plan({ ...action, command: `${sudo} ${renderCommand([managerPath, ...argv.slice(1)])}` }, 'copy', 'terminal emulator')
    yield failed('terminal-missing')
    return
  }
  const command = `${sudo} ${renderCommand([managerPath, ...argv.slice(1)])}`
  yield plan({ ...action, command }, 'terminal', undefined, terminal.name)
  let handle: SubprocessHandle
  try {
    handle = spawnTerminal(terminal, command, runtime)
  } catch {
    yield plan({ ...action, command }, 'copy', terminal.name)
    yield failed('process-failed')
    return
  }
  yield* settleTerminal(handle, dependencyName, runtime)
}

async function* runCapturedProcess(
  action: InstallAction,
  dependencyName: string,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal, internals, spawn } = runtime
  const argv = action.argv
  if (argv === undefined) {
    yield failed('unsupported-tool')
    return
  }
  let handle: SubprocessHandle
  try {
    handle = spawn(processSpec(argv, signal, 'pipe', internals))
  } catch {
    yield failed('process-failed')
    return
  }
  try {
    yield* streamProcess(handle, signal)
    const outcome = await settleProcess(handle, signal)
    yield* finishInstall(outcome, dependencyName, runtime)
  } catch {
    if (signal.aborted) throw cancelled()
    yield failed('process-failed')
  }
}

function spawnTerminal(
  terminal: TerminalLauncher,
  command: string,
  runtime: InstallRuntime,
): SubprocessHandle {
  const { internals, signal, spawn } = runtime
  return spawn({
    argv: terminalArgv(terminal, command),
    cwd: engineWorkspacePath(internals.environment),
    stdio: { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    graceMs: INSTALL_GRACE_MS,
    signal,
    env: internals.environment,
  })
}

async function* settleTerminal(
  handle: SubprocessHandle,
  dependencyName: string,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal } = runtime
  try {
    const outcome = await settleProcess(handle, signal)
    yield* finishInstall(outcome, dependencyName, runtime)
  } catch {
    if (signal.aborted) throw cancelled()
    yield failed('process-failed')
  }
}

async function* finishInstall(
  outcome: InstallProcessResult,
  dependencyName: string,
  runtime: InstallRuntime,
): AsyncIterable<TranscriberInstallFrame> {
  const { signal, reProbe } = runtime
  if (outcome.exitCode !== 0 || outcome.signal !== null) {
    yield { type: 'settled', outcome: 'failed', reason: 'process-failed', exit_code: outcome.exitCode }
    return
  }
  let report: TranscriberDoctorReport
  try {
    report = await reProbe(signal)
  } catch {
    if (signal.aborted) throw cancelled()
    yield failed('probe-failed')
    return
  }
  const installed = report.dependencies.some(dependency => dependency.name === dependencyName && dependency.resolved)
  yield installed
    ? { type: 'settled', outcome: 'installed', report }
    : { type: 'settled', outcome: 'failed', reason: 'probe-failed', report }
}

async function settleProcess(handle: SubprocessHandle, signal: AbortSignal): Promise<InstallProcessResult> {
  let outcome
  try {
    outcome = await handle.done
    if (!await handle.waitForExit(signal)) throw cancelled()
  } catch (error: unknown) {
    if (signal.aborted) throw cancelled()
    throw error
  }
  if (signal.aborted) throw cancelled()
  return outcome
}

async function* streamProcess(handle: SubprocessHandle, signal: AbortSignal): AsyncIterable<TranscriberInstallFrame> {
  const streams: Array<{ readonly stream: Readable; readonly channel: 'stdout' | 'stderr' }> = []
  if (handle.stdout !== undefined) streams.push({ stream: handle.stdout, channel: 'stdout' })
  if (handle.stderr !== undefined) streams.push({ stream: handle.stderr, channel: 'stderr' })
  const queue: Array<{ readonly stream: 'stdout' | 'stderr'; readonly text: string }> = []
  let remaining = streams.length
  let wake: (() => void) | undefined
  let failure: unknown
  const pumps = streams.map(({ stream, channel }) => pump(
    stream,
    channel,
    queue,
    () => { remaining -= 1; wake?.() },
    () => { wake?.() },
  ).catch((error: unknown) => { failure ??= error; wake?.() }))
  try {
    while (remaining > 0 || queue.length > 0) {
      signal.throwIfAborted()
      while (queue.length > 0) {
        const chunk = queue.shift()
        if (chunk !== undefined) yield { type: 'output', stream: chunk.stream, text: chunk.text }
      }
      if (remaining > 0) await new Promise<void>((resolve) => { wake = resolve })
    }
    await Promise.all(pumps)
  } finally {
    if (signal.aborted) {
      for (const { stream } of streams) stream.destroy()
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new Error(typeof failure === 'string' ? failure : JSON.stringify(failure))
  }
}

async function pump(
  stream: Readable,
  channel: 'stdout' | 'stderr',
  queue: Array<{ readonly stream: 'stdout' | 'stderr'; readonly text: string }>,
  close: () => void,
  wake: () => void,
): Promise<void> {
  const decoder = new StringDecoder('utf8')
  try {
    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      const text = decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      if (text.length > 0) { queue.push({ stream: channel, text }); wake() }
    }
    const tail = decoder.end()
    if (tail.length > 0) { queue.push({ stream: channel, text: tail }); wake() }
  } finally {
    close()
  }
}

async function firstTerminal(
  resolveExecutable: NonNullable<TranscriberInstallInternals['resolveExecutable']>,
  internals: TranscriberInstallInternals,
  signal: AbortSignal,
): Promise<TerminalLauncher | undefined> {
  for (const name of TERMINAL_LAUNCHERS) {
    const path = await resolveOptional(resolveExecutable, name, internals, signal)
    if (path !== undefined) return { name, path }
  }
  return undefined
}

async function resolveOptional(
  resolveExecutable: NonNullable<TranscriberInstallInternals['resolveExecutable']>,
  command: string,
  internals: TranscriberInstallInternals,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return await resolveExecutable(command, internals.environment, signal)
  } catch {
    if (signal.aborted) throw cancelled()
    return undefined
  }
}

function processSpec(
  argv: readonly string[],
  signal: AbortSignal,
  stdout: SubprocessOutputMode,
  internals: TranscriberInstallInternals,
): SubprocessSpawnSpec {
  return {
    argv,
    cwd: engineWorkspacePath(internals.environment),
    stdio: { stdin: 'ignore', stdout, stderr: stdout },
    graceMs: INSTALL_GRACE_MS,
    signal,
    env: internals.environment,
  }
}

function plan(
  action: InstallAction,
  launcher: TranscriberInstallLauncher,
  prerequisite?: string,
  terminal?: string,
): TranscriberInstallFrame {
  return {
    type: 'plan',
    route: action.route,
    launcher,
    command: action.command,
    ...(prerequisite === undefined ? {} : { prerequisite }),
    ...(terminal === undefined ? {} : { terminal }),
  }
}

function failed(reason: TranscriberInstallFailureCode): TranscriberInstallFrame {
  return { type: 'settled', outcome: 'failed', reason }
}

/**
 * Name the installer leading a command, whether or not it needs elevation.
 *
 * Both sets belong here. Reading only the privileged set made every
 * user-scope installer -- `pipx`, and `brew`, which is how macOS installs all
 * of ffmpeg, poppler, ghostscript and ocrmypdf -- look like no installer at
 * all, so they fell to 'manual' and were printed for the student to type.
 * @param tokens - the install command, already split.
 * @returns the installer's name, or undefined if it leads with something else.
 */
function packageManagerOf(tokens: readonly string[]): string | undefined {
  const command = removePrivilegePrefix(tokens)[0]
  if (command === undefined) return undefined
  const manager = basename(command)
  return PACKAGE_MANAGERS.has(manager) || USER_MANAGERS.has(manager) ? manager : undefined
}

function removePrivilegePrefix(tokens: readonly string[]): readonly string[] {
  let offset = 0
  while (tokens[offset] === 'sudo' || tokens[offset] === 'pkexec') offset += 1
  return tokens.slice(offset)
}

function nonInteractiveArgs(manager: string, argv: readonly string[]): readonly string[] {
  const flags = NON_INTERACTIVE_FLAGS[manager]
  if (flags === undefined || flags.every(flag => argv.includes(flag))) return argv
  const [program, ...arguments_] = argv
  if (program === undefined) return argv
  return [program, ...flags.filter(flag => !argv.includes(flag)), ...arguments_]
}

function parseCommand(command: string): readonly string[] | undefined {
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) { token += character; escaped = false; continue }
    if (character === '\\' && quote !== 'single') { escaped = true; continue }
    if (quote === 'single') { if (character === "'") quote = undefined; else token += character; continue }
    if (quote === 'double') { if (character === '"') quote = undefined; else token += character; continue }
    if (character === "'") { quote = 'single'; continue }
    if (character === '"') { quote = 'double'; continue }
    if (/\s/u.test(character)) { if (token.length > 0) { tokens.push(token); token = '' }; continue }
    if (';&|<>`$'.includes(character)) return undefined
    token += character
  }
  if (escaped || quote !== undefined) return undefined
  if (token.length > 0) tokens.push(token)
  return tokens.length > 0 ? tokens : undefined
}

function renderCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+@%-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

type TerminalLauncher = { readonly name: string; readonly path: string }

function terminalArgv(terminal: TerminalLauncher, command: string): readonly string[] {
  const shell = ['bash', '-lc', TERMINAL_SCRIPT, 'dsh-install', command]
  if (terminal.name === 'gnome-terminal') return [terminal.path, '--', ...shell]
  if (terminal.name === 'konsole') return [terminal.path, '-e', ...shell]
  if (terminal.name === 'xfce4-terminal') return [terminal.path, '--command', shell.map(shellQuote).join(' ')]
  return [terminal.path, '-e', ...shell]
}

function cancelled(): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
}
