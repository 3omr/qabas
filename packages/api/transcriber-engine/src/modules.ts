/** Module-listing MCP command and response validation. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { type TranscriberDoctorInternals } from './doctor.ts'
import { runMcpTool, parseMcpToolOutput } from './mcp.ts'
import type { EditingOptions } from './editing.ts'
import type { TranscriberCreateModuleRequest, TranscriberModuleListing, TranscriberMcpConfig } from './types.ts'

const createModuleRequest = z.object({ module: z.string().regex(/^[a-z0-9-]+$/u), displayName: z.string().min(1) })

/**
 * Create a module and notebook after the student confirms the UI action.
 * @param request - lowercase slug and display name.
 * @param signal - cancellation passed to the MCP process.
 * @param options - Host process dependencies and output limits.
 * @param timeoutMs - configured module creation deadline.
 * @returns the engine's text result; engine refusals and malformed results reject.
 */
export async function runCreateModule(
  request: TranscriberCreateModuleRequest, signal: AbortSignal, options: EditingOptions, timeoutMs: number,
): Promise<string> {
  const parsed = createModuleRequest.safeParse(request)
  if (!parsed.success) throw new RemoteError('gateway/bad-request', parsed.error.message, {})
  const output = await runMcpTool({ toolName: 'create_module',
    arguments: { module: parsed.data.module, display_name: parsed.data.displayName, confirmed: true },
    signal, timeoutMs, internals: options.internals, spawn: options.spawn,
    outputMaxBytes: options.config.mcpOutputMaxBytes, graceMs: options.config.mcpGraceMs })
  const invalid = (detail: string): RemoteError<'transcriber-engine/invalid-edit-result'> =>
    new RemoteError('transcriber-engine/invalid-edit-result', `Invalid create_module result: ${detail}`, { tool: 'create_module', detail })
  const response = parseMcpToolOutput(output, invalid, 'Engine rejected module creation')
  if (response.error !== undefined || response.isError) {
    const detail = response.error ?? response.text ?? 'Engine rejected module creation'
    throw new RemoteError('transcriber-engine/edit-rejected', detail, { tool: 'create_module', detail })
  }
  if (response.text === undefined) throw invalid('the MCP call returned no text content')
  return response.text
}

const moduleListingSchema = z.object({
  workspace: z.string(),
  modules: z.array(z.object({
    module: z.string(),
    display_name: z.string(),
    notebooks: z.array(z.string()),
    root: z.string(),
  })),
})

function invalidModules(detail: string): RemoteError<'transcriber-engine/invalid-modules'> {
  return new RemoteError(
    'transcriber-engine/invalid-modules',
    `Transcriber engine returned invalid module listing JSON: ${detail}`,
    { detail },
  )
}

/**
 * Parse one complete `list_modules` MCP response.
 * @param output - complete stdout captured from the engine MCP server.
 * @returns the validated module listing.
 * @throws a typed Remote error when the MCP answer is malformed or rejected.
 */
export function parseModuleListingOutput(output: string): TranscriberModuleListing {
  const response = parseMcpToolOutput(output, invalidModules, 'the engine rejected the module listing')
  if (response.error !== undefined) throw invalidModules(response.error)
  if (response.isError) throw invalidModules(response.text ?? 'the engine rejected the module listing')
  if (response.text === undefined) throw invalidModules('the MCP call returned no text content')
  return parseModuleText(response.text)
}

function parseModuleText(text: string): TranscriberModuleListing {
  let decoded: unknown
  try {
    decoded = JSON.parse(text) as unknown
  } catch (error: unknown) {
    throw invalidModules(error instanceof Error ? error.message : String(error))
  }
  const parsed = moduleListingSchema.safeParse(decoded)
  if (!parsed.success) throw invalidModules(parsed.error.message)
  return parsed.data
}

/**
 * Run the engine MCP server once and return its module-listing answer.
 * @param signal - cancellation signal owned by the Remote call.
 * @param internals - optional process seams used by direct tests.
 * @param spawn - subprocess provider entry point.
 * @param config - resolved MCP capture and termination limits.
 * @returns the validated module listing.
 */
export async function runListModules(
  signal: AbortSignal,
  internals: TranscriberDoctorInternals,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  config: TranscriberMcpConfig,
): Promise<TranscriberModuleListing> {
  const output = await runMcpTool({
    toolName: 'list_modules',
    arguments: {},
    signal,
    internals,
    spawn,
    outputMaxBytes: config.mcpOutputMaxBytes,
    graceMs: config.mcpGraceMs,
  })
  return parseModuleListingOutput(output)
}
