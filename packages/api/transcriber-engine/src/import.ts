/** Safe file copying for dropped transcriber sources. */

import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  DOCUMENT_EXTENSIONS, RECORDING_EXTENSIONS, SLIDE_EXTENSIONS, extensionOf,
} from '@deepseek-ai/dsh-util-transcriber-formats'
import { z } from 'zod'
import { cancelled, isAborted, type TranscriberDoctorInternals } from './doctor.ts'
import type {
  TranscriberImportDestination, TranscriberImportReport, TranscriberImportRejectionCode,
  TranscriberImportRequest, TranscriberImportedFile, TranscriberRejectedFile,
} from './types.ts'

const importRequestSchema = z.object({
  module: z.string().min(1),
  destination: z.enum(['Lecture', 'Questions']),
  paths: z.array(z.string().min(1)).min(1),
})

interface ImportLayout {
  readonly destinationRoot: string
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function invalidImport(detail: string): RemoteError<'transcriber-engine/import-invalid'> {
  return new RemoteError(
    'transcriber-engine/import-invalid',
    `Could not resolve the transcriber import destination: ${detail}`,
    { detail },
  )
}

function environmentWorkspace(internals: TranscriberDoctorInternals): string {
  return resolve(internals.environment?.TRANSCRIBER_WORKSPACE || process.cwd())
}

async function resolveLayout(
  request: TranscriberImportRequest,
  internals: TranscriberDoctorInternals,
): Promise<ImportLayout> {
  const configuredWorkspace = environmentWorkspace(internals)
  const workspaceRoot = await realpath(configuredWorkspace).catch((error: unknown) => {
    throw new RemoteError(
      'transcriber-engine/not-found',
      `Transcriber workspace was not found at ${configuredWorkspace}. Set TRANSCRIBER_WORKSPACE to the directory holding modules/.`,
      { path: configuredWorkspace, setting: 'TRANSCRIBER_WORKSPACE' },
      { cause: error },
    )
  })
  const modulesRoot = resolve(workspaceRoot, 'modules')
  const moduleRoot = resolve(modulesRoot, request.module)
  if (!isInside(workspaceRoot, moduleRoot) || !isInside(modulesRoot, moduleRoot)) {
    throw invalidImport(`module ${JSON.stringify(request.module)} escapes modules/`)
  }
  const realModuleRoot = await realpath(moduleRoot).catch(() => {
    throw invalidImport(`module ${JSON.stringify(request.module)} does not exist`)
  })
  if (!isInside(workspaceRoot, realModuleRoot) || !isInside(modulesRoot, realModuleRoot)) {
    throw invalidImport(`module ${JSON.stringify(request.module)} resolves outside the workspace`)
  }
  await access(resolve(realModuleRoot, 'module.json')).catch(() => {
    throw invalidImport(`module ${JSON.stringify(request.module)} has no module.json`)
  })
  const destinationRoot = resolve(realModuleRoot, request.destination)
  if (!isInside(realModuleRoot, destinationRoot)) {
    throw invalidImport(`${request.destination}/ escapes the module folder`)
  }
  await mkdir(destinationRoot, { recursive: true })
  const realDestinationRoot = await realpath(destinationRoot)
  if (!isInside(realModuleRoot, realDestinationRoot)) {
    throw invalidImport(`${request.destination}/ resolves outside the module folder`)
  }
  return { destinationRoot: realDestinationRoot }
}

function acceptedExtensions(destination: TranscriberImportDestination): ReadonlySet<string> {
  const materials = [...DOCUMENT_EXTENSIONS, ...SLIDE_EXTENSIONS]
  if (destination === 'Lecture') return new Set([...RECORDING_EXTENSIONS, ...materials])
  return new Set(materials)
}

function rejection(
  source: string,
  name: string,
  reason: TranscriberImportRejectionCode,
  detail?: string,
): TranscriberRejectedFile {
  return detail === undefined ? { source, name, reason } : { source, name, reason, detail }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined
}

async function importOne(
  source: string,
  destinationRoot: string,
  allowed: ReadonlySet<string>,
): Promise<TranscriberImportedFile | TranscriberRejectedFile> {
  const name = basename(source)
  const extension = extensionOf(name)
  if (!isAbsolute(source)) return rejection(source, name, 'source-not-absolute')
  if (!allowed.has(extension)) return rejection(source, name, 'unsupported-extension', extension || 'no extension')
  let sourceStat: Awaited<ReturnType<typeof stat>>
  try {
    sourceStat = await stat(source)
  } catch (error: unknown) {
    const reason = errorCode(error) === 'ENOENT' ? 'source-not-found' : 'source-unreadable'
    return rejection(source, name, reason, messageOf(error))
  }
  if (!sourceStat.isFile()) return rejection(source, name, 'source-not-file')
  const destination = resolve(destinationRoot, name)
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
    return { source, destination }
  } catch (error: unknown) {
    const reason = errorCode(error) === 'EEXIST' ? 'name-collision' : 'copy-failed'
    return rejection(source, name, reason, messageOf(error))
  }
}

/**
 * Copy one drop into the module's engine-owned folder without overwriting files.
 *
 * Invalid module paths reject the operation before any copy. Each source file is
 * otherwise classified independently, so accepted files still land when another
 * file has an unsupported extension, a missing source, or a colliding name.
 * @param request - module, destination folder, and absolute source paths.
 * @param signal - cancellation owned by the Remote call.
 * @param internals - environment seam used by Host tests.
 * @returns every copied file and every per-file rejection.
 */
export async function runImportFiles(
  request: TranscriberImportRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
): Promise<TranscriberImportReport> {
  const parsed = importRequestSchema.safeParse(request)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', 'transcriber engine import requires a module, destination, and paths', {})
  }
  if (isAborted(signal)) throw cancelled()
  const layout = await resolveLayout(parsed.data, internals)
  const allowed = acceptedExtensions(parsed.data.destination)
  const filed: TranscriberImportedFile[] = []
  const rejected: TranscriberRejectedFile[] = []
  for (const source of parsed.data.paths) {
    if (isAborted(signal)) throw cancelled()
    const outcome = await importOne(source, layout.destinationRoot, allowed)
    if ('destination' in outcome) filed.push(outcome)
    else rejected.push(outcome)
  }
  if (isAborted(signal)) throw cancelled()
  return { module: parsed.data.module, destination: parsed.data.destination, filed, rejected }
}
