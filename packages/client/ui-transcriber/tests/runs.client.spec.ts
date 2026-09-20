import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import {
  createReadLatestRun,
  foldRunEvents,
  type TranscriberRunsRemote,
} from '../src/client/runs.ts'

const SESSION = 'session-1' as SessionId
const RUNS_PATH = 'modules/toxo/.transcriber-cache/runs'

type Entry = { name: string; type: 'file' | 'directory' }

function remoteOver(tree: Record<string, Entry[]>, events: Record<string, string> = {}) {
  const list = vi.fn(async (_session: SessionId, path: string) => {
    const entries = tree[path]
    if (entries === undefined) {
      return { ok: false as const, error: { code: 'workspace-file/not-found', message: path } }
    }
    return { ok: true as const, value: { path, entries, truncated: false } }
  })
  const read = vi.fn(async (_session: SessionId, path: string) => {
    const text = events[path]
    if (text === undefined) {
      return { ok: false as const, error: { code: 'workspace-file/not-found', message: path } }
    }
    return {
      ok: true as const,
      value: { absolutePath: path, version: '1', offset: 1, text, lines: text.split('\n').length, eof: true },
    }
  })
  return {
    remote: { workspaceFiles: { list, read } } as unknown as TranscriberRunsRemote,
    list,
    read,
  }
}

const init = (title = 'Corrosives', phases = ['guide', 'imp', 'mcqs', 'written', 'cases']) => JSON.stringify({
  event: 'init',
  run_id: 'r1',
  title,
  run_dir: '/workspace/r1',
  phases,
  labels: { guide: 'Chronological Guide', imp: 'Important Points' },
})

function phase(name: string, state: string, label = name): string {
  return JSON.stringify({ event: 'phase', phase: name, state, label })
}

function result(status = 'SUCCESS'): string {
  return JSON.stringify({ event: 'result', status, exit_code: status === 'SUCCESS' ? 0 : 1, title: 'Corrosives' })
}

function latestRun(remote: TranscriberRunsRemote) {
  return createReadLatestRun(remote)(SESSION, 'toxo', new AbortController().signal)
}

describe('foldRunEvents', () => {
  it('keeps init order while folding concurrent phase completions into a finished run', () => {
    const run = foldRunEvents([
      init(),
      phase('cases', 'validated'),
      phase('guide', 'validated', 'Chronological Guide'),
      phase('written', 'repaired'),
      phase('mcqs', 'reused'),
      phase('imp', 'validated', 'Important Points'),
      result(),
    ].join('\n'))

    expect(run).toEqual({
      runId: 'r1',
      title: 'Corrosives',
      phases: [
        { name: 'guide', label: 'Chronological Guide', state: 'validated' },
        { name: 'imp', label: 'Important Points', state: 'validated' },
        { name: 'mcqs', label: 'mcqs', state: 'reused' },
        { name: 'written', label: 'written', state: 'repaired' },
        { name: 'cases', label: 'cases', state: 'validated' },
      ],
      done: ['guide', 'imp', 'mcqs', 'written', 'cases'],
      running: [],
      failed: [],
      finished: true,
      status: 'success',
    })
  })

  it('drops a truncated final JSON line and retains the running phase before it', () => {
    const run = foldRunEvents([
      init(),
      phase('guide', 'running', 'Chronological Guide'),
      '{"event":"phase","phase":"imp","state":"validated"',
    ].join('\r\n'))

    expect(run?.running).toEqual(['guide'])
    expect(run?.done).toEqual([])
    expect(run?.finished).toBe(false)
    expect(run?.phases[1]).toEqual({ name: 'imp', label: 'Important Points', state: 'pending' })
  })

  it('reports a failed phase as failed before a terminal result arrives', () => {
    const run = foldRunEvents([init(), phase('mcqs', 'failed', 'MCQs')].join('\n'))

    expect(run?.failed).toEqual(['mcqs'])
    expect(run?.status).toBe('failed')
    expect(run?.finished).toBe(false)
  })

  it('starts the fold at the latest init for a resumed attempt', () => {
    const resumed = [
      init('Old title', ['guide', 'imp']),
      phase('guide', 'validated', 'Old guide'),
      init('Corrosives resumed', ['guide', 'imp']),
      phase('imp', 'reused', 'Important Points'),
      phase('guide', 'running', 'Chronological Guide'),
    ].join('\n')

    const run = foldRunEvents(resumed)

    expect(run?.runId).toBe('r1')
    expect(run?.title).toBe('Corrosives resumed')
    expect(run?.done).toEqual(['imp'])
    expect(run?.running).toEqual(['guide'])
    expect(run?.phases).toHaveLength(2)
  })
})

describe('createReadLatestRun', () => {
  it('reads the lexicographically newest run directory', async () => {
    const newestPath = `${RUNS_PATH}/lecture-20260917054201-654588-e86d5bf1/events.ndjson`
    const { remote, read } = remoteOver(
      {
        [RUNS_PATH]: [
          { name: 'lecture-20260916000000-old', type: 'directory' },
          { name: 'lecture-20260917054201-654588-e86d5bf1', type: 'directory' },
        ],
      },
      { [newestPath]: [init(), result()].join('\n') },
    )

    await expect(latestRun(remote)).resolves.toMatchObject({ ok: true, value: { runId: 'r1', finished: true } })
    expect(read).toHaveBeenCalledWith(SESSION, newestPath, {}, expect.any(AbortSignal))
  })

  it('treats an absent runs directory and an empty one as no run', async () => {
    const absent = remoteOver({})
    await expect(latestRun(absent.remote)).resolves.toEqual({ ok: true, value: undefined })

    const empty = remoteOver({ [RUNS_PATH]: [] })
    await expect(latestRun(empty.remote)).resolves.toEqual({ ok: true, value: undefined })
  })

  it('folds Windows line endings and an empty events file without failing', async () => {
    const path = `${RUNS_PATH}/run-1/events.ndjson`
    const { remote } = remoteOver(
      { [RUNS_PATH]: [{ name: 'run-1', type: 'directory' }] },
      { [path]: `${init()}\r\n${phase('guide', 'running', 'Chronological Guide')}\r\n` },
    )
    const run = await latestRun(remote)
    expect(run.ok && run.value?.running).toEqual(['guide'])

    const empty = remoteOver(
      { [RUNS_PATH]: [{ name: 'run-1', type: 'directory' }] },
      { [path]: '' },
    )
    await expect(latestRun(empty.remote)).resolves.toEqual({ ok: true, value: undefined })
  })
})
