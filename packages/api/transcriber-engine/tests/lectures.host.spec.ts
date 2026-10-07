/** Lecture-listing MCP parsing and process-boundary behavior. */

import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { TranscriberEngine } from '../src/index.ts'
import { parseLectureListingOutput } from '../src/lectures.ts'
import type { TranscriberDoctorInternals } from '../src/index.ts'

const listing = {
  module: 'toxo',
  lectures: [{
    title: 'Remote lecture',
    recording_sources: ['Remote lecture.m4a'],
    paths: [],
    parts: 1,
    transcribed: false,
    in_notebook_only: true,
  }],
  materials: [],
}

function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) }
}

function handle(stdout: string, exitCode = 0): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(stdout), stderr: reader('') },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  }
}

function response(value: unknown, isError = false): string {
  return [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError },
    }),
  ].join('\n')
}

function service(
  stdout: string,
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle = () => handle(stdout),
): TranscriberEngine {
  const context = new Context()
  const internals: TranscriberDoctorInternals = {
    environment: { TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' },
    fileExists: () => true,
    spawn,
  }
  return new TranscriberEngine(context, internals)
}

describe('transcriber engine lecture listing', () => {
  it('parses a successful MCP answer without inventing a path for NotebookLM-only work', () => {
    expect(parseLectureListingOutput(response(listing), 'toxo')).toEqual(listing)
  })

  it('retains fresh exam counts and index readiness in module reloads', () => {
    const answer = { ...listing, question_index: { state: 'stale', files: 3 } }
    expect(parseLectureListingOutput(response(answer), 'toxo')).toEqual(answer)
  })

  it('returns the engine error answer as a warning instead of throwing', () => {
    expect(parseLectureListingOutput(response('NotebookLM timed out', true), 'toxo')).toEqual({
      module: 'toxo', lectures: [], materials: [], warning: 'NotebookLM timed out',
    })
  })

  it('sends one MCP listing request through the cancellable engine process', async () => {
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => handle(response(listing)))
    const result = await service(response(listing), spawn).listLectures(
      { module: 'toxo' },
      new AbortController().signal,
    )

    expect(result).toEqual(listing)
    const spec = spawn.mock.calls[0]?.[0]
    expect(spec?.argv).toEqual(['python3', '/skill/scripts/mcp_server.py', '--workspace', '/workspace'])
    expect(typeof spec?.stdio.stdin === 'object' && spec.stdio.stdin.data).toContain('"module":"toxo"')
  })

  it('rejects invalid MCP output as an engine-data error', async () => {
    await expect(service('not JSON').listLectures({ module: 'toxo' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'transcriber-engine/invalid-listing' })
  })

  it('does not spawn an already-cancelled listing', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>()
    await expect(service(response(listing), spawn).listLectures({ module: 'toxo' }, controller.signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
