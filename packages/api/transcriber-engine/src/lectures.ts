/** MCP listing command, response parsing, and cancellation for lecture inventories. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import {
  buildEngineCommand, cancelled, isAborted, readCollected, unavailable,
  type TranscriberDoctorInternals,
} from './doctor.ts'
import type {
  TranscriberLectureListing, TranscriberLectureListingRequest,
} from './types.ts'

const LISTING_OUTPUT_MAX_BYTES = 4 * 1024 * 1024
const LISTING_GRACE_MS = 5000
const MCP_INITIALIZE_ID = 1
const MCP_CALL_ID = 2

const listingSchema = z.object({
  module: z.string(),
  lectures: z.array(z.object({
    title: z.string(),
    recording_sources: z.array(z.string()),
    paths: z.array(z.string()),
    parts: z.number().int(),
    transcribed: z.boolean(),
    in_notebook_only: z.boolean(),
  })),
  materials: z.array(z.object({ name: z.string(), path: z.string() })),
  warning: z.string().optional(),
})

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const field = record[key]
  return typeof field === 'string' ? field : undefined
}

function warningListing(module: string, warning: string): TranscriberLectureListing {
  return { module, lectures: [], materials: [], warning }
}

function invalidListing(detail: string): RemoteError<'transcriber-engine/invalid-listing'> {
  return new RemoteError(
    'transcriber-engine/invalid-listing',
    `Transcriber engine returned invalid lecture listing JSON: ${detail}`,
    { detail },
  )
}

function frameOf(output: string): JsonRecord | undefined {
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    try {
      const frame = JSON.parse(line) as unknown
      if (isRecord(frame) && frame.id === MCP_CALL_ID) return frame
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return undefined
}

function errorText(frame: JsonRecord): string | undefined {
  const error = frame.error
  if (!isRecord(error)) return undefined
  return stringField(error, 'message') ?? 'the engine rejected the lecture listing'
}

function contentText(frame: JsonRecord): string | undefined {
  const result = frame.result
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined
  const first: unknown = result.content[0]
  return isRecord(first) ? stringField(first, 'text') : undefined
}

/**
 * Parse the MCP response for one `list_lectures` call.
 * @param output - complete stdout captured from the engine MCP server.
 * @param module - requested module id, used for a warning-only answer.
 * @returns the validated lecture listing.
 * @throws a typed Remote error when the MCP answer is malformed.
 */
export function parseLectureListingOutput(output: string, module: string): TranscriberLectureListing {
  const frame = frameOf(output)
  if (frame === undefined) throw invalidListing('the MCP call response was missing')
  const frameError = errorText(frame)
  if (frameError !== undefined) return warningListing(module, frameError)
  const resultFrame = frame.result
  if (isRecord(resultFrame) && resultFrame.isError === true) {
    return warningListing(module, contentText(frame) ?? 'the engine rejected the lecture listing')
  }
  const text = contentText(frame)
  if (text === undefined) throw invalidListing('the MCP call returned no text content')
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw invalidListing(error instanceof Error ? error.message : String(error))
  }
  const parsed = listingSchema.safeParse(decoded)
  if (!parsed.success) throw invalidListing(parsed.error.message)
  const { warning, ...listing } = parsed.data
  return warning === undefined ? listing : { ...listing, warning }
}

function mcpRequestData(module: string): string {
  return [
    { jsonrpc: '2.0', id: MCP_INITIALIZE_ID, method: 'initialize' },
    {
      jsonrpc: '2.0',
      id: MCP_CALL_ID,
      method: 'tools/call',
      params: { name: 'list_lectures', arguments: { module } },
    },
  ].map(request => JSON.stringify(request)).join('\n') + '\n'
}

/**
 * Run the engine MCP server once and return its lecture-listing answer.
 * @param request - module id to list.
 * @param signal - cancellation signal owned by the Remote call.
 * @param internals - optional process seams used by direct tests.
 * @param spawn - subprocess provider entry point.
 * @returns the validated lecture listing.
 */
export async function runListLectures(
  request: TranscriberLectureListingRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
): Promise<TranscriberLectureListing> {
  const parsedRequest = z.object({ module: z.string().min(1) }).safeParse(request)
  if (!parsedRequest.success) {
    throw new RemoteError('gateway/bad-request', 'transcriber engine lecture listing requires a module', {})
  }
  if (isAborted(signal)) throw cancelled()
  const command = buildEngineCommand('mcp_server.py', [], internals.environment, internals.fileExists)
  const spec: SubprocessSpawnSpec = {
    argv: command.argv,
    cwd: command.cwd,
    stdio: {
      stdin: { data: mcpRequestData(parsedRequest.data.module) },
      stdout: { maxBytes: LISTING_OUTPUT_MAX_BYTES },
      stderr: { maxBytes: LISTING_OUTPUT_MAX_BYTES },
    },
    graceMs: LISTING_GRACE_MS,
    signal,
  }
  let handle: SubprocessHandle
  try {
    handle = spawn(spec)
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    throw unavailable(command, error instanceof Error ? error.message : String(error))
  }
  try {
    await handle.done
    if (!await handle.waitForExit(signal)) throw cancelled()
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    if (error instanceof RemoteError) throw error
    throw unavailable(command, error instanceof Error ? error.message : String(error))
  }
  if (isAborted(signal)) throw cancelled()
  const stdout = readCollected(handle.collected.stdout)
  if (stdout.trim() === '') {
    throw unavailable(command, readCollected(handle.collected.stderr) || 'the engine emitted no MCP answer')
  }
  return parseLectureListingOutput(stdout, parsedRequest.data.module)
}
