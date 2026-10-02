/** Session-free, workspace-confined text and binary file operations. */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { open, realpath, rename, rm, stat as statDiskFile, writeFile as writeTempFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { cancelled, isAborted, type TranscriberDoctorInternals } from './doctor.ts'
import { engineWorkspacePath } from './workspace.ts'
import type {
  TranscriberFileBytes, TranscriberFileConfig, TranscriberFileStat, TranscriberFileText,
  TranscriberReadFileBytesRequest, TranscriberReadFileRequest, TranscriberWriteFileRequest,
} from './types.ts'

const readFileRequestSchema = z.object({ path: z.string().min(1) })
const readFileBytesRequestSchema = z.object({ path: z.string().min(1), relativeTo: z.string().min(1).optional() })
const writeFileRequestSchema = z.object({
  path: z.string().min(1),
  text: z.string(),
  expectedVersion: z.string().min(1),
})

type FileOperation = 'read' | 'read-bytes' | 'stat' | 'write'

interface FileLocation {
  readonly absolutePath: string
  readonly root: string
}

interface FileSnapshot {
  readonly bytes: Buffer
  readonly version: string
  readonly size: number
}

/**
 * Read one UTF-8 workspace file under the configured text cap.
 * @param request - relative or absolute workspace path.
 * @param signal - caller cancellation.
 * @param internals - environment seam used by Host tests.
 * @param config - resolved file-size caps.
 * @returns canonical absolute path, opaque version, and text.
 */
export async function runReadFile(
  request: TranscriberReadFileRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  config: TranscriberFileConfig,
): Promise<TranscriberFileText> {
  const parsed = readFileRequestSchema.safeParse(request)
  if (!parsed.success) throw badFileRequest('readFile requires a path')
  const location = await resolveWorkspaceFile(parsed.data.path, undefined, internals, signal, 'read')
  const snapshot = await readSnapshot(location, signal, 'read', config.maxTextBytes)
  ensureWithinCap(location.absolutePath, snapshot.bytes.byteLength, config.maxTextBytes)
  return { absolutePath: location.absolutePath, version: snapshot.version, text: decodeUtf8(location.absolutePath, snapshot.bytes) }
}

/**
 * Read one workspace file as base64 bytes under the configured image cap.
 * @param request - path and optional workspace-file-relative base path.
 * @param signal - caller cancellation.
 * @param internals - environment seam used by Host tests.
 * @param config - resolved file-size caps.
 * @returns canonical absolute path, opaque version, and base64 bytes.
 */
export async function runReadFileBytes(
  request: TranscriberReadFileBytesRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  config: TranscriberFileConfig,
): Promise<TranscriberFileBytes> {
  const parsed = readFileBytesRequestSchema.safeParse(request)
  if (!parsed.success) throw badFileRequest('readFileBytes requires a path')
  const location = await resolveWorkspaceFile(parsed.data.path, parsed.data.relativeTo, internals, signal, 'read-bytes')
  const snapshot = await readSnapshot(location, signal, 'read-bytes', config.maxImageBytes)
  ensureWithinCap(location.absolutePath, snapshot.bytes.byteLength, config.maxImageBytes)
  return { absolutePath: location.absolutePath, version: snapshot.version, bytes: snapshot.bytes.toString('base64') }
}

/**
 * Replace one existing Markdown workspace file after an exact version check.
 * @param request - Markdown path, replacement text, and observed version.
 * @param signal - caller cancellation.
 * @param internals - environment seam used by Host tests.
 * @param config - resolved file-size caps.
 * @param writes - service-owned serialization queue keyed by canonical target.
 * @returns canonical absolute path and the replacement version.
 */
export async function runWriteFile(
  request: TranscriberWriteFileRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  config: TranscriberFileConfig,
  writes: Map<string, Promise<void>>,
): Promise<Pick<TranscriberFileText, 'absolutePath' | 'version'>> {
  const parsed = writeFileRequestSchema.safeParse(request)
  if (!parsed.success) throw badFileRequest('writeFile requires a path, text, and expectedVersion')
  const location = await resolveWorkspaceFile(parsed.data.path, undefined, internals, signal, 'write')
  if (extname(location.absolutePath).toLowerCase() !== '.md') {
    throw new RemoteError('transcriber-engine/file-not-markdown', `"${parsed.data.path}" is not a Markdown file`, { path: parsed.data.path })
  }
  ensureWithinCap(location.absolutePath, Buffer.byteLength(parsed.data.text, 'utf8'), config.maxTextBytes)
  const previous = writes.get(location.absolutePath)
  let release!: () => void
  const pending = new Promise<void>((resolvePending) => { release = resolvePending })
  writes.set(location.absolutePath, pending)
  try {
    await previous
    return await replaceFile(location, parsed.data, signal, config)
  } finally {
    release()
    if (writes.get(location.absolutePath) === pending) writes.delete(location.absolutePath)
  }
}

async function replaceFile(
  location: FileLocation,
  request: TranscriberWriteFileRequest,
  signal: AbortSignal,
  config: TranscriberFileConfig,
): Promise<Pick<TranscriberFileText, 'absolutePath' | 'version'>> {
  const current = await readSnapshot(location, signal, 'write', config.maxTextBytes)
  ensureExpectedVersion(request.path, request.expectedVersion, current.version)
  const tempPath = `${location.absolutePath}.${randomUUID()}.tmp`
  try {
    await writeTempFile(tempPath, request.text, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal })
    const latest = await readSnapshot(location, signal, 'write', config.maxTextBytes)
    ensureExpectedVersion(request.path, request.expectedVersion, latest.version)
    await verifyLocation(location, signal, 'write')
    checkCancelled(signal)
    await rename(tempPath, location.absolutePath)
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    if (error instanceof RemoteError) throw error
    throw unavailableFile(request.path, 'write', error)
  } finally {
    try {
      await rm(tempPath, { force: true })
    } catch (error: unknown) {
      throw unavailableFile(tempPath, 'write', error)
    }
  }
  const replacement = await readSnapshot(location, signal, 'write', config.maxTextBytes)
  return { absolutePath: location.absolutePath, version: replacement.version }
}

/**
 * Hash one workspace file for external-change polling.
 * @param request - relative or absolute workspace path.
 * @param signal - caller cancellation.
 * @param internals - environment seam used by Host tests.
 * @returns canonical absolute path, opaque version, and byte size.
 */
export async function runStatFile(
  request: TranscriberReadFileRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
): Promise<TranscriberFileStat> {
  const parsed = readFileRequestSchema.safeParse(request)
  if (!parsed.success) throw badFileRequest('stat requires a path')
  const location = await resolveWorkspaceFile(parsed.data.path, undefined, internals, signal, 'stat')
  const snapshot = await readSnapshot(location, signal, 'stat', undefined, false)
  return { absolutePath: location.absolutePath, version: snapshot.version, bytes: snapshot.size }
}

async function resolveWorkspaceFile(
  requestPath: string,
  relativeTo: string | undefined,
  internals: TranscriberDoctorInternals,
  signal: AbortSignal,
  operation: FileOperation,
): Promise<FileLocation> {
  checkCancelled(signal)
  const root = await resolveWorkspaceRoot(internals, signal)
  const configuredRoot = resolve(engineWorkspacePath(internals.environment))
  const canonicalInput = (path: string): string => isAbsolute(path) && isInside(configuredRoot, path)
    ? resolve(root, relative(configuredRoot, path))
    : path
  const base = relativeTo === undefined
    ? root
    : dirname((await resolvePathWithinRoot(root, canonicalInput(relativeTo), root, signal, operation)).absolutePath)
  return resolvePathWithinRoot(root, canonicalInput(requestPath), base, signal, operation)
}

async function resolvePathWithinRoot(
  root: string,
  requestPath: string,
  base: string,
  signal: AbortSignal,
  operation: FileOperation,
): Promise<FileLocation> {
  if (requestPath.includes('\0')) throw badFileRequest('workspace paths cannot contain NUL bytes')
  const candidate = resolve(base, requestPath)
  if (!isInside(root, candidate)) throw outsideWorkspace(requestPath)
  let canonical: string
  try {
    canonical = await realpath(candidate)
  } catch (error: unknown) {
    throw unavailableFile(requestPath, operation, error)
  }
  if (!isInside(root, canonical)) throw outsideWorkspace(requestPath)
  const metadata = await statFile(canonical, operation, signal)
  if (!metadata.isFile()) throw notRegularFile(requestPath)
  return { absolutePath: canonical, root }
}

async function resolveWorkspaceRoot(
  internals: TranscriberDoctorInternals,
  signal: AbortSignal,
): Promise<string> {
  checkCancelled(signal)
  const configured = resolve(engineWorkspacePath(internals.environment))
  try {
    return await realpath(configured)
  } catch (error: unknown) {
    throw new RemoteError(
      'transcriber-engine/not-found',
      `Transcriber workspace was not found at ${configured}. Set TRANSCRIBER_WORKSPACE to the directory holding modules/.`,
      { path: configured, setting: 'TRANSCRIBER_WORKSPACE' },
      { cause: error },
    )
  }
}

async function verifyLocation(location: FileLocation, signal: AbortSignal, operation: FileOperation): Promise<void> {
  await resolvePathWithinRoot(location.root, location.absolutePath, location.root, signal, operation)
}

async function readSnapshot(
  location: FileLocation,
  signal: AbortSignal,
  operation: FileOperation,
  limit?: number,
  retain = true,
): Promise<FileSnapshot> {
  checkCancelled(signal)
  await verifyLocation(location, signal, operation)
  try {
    const file = await open(location.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile()) throw notRegularFile(location.absolutePath)
      if (limit !== undefined) ensureWithinCap(location.absolutePath, Number(before.size), limit)
      const hash = createHash('sha256')
      const chunks: Buffer[] = []
      let size = 0
      const buffer = Buffer.alloc(64 * 1024)
      while (true) {
        checkCancelled(signal)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, size)
        checkCancelled(signal)
        if (bytesRead === 0) break
        size += bytesRead
        if (limit !== undefined) ensureWithinCap(location.absolutePath, size, limit)
        const bytes = buffer.subarray(0, bytesRead)
        hash.update(bytes)
        if (retain) chunks.push(Buffer.from(bytes))
      }
      const after = await file.stat({ bigint: true })
      if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || before.size !== after.size || BigInt(size) !== after.size) {
        throw new Error('file changed while being read')
      }
      return {
        bytes: Buffer.concat(chunks),
        version: `${after.mtimeNs.toString()}:${after.ctimeNs.toString()}:${after.size.toString()}:${hash.digest('hex')}`,
        size,
      }
    } finally {
      await file.close()
    }
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    if (error instanceof RemoteError) throw error
    throw unavailableFile(location.absolutePath, operation, error)
  }
}

async function statFile(path: string, operation: FileOperation, signal: AbortSignal): Promise<BigIntStats> {
  checkCancelled(signal)
  try {
    return await statDiskFile(path, { bigint: true })
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    throw unavailableFile(path, operation, error)
  }
}

function decodeUtf8(path: string, bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new RemoteError('transcriber-engine/file-not-utf8', `"${path}" is not valid UTF-8 text`, { path }, { cause: error })
  }
}

function ensureWithinCap(path: string, bytes: number, limit: number): void {
  if (bytes <= limit) return
  throw new RemoteError(
    'transcriber-engine/file-too-large',
    `"${path}" is ${String(bytes)} bytes, above the ${String(limit)} byte cap`,
    { path, limit, bytes },
  )
}

function ensureExpectedVersion(path: string, expected: string, actual: string): void {
  if (expected === actual) return
  throw new RemoteError(
    'transcriber-engine/file-conflict',
    `"${path}" changed after the caller read it`,
    { path, expectedVersion: expected, actualVersion: actual },
  )
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function checkCancelled(signal: AbortSignal): void {
  if (isAborted(signal)) throw cancelled()
}

function badFileRequest(message: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', message, {})
}

function outsideWorkspace(path: string): RemoteError<'transcriber-engine/path-outside-workspace'> {
  return new RemoteError('transcriber-engine/path-outside-workspace', `"${path}" is outside the transcriber workspace`, { path })
}

function notRegularFile(path: string): RemoteError<'transcriber-engine/file-not-regular'> {
  return new RemoteError('transcriber-engine/file-not-regular', `"${path}" is not a regular file`, { path })
}

function unavailableFile(path: string, operation: FileOperation, error: unknown): RemoteError<'transcriber-engine/file-unavailable' | 'transcriber-engine/file-not-found'> {
  if (errorCode(error) === 'ENOENT') {
    return new RemoteError('transcriber-engine/file-not-found', `No workspace file exists at "${path}"`, { path })
  }
  return new RemoteError(
    'transcriber-engine/file-unavailable',
    `Could not ${operation} workspace file "${path}"`,
    { path, operation },
    { cause: error },
  )
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
