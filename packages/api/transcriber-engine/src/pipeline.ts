/** Stream the session-free lecture procedure and cancel its owning MCP request. */
import { createInterface } from 'node:readline'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { buildEngineCommand, cancelled, isAborted, readCollected } from './doctor.ts'
import { editingRequests, type EditingOptions } from './editing.ts'
import { parseMcpToolOutput } from './mcp.ts'
import type { TranscriberPipelineFrame, TranscriberPipelineRequest } from './types.ts'

const requestSchema = editingRequests.defineLecture.pick({ module: true }).extend({
  lecture: z.string().trim().min(1), mode: z.enum(['transcribe', 'redo', 'continue']),
  salvage: z.boolean().optional(), resume_manifest: z.string().min(1).optional(), deadline: z.number().positive().optional(),
})
const outcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('finalized'), paths: z.object({ transcript: z.string().min(1), index: z.string().min(1) }), summary: z.string(), note: z.string().optional() }),
  z.object({ status: z.literal('stopped'), step: z.string(), kind: z.enum(['network', 'quota', 'auth', 'missing-recording']), reason: z.string(), reset_at: z.iso.datetime({ offset: true }).optional(), resume: z.object({ module: z.string(), manifest_path: z.string() }).optional() }),
  z.object({ status: z.literal('handoff'), step: z.string(), findings: z.string().max(8000), deadline: z.number().positive(), note: z.string(), resume: z.object({ module: z.string(), manifest_path: z.string() }).optional() }),
  z.object({ status: z.literal('completed'), note: z.string() }),
])
const progressSchema = z.object({ method: z.literal('notifications/progress'), params: z.object({
  progressToken: z.literal('lecture'), progress: z.number().nonnegative(), total: z.number().nonnegative(), message: z.string(),
}) })

/**
 * Run one authorized lecture through MCP, streaming progress and exactly one outcome.
 * @param request - student-selected lecture and operation.
 * @param signal - caller cancellation; sends MCP cancellation before terminating the child.
 * @param options - engine launcher and process limits.
 * @param timeoutMs - deployment deadline for the complete lecture.
 * @param rounds - maximum automatic recovery rounds.
 * @param retryDelayMs - initial transient-error backoff.
 * @returns progress and outcome frames; transport or parser failures reject.
 */
export async function* runLecturePipeline(
  request: TranscriberPipelineRequest, signal: AbortSignal, options: EditingOptions, timeoutMs: number, rounds = 6, retryDelayMs = 2000,
): AsyncIterable<TranscriberPipelineFrame> {
  const parsed = requestSchema.safeParse(request)
  if (!parsed.success) throw new RemoteError('gateway/bad-request', parsed.error.message, {})
  if (isAborted(signal)) throw cancelled()
  const command = buildEngineCommand('mcp_server.py', [], options.internals.environment, options.internals.fileExists)
  const invalid = (detail: string): RemoteError<'transcriber-engine/invalid-edit-result'> =>
    new RemoteError('transcriber-engine/invalid-edit-result', detail, { tool: 'run_lecture_pipeline', detail })
  const processAbort = new AbortController()
  const handle = options.spawn({ argv: command.argv, cwd: command.cwd, signal: processAbort.signal,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: options.config.mcpOutputMaxBytes } },
    graceMs: options.config.mcpGraceMs })
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (killTimer !== undefined) return
    handle.stdin?.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n')
    killTimer = setTimeout(() => { processAbort.abort() }, options.config.mcpGraceMs)
  }
  const deadline = setTimeout(stop, timeoutMs)
  signal.addEventListener('abort', stop, { once: true })
  // Cancellation must remain writable until the request settles; EOF closes server ownership.
  handle.stdin?.on('error', () => { processAbort.abort() })
  const processDone = handle.done.then(outcome => ({ outcome }), (error: unknown) => ({ error }))
  let settled = false
  let bytes = 0
  try {
    if (handle.stdin === undefined || handle.stdout === undefined) throw invalid('Engine pipes are unavailable')
    handle.stdin.write([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
        name: 'run_lecture_pipeline', arguments: { ...parsed.data, confirmed: true,
          _pipeline_budget_seconds: Math.max(0.001, Math.min(timeoutMs,
            (parsed.data.deadline ?? Date.now() + timeoutMs) - Date.now()) / 1000),
          _pipeline_repair_rounds: rounds, _pipeline_retry_delay: retryDelayMs / 1000 }, _meta: { progressToken: 'lecture' },
      } },
    ].map(frame => JSON.stringify(frame)).join('\n') + '\n')
    if (isAborted(signal)) stop()
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (isAborted(signal)) throw cancelled()
        bytes += Buffer.byteLength(line, 'utf8')
        if (bytes > options.config.mcpOutputMaxBytes) throw invalid('Engine pipeline output exceeds mcpOutputMaxBytes')
        const decoded: unknown = JSON.parse(line)
        const progress = progressSchema.safeParse(decoded)
        if (progress.success) {
          const { progress: done, total, message } = progress.data.params
          const [step] = message.split(':', 1)
          yield { type: 'progress', step: step ?? 'run_lecture_pipeline', done, total, message }
        } else if (typeof decoded === 'object' && decoded !== null && 'id' in decoded && decoded.id === 2) {
          if (settled) throw invalid('Engine emitted more than one pipeline outcome')
          const response = parseMcpToolOutput(line, invalid, 'Lecture pipeline refused')
          if (response.error !== undefined || response.isError) throw invalid(response.error ?? response.text ?? 'Lecture pipeline refused')
          const outcome = outcomeSchema.parse(JSON.parse(response.text ?? ''))
          settled = true
          handle.stdin.end()
          yield { type: 'outcome', outcome }
        }
      }
    } finally { lines.close() }
    const result = await processDone
    if (isAborted(signal)) throw cancelled()
    if (killTimer !== undefined) throw invalid('Lecture pipeline exceeded its deadline')
    if ('error' in result) throw result.error
    if (!settled) throw invalid(readCollected(handle.collected.stderr) || 'Engine emitted no pipeline outcome')
  } finally {
    signal.removeEventListener('abort', stop)
    clearTimeout(deadline)
    if (!settled && !isAborted(signal)) processAbort.abort()
    await processDone
    await handle.waitForExit()
    clearTimeout(killTimer)
  }
}
