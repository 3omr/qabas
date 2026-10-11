/** Shared MCP request, response, and subprocess handling for engine listings. */

import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { TranscriberExamProgress } from './types.ts'
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
  readonly overallTimeoutMs?: number
  readonly progress?: (frame: TranscriberExamProgress) => void
}

/**
 * Run one engine MCP tool call and normalize its JSON-RPC response.
 * With an overall cap, matching MCP progress resets inactivity; cancellation reaps the process after notifying its request.
 * @param options - tool arguments, cancellation, process seams, and optional inactivity/overall limits.
 * @returns complete MCP stdout for the caller’s result parser.
 * @throws a typed error when the launcher is missing, the process fails, output is empty, or cancellation wins.
 */
export async function runMcpTool(options: RunMcpToolOptions): Promise<string> {
  if (isAborted(options.signal)) throw cancelled()
  if (options.overallTimeoutMs !== undefined) return runProgressTool(options)
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

async function runProgressTool(options: RunMcpToolOptions): Promise<string> {
  const command = buildEngineCommand('mcp_server.py', [], options.internals.environment, options.internals.fileExists)
  const processAbort = new AbortController()
  const handle = options.spawn({ argv: command.argv, cwd: command.cwd, signal: processAbort.signal,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: options.outputMaxBytes } }, graceMs: options.graceMs })
  const done = handle.done.then(() => undefined, (error: unknown) =>
    error instanceof Error ? error : new Error('Engine subprocess failed', { cause: error }))
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let inactive: ReturnType<typeof setTimeout> | undefined
  const deadline = new AbortController()
  let settled = false
  const completedPapers = new Set<string>()
  const stop = (): void => {
    if (killTimer !== undefined) return
    handle.stdin?.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n')
    killTimer = setTimeout(() => { processAbort.abort() }, options.graceMs)
  }
  const expire = (): void => { deadline.abort(); stop() }
  const reset = (): void => {
    clearTimeout(inactive)
    if (options.timeoutMs !== undefined) inactive = setTimeout(expire, options.timeoutMs)
  }
  const overall = setTimeout(expire, options.overallTimeoutMs)
  options.signal.addEventListener('abort', stop, { once: true })
  handle.stdin?.on('error', () => { processAbort.abort() })
  reset()
  try {
    if (handle.stdin === undefined || handle.stdout === undefined) throw unavailable(command, 'Engine pipes are unavailable')
    handle.stdin.write(mcpRequestData(options.toolName, options.arguments, true))
    if (options.signal.aborted) stop()
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    let output = ''
    let bytes = 0
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line, 'utf8') + 1
        if (bytes > options.outputMaxBytes) throw unavailable(command, 'Engine output exceeds mcpOutputMaxBytes')
        const frame = recordOf(JSON.parse(line) as unknown)
        const params = recordOf(frame?.params)
        if (frame?.method === 'notifications/progress' && params?.progressToken === 'exam-index'
          && typeof params.progress === 'number' && typeof params.total === 'number' && typeof params.message === 'string') {
          const progress = examProgress.safeParse(params)
          if (progress.success && !settled) {
            reset()
            options.progress?.(examCheckpoint(progress.data, completedPapers))
          }
        }
        if (frame?.id === 2) {
          output = line
          settled = true
          handle.stdin.end()
          clearTimeout(inactive)
          clearTimeout(overall)
        }
      }
    } finally { lines.close() }
    const error = await done
    if (options.signal.aborted) throw cancelled()
    if (deadline.signal.aborted) throw new RemoteError('transcriber-engine/tool-timeout', `${options.toolName} exceeded its inactivity or overall limit`,
      { tool: options.toolName, timeoutMs: options.timeoutMs ?? options.overallTimeoutMs ?? 0 })
    if (error !== undefined) throw error
    if (!settled) throw unavailable(command, 'Engine emitted no MCP answer')
    return output
  } finally {
    options.signal.removeEventListener('abort', stop)
    clearTimeout(inactive)
    clearTimeout(overall)
    processAbort.abort()
    await done
    await handle.waitForExit()
    clearTimeout(killTimer)
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

function mcpRequestData(toolName: string, arguments_: Readonly<Record<string, unknown>>, progress = false): string {
  return [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: arguments_, ...progress ? { _meta: { progressToken: 'exam-index' } } : {} },
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

const examProgress = z.object({ progress: z.number().int().nonnegative(), total: z.number().int().nonnegative(), message: z.string() })
function examCheckpoint(frame: z.output<typeof examProgress>, completed: Set<string>): TranscriberExamProgress {
  // agy_exam_index owns this exact MCP message format; unknown messages keep only their text.
  const match = /^paper \d+ of (\d+) · (?:(?:part (\d+) of (\d+)((?: · split [12]\/2)*)) · |completed · )?(.+)$/u.exec(frame.message)
  if (match !== null && /^paper \d+ of \d+ · completed ·/u.test(frame.message)) {
    completed.add(match[5] as string)
  }
  return {
    done: match === null ? frame.progress : completed.size, total: match === null ? frame.total : Number(match[1]),
    message: frame.message,
    ...match === null ? {} : { paper: match[5] as string },
    ...match?.[2] === undefined ? {} : { part: Number(match[2]), parts: Number(match[3]) },
    ...match?.[4] === undefined || match[4] === '' ? {} : {
      split: Array.from(match[4].matchAll(/split ([12])\/2/gu), item => Number(item[1])),
    },
  }
}
