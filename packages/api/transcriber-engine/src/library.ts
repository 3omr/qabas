/** Whole-library MCP inventory validation with isolated module errors. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { listingSchema, normalizeLectureListing } from './lectures.ts'
import { parseMcpToolOutput, runMcpTool } from './mcp.ts'
import type { EditingOptions } from './editing.ts'
import type { TranscriberLibraryListing, TranscriberLibraryRequest } from './types.ts'

const metadata = z.object({ module: z.string(), display_name: z.string(), notebooks: z.array(z.string()), root: z.string() })
const librarySchema = z.object({ workspace: z.string(), modules: z.array(z.union([
  metadata.extend(listingSchema.shape).extend({ exam_index: z.enum(['built', 'missing', 'stale']), question_files: z.number().int().nonnegative() }),
  metadata.extend({ error: z.string() }),
])) })

/**
 * Read all module inventories in one bounded, cancellable engine call.
 * @param request - remote notebook cache policy.
 * @param signal - Remote cancellation.
 * @param options - process dependencies and capture limits.
 * @returns validated inventories, including module-local errors.
 */
export async function runListLibrary(
  request: TranscriberLibraryRequest, signal: AbortSignal, options: EditingOptions,
): Promise<TranscriberLibraryListing> {
  const input = z.object({ remote: z.enum(['cached', 'refresh', 'skip']).optional() }).safeParse(request)
  if (!input.success) throw new RemoteError('gateway/bad-request', input.error.message, {})
  const output = await runMcpTool({ toolName: 'list_library', arguments: input.data, signal, internals: options.internals,
    spawn: options.spawn, outputMaxBytes: options.config.mcpOutputMaxBytes, graceMs: options.config.mcpGraceMs })
  const invalid = (detail: string): RemoteError<'transcriber-engine/invalid-modules'> =>
    new RemoteError('transcriber-engine/invalid-modules', `Invalid library listing: ${detail}`, { detail })
  const response = parseMcpToolOutput(output, invalid, 'Engine rejected the library listing')
  if (response.error !== undefined || response.isError) throw invalid(response.error ?? response.text ?? 'Engine rejected the library listing')
  let decoded: unknown
  try { decoded = JSON.parse(response.text ?? '') as unknown } catch (error: unknown) {
    throw invalid(error instanceof Error ? error.message : String(error))
  }
  const parsed = librarySchema.safeParse(decoded)
  if (!parsed.success) throw invalid(parsed.error.message)
  return { workspace: parsed.data.workspace, modules: parsed.data.modules.map((module) => {
    if ('error' in module) return module
    return { display_name: module.display_name, notebooks: module.notebooks, root: module.root,
      ...normalizeLectureListing(module), exam_index: module.exam_index, question_files: module.question_files }
  }) }
}
