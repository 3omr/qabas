/** Exam indexing deadlines follow owned MCP progress and retain cancellation until settlement. */
import { PassThrough, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, expect, it, vi } from 'vitest'
import { runMcpTool } from '../src/mcp.ts'

function fixture(onProgress?: (frame: import('../src/types.ts').TranscriberExamProgress) => void) {
  const stdout = new PassThrough()
  let finish!: () => void
  const done = new Promise<{ exitCode: number; signal: null }>((resolve) => {
    finish = () => { stdout.end(); resolve({ exitCode: 0, signal: null }) }
  })
  const input: string[] = []
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    input.push(chunk.toString())
    if (chunk.toString().includes('notifications/cancelled')) finish()
    callback()
  } })
  const spawn = (spec: SubprocessSpawnSpec): SubprocessHandle => {
    spec.signal?.addEventListener('abort', finish, { once: true })
    return { stdin, stdout, stderr: undefined, done, collected: {}, terminate: finish, waitForExit: async () => true }
  }
  const controller = new AbortController()
  const running = runMcpTool({ toolName: 'build_exam_index', arguments: { module: 'test' }, signal: controller.signal,
    internals: { environment: { TRANSCRIBER_WORKSPACE: '/workspace', TRANSCRIBER_SKILL_ROOT: '/skill' }, fileExists: () => true },
    ...onProgress === undefined ? {} : { progress: onProgress },
    spawn, timeoutMs: 100, overallTimeoutMs: 350, graceMs: 5, outputMaxBytes: 10000 })
  const progress = (token = 'exam-index'): void => {
    stdout.write(JSON.stringify({ method: 'notifications/progress', params: {
      progressToken: token, progress: 1, total: 3, message: 'paper 1 of 3 · part 1 of 2',
    } }) + '\n')
  }
  return { stdout, input, running, progress, controller, finish }
}

afterEach(() => { vi.useRealTimers() })

it('completed batch progress extends inactivity beyond the former total deadline', async () => {
  vi.useFakeTimers()
  const task = fixture()
  for (let batch = 0; batch < 3; batch++) {
    await vi.advanceTimersByTimeAsync(80)
    task.progress()
    await vi.advanceTimersByTimeAsync(0)
  }
  task.stdout.write(JSON.stringify({ id: 2, result: { content: [{ text: 'indexed' }] } }) + '\n')
  task.finish()
  expect(await task.running).toContain('indexed')
  expect(task.input.join('')).toContain('"progressToken":"exam-index"')
})

it.each(['inactivity', 'overall', 'caller'] as const)('cancels and reaps the MCP owner at %s', async (reason) => {
  vi.useFakeTimers()
  const task = fixture()
  const rejected = expect(task.running).rejects.toHaveProperty('code', reason === 'caller' ? 'gateway/cancelled' : 'transcriber-engine/tool-timeout')
  if (reason === 'overall') {
    for (let batch = 0; batch < 4; batch++) {
      await vi.advanceTimersByTimeAsync(80)
      task.progress()
      await vi.advanceTimersByTimeAsync(0)
    }
    await vi.advanceTimersByTimeAsync(30)
  } else if (reason === 'caller') {
    task.controller.abort()
  } else {
    task.progress('unrelated')
    await vi.advanceTimersByTimeAsync(100)
  }
  await rejected
  expect(task.input.join('')).toContain('notifications/cancelled')
})


it('forwards paper completion separately from extraction part counters and ignores malformed progress', async () => {
  const checkpoints: import('../src/types.ts').TranscriberExamProgress[] = []
  const task = fixture((progress) => { checkpoints.push(progress) })
  const emit = (progress: number, total: number, message: string): void => {
    task.stdout.write(JSON.stringify({ method: 'notifications/progress', params: { progressToken: 'exam-index', progress, total, message } }) + '\n')
  }
  emit(2, 5, 'paper 1 of 13 · part 2 of 5 · split 1/2 · split 2/2 · exam عربي.pdf')
  emit(-1, 13, 'invalid')
  emit(1, 13, 'paper 1 of 13 · completed · exam عربي.pdf')
  task.stdout.write(JSON.stringify({ id: 2, result: { content: [{ text: 'indexed' }] } }) + '\n')
  task.finish()
  await task.running
  expect(checkpoints).toEqual([
    { done: 0, total: 13, message: 'paper 1 of 13 · part 2 of 5 · split 1/2 · split 2/2 · exam عربي.pdf', paper: 'exam عربي.pdf', part: 2, parts: 5, split: [1, 2] },
    { done: 1, total: 13, message: 'paper 1 of 13 · completed · exam عربي.pdf', paper: 'exam عربي.pdf' },
  ])
})

it('preserves structured paper phases and counts without parsing the message', async () => {
  const checkpoints: import('../src/types.ts').TranscriberExamProgress[] = []
  const task = fixture((progress) => { checkpoints.push(progress) })
  const details = { progress: 2, total: 13, message: 'Reviewing paper', file: 'Exam.pdf', phase: 'reviewing', questions: 41 }
  task.stdout.write(JSON.stringify({ method: 'notifications/progress', params: { progressToken: 'exam-index', ...details } }) + '\n')
  task.stdout.write(JSON.stringify({ id: 2, result: { content: [{ text: 'indexed' }] } }) + '\n')
  task.finish()
  await task.running
  expect(checkpoints).toEqual([{ done: 2, total: 13, message: 'Reviewing paper', paper: 'Exam.pdf', phase: 'reviewing', questions: 41 }])
})

it('keeps whether a failed paper failed reading its file, in the model run, or signed out', async () => {
  const checkpoints: import('../src/types.ts').TranscriberExamProgress[] = []
  const task = fixture((progress) => { checkpoints.push(progress) })
  for (const [file, cause] of [['Blank.txt', 'source'], ['End_2021.txt', 'model'], ['Bank.txt', 'auth']] as const) {
    const details = { progress: 1, total: 2, message: 'agy failed', file, phase: 'failed', cause }
    task.stdout.write(JSON.stringify({ method: 'notifications/progress', params: { progressToken: 'exam-index', ...details } }) + '\n')
  }
  task.stdout.write(JSON.stringify({ id: 2, result: { content: [{ text: 'indexed' }] } }) + '\n')
  task.finish()
  await task.running
  expect(checkpoints.map(({ paper, cause }) => ({ paper, cause }))).toEqual([
    { paper: 'Blank.txt', cause: 'source' }, { paper: 'End_2021.txt', cause: 'model' }, { paper: 'Bank.txt', cause: 'auth' },
  ])
})
