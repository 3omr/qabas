/** Shared MCP request, response, and subprocess handling for engine listings. */

import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  buildEngineCommand, cancelled, isAborted, readCollected, unavailable,
  type TranscriberDoctorInternals,
} from './doctor.ts'

interface McpToolResponse {
  readonly error?: string
  readonly isError: boolean
  readonly text?: string
}

interface RunMcpToolOptions {
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly internals: TranscriberDoctorInternals
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly outputMaxBytes: number
  readonly graceMs: number
  readonly timeoutMs?: number
}

/**
 * Run one engine MCP tool call and normalize its JSON-RPC response.
 * @param options - tool arguments, cancellation, process seams, and parser failure factory.
 * @returns complete MCP stdout for the caller’s result parser.
 * @throws a typed error when the launcher is missing, the process fails, output is empty, or cancellation wins.
 */
export async function runMcpTool(options: RunMcpToolOptions): Promise<string> {
  if (options.timeoutMs === undefined) return runCapturedTool(options)
  const deadline = new AbortController()
  const timer = setTimeout(() => { deadline.abort() }, options.timeoutMs)
  try {
    return await runCapturedTool({ ...options, signal: AbortSignal.any([options.signal, deadline.signal]) })
  } catch (error: unknown) {
    if (options.signal.aborted) throw cancelled()
    if (deadline.signal.aborted) {
      throw new RemoteError('transcriber-engine/tool-timeout', `${options.toolName} timed out after ${options.timeoutMs} ms`,
        { tool: options.toolName, timeoutMs: options.timeoutMs })
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function runCapturedTool(options: RunMcpToolOptions): Promise<string> {
  const command = buildEngineCommand('mcp_server.py', [], options.internals.environment, options.internals.fileExists)
  const spec: SubprocessSpawnSpec = {
    argv: command.argv,
    cwd: command.cwd,
    stdio: {
      stdin: { data: mcpRequestData(options.toolName, options.arguments) },
      stdout: { maxBytes: options.outputMaxBytes },
      stderr: { maxBytes: options.outputMaxBytes },
    },
    graceMs: options.graceMs,
    signal: options.signal,
  }
  if (isAborted(options.signal)) throw cancelled()
  let handle: SubprocessHandle
  try {
    handle = options.spawn(spec)
  } catch (error: unknown) {
    if (isAborted(options.signal)) throw cancelled()
    throw unavailable(command, messageOf(error))
  }
  try {
    await handle.done
    if (!await handle.waitForExit(options.signal)) throw cancelled()
  } catch (error: unknown) {
    if (isAborted(options.signal)) throw cancelled()
    if (error instanceof RemoteError) throw error
    throw unavailable(command, messageOf(error))
  }
  if (isAborted(options.signal)) throw cancelled()
  const stdout = readCollected(handle.collected.stdout)
  if (stdout.trim() === '') {
    throw unavailable(command, readCollected(handle.collected.stderr) || 'the engine emitted no MCP answer')
  }
  return stdout
}

function mcpRequestData(toolName: string, arguments_: Readonly<Record<string, unknown>>): string {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: arguments_ },
    },
  ].map(request => JSON.stringify(request)).join('\n') + '\n'
}

/**
 * Parse the first matching JSON-RPC MCP tool response.
 * @param output - complete stdout captured from the engine MCP server.
 * @param invalidOutput - typed failure factory owned by the caller's result schema.
 * @param rejectedMessage - fallback when an engine error has no message.
 * @returns the MCP error text, error flag, and first text content block.
 * @throws the caller's typed invalid-output error when no tool response exists.
 */
export function parseMcpToolOutput(
  output: string,
  invalidOutput: (detail: string) => RemoteError,
  rejectedMessage: string,
): McpToolResponse {
  const frame = frameOf(output)
  if (frame === undefined) throw invalidOutput('the MCP call response was missing')
  const result = recordOf(frame.result)
  const content: unknown = Array.isArray(result?.content) ? result.content[0] : undefined
  const text = stringField(recordOf(content), 'text')
  const error = recordOf(frame.error)
  return {
    ...error === undefined ? {} : { error: stringField(error, 'message') ?? rejectedMessage },
    isError: result?.isError === true,
    ...text === undefined ? {} : { text },
  }
}

function frameOf(output: string): Record<string, unknown> | undefined {
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as unknown
      const frame = recordOf(parsed)
      if (frame?.id === 2) return frame
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = record?.[key]
  return typeof field === 'string' ? field : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
