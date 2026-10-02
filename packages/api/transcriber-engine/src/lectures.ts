/** MCP listing commands, response validation, and cancellation for engine inventories. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { cancelled, isAborted, type TranscriberDoctorInternals } from './doctor.ts'
import { parseMcpToolOutput, runMcpTool } from './mcp.ts'
import type {
  TranscriberLectureListing, TranscriberLectureListingRequest, TranscriberMcpConfig,
} from './types.ts'

/** Engine lecture inventory fields shared by individual and whole-library reads. */
export const listingSchema = z.object({
  module: z.string(),
  general_materials: z.array(z.string()).optional(),
  remote_as_of: z.string().nullable().optional(),
  lectures: z.array(z.object({
    origin: z.enum(['manual', 'auto']).optional(),
    id: z.string().optional(),
    materials: z.array(z.string()).optional(),
    title: z.string(),
    recording_sources: z.array(z.string()),
    paths: z.array(z.string()),
    parts: z.number().int(),
    transcribed: z.boolean(),
    in_notebook_only: z.boolean(),
    in_notebook: z.boolean().nullable().optional(),
    state: z.enum(['pending', 'verbatim', 'draft', 'final']).optional(),
    transcript: z.string().nullable().optional(),
    transcript_title: z.string().nullable().optional(),
    draft: z.string().nullable().optional(),
    verbatim: z.string().nullable().optional(),
    verbatims: z.array(z.string()).optional(),
  })),
  materials: z.array(z.object({ name: z.string(), path: z.string() })),
  questions: z.enum(['indexed', 'missing', 'needs-conversion']).optional(),
  warning: z.string().optional(),
})

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

function parseLectureText(text: string): TranscriberLectureListing {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw invalidListing(error instanceof Error ? error.message : String(error))
  }
  const parsed = listingSchema.safeParse(decoded)
  if (!parsed.success) throw invalidListing(parsed.error.message)
  return normalizeLectureListing(parsed.data)
}

/**
 * Preserve optional engine fields without publishing undefined values.
 * @param answer - schema-validated engine listing.
 * @returns the Remote listing.
 */
export function normalizeLectureListing(answer: z.output<typeof listingSchema>): TranscriberLectureListing {
  const { warning, questions, remote_as_of: remoteAsOf, ...listing } = answer
  const normalizedLectures = listing.lectures.map((lecture) => {
    const { state, transcript, transcript_title: transcriptTitle, draft, verbatim, verbatims,
      origin, id, materials, in_notebook: inNotebook, ...base } = lecture
    return {
      ...base,
      ...inNotebook === undefined ? {} : { in_notebook: inNotebook },
      ...origin === undefined ? {} : { origin },
      ...id === undefined ? {} : { id },
      ...materials === undefined ? {} : { materials },
      ...state === undefined ? {} : { state },
      ...transcript === undefined ? {} : { transcript },
      ...transcriptTitle === undefined ? {} : { transcript_title: transcriptTitle },
      ...draft === undefined ? {} : { draft },
      ...verbatim === undefined ? {} : { verbatim },
      ...verbatims === undefined ? {} : { verbatims },
    }
  })
  const normalizedListing = { ...listing, lectures: normalizedLectures,
    ...remoteAsOf === undefined ? {} : { remote_as_of: remoteAsOf }, ...questions === undefined ? {} : { questions } }
  return warning === undefined ? normalizedListing : { ...normalizedListing, warning }
}

function responseWarning(response: { readonly error?: string; readonly isError: boolean; readonly text?: string }): string | undefined {
  if (response.error !== undefined) return response.error
  if (response.isError) return response.text ?? 'the engine rejected the lecture listing'
  return undefined
}

/**
 * Parse the MCP response for one `list_lectures` call.
 * @param output - complete stdout captured from the engine MCP server.
 * @param module - requested module id, used for a warning-only answer.
 * @returns the validated lecture listing.
 * @throws a typed Remote error when the MCP answer is malformed.
 */
export function parseLectureListingOutput(output: string, module: string): TranscriberLectureListing {
  const response = parseMcpToolOutput(output, invalidListing, 'the engine rejected the lecture listing')
  const warning = responseWarning(response)
  if (warning !== undefined) return warningListing(module, warning)
  if (response.text === undefined) throw invalidListing('the MCP call returned no text content')
  return parseLectureText(response.text)
}

/**
 * Run the engine MCP server once and return its lecture-listing answer.
 * @param request - module id to list.
 * @param signal - cancellation signal owned by the Remote call.
 * @param internals - optional process seams used by direct tests.
 * @param spawn - subprocess provider entry point.
 * @param config - resolved MCP capture and termination limits.
 * @returns the validated lecture listing.
 */
export async function runListLectures(
  request: TranscriberLectureListingRequest,
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  config: TranscriberMcpConfig,
): Promise<TranscriberLectureListing> {
  const parsedRequest = z.object({ module: z.string().min(1), refresh: z.boolean().optional() }).safeParse(request)
  if (!parsedRequest.success) {
    throw new RemoteError('gateway/bad-request', 'transcriber engine lecture listing requires a module', {})
  }
  if (isAborted(signal)) throw cancelled()
  const output = await runMcpTool({
    toolName: 'list_lectures',
    arguments: parsedRequest.data,
    signal,
    internals,
    spawn,
    outputMaxBytes: config.mcpOutputMaxBytes,
    graceMs: config.mcpGraceMs,
  })
  return parseLectureListingOutput(output, parsedRequest.data.module)
}
