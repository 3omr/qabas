/** Command construction, process execution, and validation for the engine doctor. */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { TranscriberAuthTerminal } from './auth.ts'
import { installRouteOf, type TranscriberInstallInternals } from './install.ts'
import type { TranscriberDoctorReport, TranscriberDoctorRequest } from './types.ts'
import { engineWorkspacePath, prepareWorkspace } from './workspace.ts'

/** The two engine modes exposed by the settings page. */
export type TranscriberDoctorMode = 'presence' | 'live'

/** Spawn details for one doctor invocation. */
export interface TranscriberDoctorCommand {
  readonly argv: readonly string[]
  readonly cwd: string
}

/** Boundary replacements used by host tests without starting a child process. */
export interface TranscriberDoctorInternals extends TranscriberInstallInternals {
  /** Environment layer carrying the engine and workspace paths. */
  readonly environment?: NodeJS.ProcessEnv
  /** Filesystem seam used to test command resolution without a real checkout. */
  readonly fileExists?: (path: string) => boolean
  /** Subprocess seam used to test command execution without starting Python. */
  readonly spawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Native PTY seam used to test NotebookLM authentication. */
  readonly authTerminal?: TranscriberAuthTerminal
}

const doctorRequestSchema = z.object({ live: z.boolean() })
const probeSchema = z.object({
  ran: z.boolean(),
  passed: z.boolean().nullable(),
  failure: z.string().nullable(),
})
const reportSchema = z.object({
  platform: z.string(),
  live: z.boolean(),
  python: z.object({
    version: z.string(),
    minimum_version: z.string(),
    supported: z.boolean(),
  }),
  dependencies: z.array(z.object({
    name: z.string(),
    purpose: z.string(),
    required: z.boolean(),
    resolved: z.boolean(),
    path: z.string().nullable(),
    probe: probeSchema.nullable(),
    failure_hint: z.string(),
    install_command: z.string().nullable(),
    installed: z.boolean().optional(),
    version: z.string().nullable().optional(),
    version_error: z.string().optional(),
    disabled: z.boolean().optional(),
    model: z.string().optional(),
    status: z.string().optional(),
    install_hint: z.string().optional(),
  })),
  ok: z.boolean(),
  exit_code: z.number().int(),
})

const BUNDLED_ENGINE_ROOT = resolve(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-transcriber-engine/package.json')), '../../../engine')

const DOCTOR_OUTPUT_MAX_BYTES = 1024 * 1024
const DOCTOR_GRACE_MS = 5000

/**
 * Build one command against the configured engine and workspace.
 * @param scriptName - script under the configured engine's `scripts` directory.
 * @param arguments_ - arguments appended after the shared workspace argument.
 * @param environment - environment carrying the transcriber paths.
 * @param fileExists - launcher and workspace existence check.
 * @returns the validated command and working directory.
 * @throws a typed Remote error when the script or workspace cannot be found.
 */
export function buildEngineCommand(
  scriptName: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): TranscriberDoctorCommand {
  const engineRoot = environment.TRANSCRIBER_ENGINE_ROOT || environment.TRANSCRIBER_SKILL_ROOT || BUNDLED_ENGINE_ROOT
  const workspace = fileExists === existsSync ? prepareWorkspace(environment) : engineWorkspacePath(environment)
  const script = join(engineRoot, 'scripts', scriptName)
  const executable = join(engineRoot, process.platform === 'win32' ? 'transcriber-engine.exe' : 'transcriber-engine')
  const source = fileExists(script)
  if (!source && !fileExists(executable)) {
    throw new RemoteError(
      'transcriber-engine/not-found',
      `Transcriber engine launcher was not found at ${script}. Set TRANSCRIBER_ENGINE_ROOT to the engine directory (TRANSCRIBER_SKILL_ROOT is also supported).`,
      { path: script, setting: 'TRANSCRIBER_ENGINE_ROOT' },
    )
  }
  if (!fileExists(workspace)) {
    throw new RemoteError(
      'transcriber-engine/not-found',
      `Transcriber workspace was not found at ${workspace}. Set TRANSCRIBER_WORKSPACE to the directory holding modules/.`,
      { path: workspace, setting: 'TRANSCRIBER_WORKSPACE' },
    )
  }
  const launcher = source ? ['python3', script] : [executable, scriptName.replace('.py', '').replaceAll('_', '-')]
  return {
    argv: [...launcher, '--workspace', workspace, ...arguments_],
    cwd: workspace,
  }
}

/**
 * Build a doctor invocation using Python source or the bundled onefile sidecar.
 * @param mode - presence-only or live-probe doctor mode.
 * @param environment - environment layer carrying the transcriber paths.
 * @param fileExists - launcher existence check.
 * @returns the validated command and working directory.
 * @throws a typed Remote error when the launcher or workspace cannot be found.
 */
export function buildDoctorCommand(
  mode: TranscriberDoctorMode,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): TranscriberDoctorCommand {
  return buildEngineCommand(
    'run_transcription.py',
    ['--doctor-json', ...mode === 'live' ? ['--doctor-live'] : []],
    environment,
    fileExists,
  )
}

/**
 * Parse and validate one complete engine JSON report.
 * @param output - complete stdout captured from the engine doctor.
 * @returns the validated doctor report.
 */
export function parseDoctorReport(output: string): TranscriberDoctorReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch (error: unknown) {
    throw invalidReport(messageOf(error))
  }
  const result = reportSchema.safeParse(parsed)
  if (!result.success) throw invalidReport(result.error.message)
  return {
    ...result.data,
    dependencies: result.data.dependencies.map(dependency => ({
      ...dependency,
      install_route: installRouteOf(dependency.install_command),
    })),
  }
}

/**
 * Run the doctor through the Host subprocess capability and preserve reports with non-zero exits.
 * @param request - doctor mode requested by the Client page.
 * @param signal - cancellation owned by the Remote call.
 * @param internals - environment and process seams used to resolve and execute the engine.
 * @param spawn - subprocess provider entry point.
 * @returns the validated report, including a report whose engine exit code is non-zero.
 */
export async function runDoctor(
  request: TranscriberDoctorRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
): Promise<TranscriberDoctorReport> {
  const parsedRequest = doctorRequestSchema.safeParse(request)
  if (!parsedRequest.success) {
    throw new RemoteError('gateway/bad-request', 'transcriber engine doctor requires a live boolean', {})
  }
  if (isAborted(signal)) throw cancelled()
  const command = buildDoctorCommand(
    parsedRequest.data.live ? 'live' : 'presence',
    internals.environment,
    internals.fileExists,
  )
  const spec: SubprocessSpawnSpec = {
    argv: command.argv,
    cwd: command.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: DOCTOR_OUTPUT_MAX_BYTES },
      stderr: { maxBytes: DOCTOR_OUTPUT_MAX_BYTES },
    },
    graceMs: DOCTOR_GRACE_MS,
    signal,
  }
  let handle: SubprocessHandle
  try {
    handle = spawn(spec)
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    throw unavailable(command, messageOf(error))
  }
  try {
    await handle.done
    if (!await handle.waitForExit(signal)) throw cancelled()
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    if (error instanceof RemoteError) throw error
    throw unavailable(command, messageOf(error))
  }
  if (isAborted(signal)) throw cancelled()
  const stdout = readCollected(handle.collected.stdout)
  if (stdout.trim() === '') {
    throw unavailable(command, readCollected(handle.collected.stderr) || 'the engine emitted no JSON report')
  }
  return parseDoctorReport(stdout)
}

/**
 * Read all output collected by a subprocess provider.
 * @param reader - bounded output reader, when the provider supplied one.
 * @returns the collected text or an empty string.
 */
export function readCollected(reader: SubprocessOutputReader | undefined): string {
  return reader?.readFrom(0).text ?? ''
}

/**
 * Check whether a caller cancelled an engine operation.
 * @param signal - operation signal.
 * @returns whether the signal is aborted.
 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Create the common cancellation failure for an engine operation.
 * @returns the typed gateway cancellation error.
 */
export function cancelled(): RemoteError<'gateway/cancelled'> {
  return new RemoteError('gateway/cancelled', 'transcriber engine operation was cancelled', {})
}

function invalidReport(detail: string): RemoteError<'transcriber-engine/invalid-report'> {
  return new RemoteError('transcriber-engine/invalid-report', `Transcriber engine returned invalid doctor JSON: ${detail}`, { detail })
}

/**
 * Create a failure describing an engine process that could not run.
 * @param command - command the provider attempted to start.
 * @param detail - process or provider diagnostic.
 * @returns the typed engine-unavailable error.
 */
export function unavailable(command: TranscriberDoctorCommand, detail: string): RemoteError<'transcriber-engine/unavailable'> {
  return new RemoteError(
    'transcriber-engine/unavailable',
    `Could not run the transcriber engine doctor with ${command.argv[0]}: ${detail}`,
    { command: command.argv.join(' '), detail },
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
