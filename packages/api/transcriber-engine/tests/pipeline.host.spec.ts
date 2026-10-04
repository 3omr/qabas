/** The lecture Remote streams MCP checkpoints and cancels the owning request. */
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { TranscriberEngine } from '../src/index.ts'
import type { TranscriberPipelineFrame } from '../src/types.ts'

function engine(answer?: unknown, message = 'write_parts_with_agy: part 2 of 3') {
  const stdout = new PassThrough()
  const frames: Array<{ method: string; params?: Record<string, unknown> }> = []
  let pending = ''
  const exited = Promise.withResolvers<{ exitCode: number; signal: null }>()
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      pending += String(chunk)
      for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        const frame = JSON.parse(line) as typeof frames[number]
        frames.push(frame)
        if (frame.method === 'tools/call') {
          const checkpoint = JSON.stringify({ method: 'notifications/progress', params: {
            progressToken: 'lecture', progress: 1, total: 3, message,
          } }) + '\n'
          stdout.write(checkpoint.slice(0, 20))
          stdout.write(checkpoint.slice(20))
          if (answer !== undefined) stdout.write(JSON.stringify({ id: 2, result: { content: [{ text: JSON.stringify(answer) }] } }) + '\n')
        }
      }
      callback()
    },
    final(callback) { stdout.end(); exited.resolve({ exitCode: 0, signal: null }); callback() },
  })
  const spawn = vi.fn((spec: SubprocessSpawnSpec): SubprocessHandle => {
    spec.signal?.addEventListener('abort', () => { stdin.end() }, { once: true })
    return {
      stdin, stdout, stderr: undefined, collected: {}, done: exited.promise,
      terminate: () => { stdin.end() }, waitForExit: async () => { await exited.promise; return true },
    }
  })
  const endpoint = new TranscriberEngine(new Context(), {
    environment: { TRANSCRIBER_WORKSPACE: '/fixture', TRANSCRIBER_SKILL_ROOT: '/engine' },
    fileExists: () => true, spawn,
  })
  return { endpoint, frames, spawn, stdin, stdout }
}
const request = { module: 'eye', lecture: 'Orbit', mode: 'continue' as const }

describe('lecture pipeline Remote', () => {
  it.each([
    ['write_parts_with_agy: part 2 of 3', 'write_parts_with_agy'],
    ['begin_lecture:', 'begin_lecture'],
    ['extract_figures:', 'extract_figures'],
  ])('streams partial MCP lines for %s before its validated outcome and authorizes the lecture', async (message, step) => {
    const outcome = { status: 'finalized', paths: { transcript: '/fixture/Orbit.md', index: '/fixture/Index.md' }, summary: 'ready' }
    const b = engine(outcome, message)
    const received: TranscriberPipelineFrame[] = []
    for await (const frame of b.endpoint.runLecturePipeline(request, new AbortController().signal)) received.push(frame)
    expect(received).toEqual([
      { type: 'progress', step, done: 1, total: 3, message },
      { type: 'outcome', outcome },
    ])
    expect(b.frames.find(frame => frame.method === 'tools/call')?.params).toMatchObject({ name: 'run_lecture_pipeline',
      arguments: { ...request, confirmed: true }, _meta: { progressToken: 'lecture' } })
    expect(b.stdin.writableFinished).toBe(true)
  })

  it.each([
    { status: 'stopped', step: 'write_parts_with_agy', kind: 'quota', reason: 'the quota is used up', reset_at: '2026-10-04T07:00:00Z' },
    { status: 'handoff', step: 'verify_provenance', findings: 're-send part 2', deadline: 1800000000000,
      note: 'Affected parts were rewritten', resume: { module: 'eye', manifest_path: '/fixture/manifest.json' } },
    { status: 'completed', note: 'Retained parts remain available for Continue' },
  ])('streams resumable and internal recovery outcomes ($status)', async (outcome) => {
    const b = engine(outcome)
    const frames: TranscriberPipelineFrame[] = []
    const deadline = Date.now() + 60000
    const recovery = { ...request, salvage: true, resume_manifest: '/fixture/manifest.json', deadline }
    for await (const frame of b.endpoint.runLecturePipeline(recovery, new AbortController().signal)) frames.push(frame)
    expect(frames.at(-1)).toEqual({ type: 'outcome', outcome })
    expect(b.frames.find(frame => frame.method === 'tools/call')?.params).toMatchObject({
      arguments: { ...recovery, confirmed: true, _pipeline_repair_rounds: 6, _pipeline_retry_delay: 2 },
    })
  })

  it('sends request-scoped cancellation and waits for exit', async () => {
    const b = engine()
    const abort = new AbortController()
    const stream = b.endpoint.runLecturePipeline(request, abort.signal)[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'progress' })
      abort.abort()
      await expect(stream.next()).rejects.toHaveProperty('code', 'gateway/cancelled')
      expect(b.frames).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } })
      expect(b.stdin.writableFinished).toBe(true)
    } finally { await stream.return?.() }
  })

  it('rejects malformed outcomes without presenting success', async () => {
    const b = engine({ status: 'finalized', paths: {} })
    await expect((async () => {
      for await (const _frame of b.endpoint.runLecturePipeline(request, new AbortController().signal)) { /* Drain the owned stream. */ }
    })()).rejects.toThrow()
  })
})
