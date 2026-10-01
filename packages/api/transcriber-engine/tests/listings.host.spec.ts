/** Engine inventory validation and shared MCP lifecycle failures. */

import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TranscriberEngine, parseLectureListingOutput, parseModuleListingOutput } from '../src/index.ts'

const modules = { workspace: '/workspace', modules: [{ module: 'toxo', display_name: 'Toxicology', notebooks: ['nb'], root: '/workspace/modules/toxo' }] }
const lecture = { title: 'Lecture', recording_sources: [], paths: [], parts: 1, transcribed: false, in_notebook_only: false }
const listings = { module: 'toxo', lectures: [lecture], materials: [] }
const frame = (result: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: 2, result })
const response = (value: unknown): string => frame({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const controller = (): AbortController => new AbortController()
const handle = (stdout: string, stderr = ''): SubprocessHandle => ({
  stdin: undefined, stdout: undefined, stderr: undefined,
  collected: {
    stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
    stderr: { readFrom: () => ({ text: stderr, nextOffset: 0, lossy: false }) },
  },
  done: Promise.resolve({ exitCode: 0, signal: null }),
  terminate: () => {}, waitForExit: async () => true,
})
const endpoint = (spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): TranscriberEngine => new TranscriberEngine(new Context(), {
  environment: { TRANSCRIBER_SKILL_ROOT: '/skill', TRANSCRIBER_WORKSPACE: '/workspace' },
  fileExists: () => true, spawn, mcpOutputMaxBytes: 100, mcpGraceMs: 3,
})
afterEach(() => vi.restoreAllMocks())

describe('engine inventory additions', () => {
  it('lists modules through one cancellable MCP call with configured capture limits', async () => {
    const signal = controller().signal
    const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>(() => handle(response(modules)))
    expect(await endpoint(spawn).listModules(signal)).toEqual(modules)
    const spec = spawn.mock.calls[0]?.[0]
    expect(spec).toMatchObject({ signal, cwd: '/workspace', graceMs: 3, stdio: { stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } } })
    expect(spec?.argv).toEqual(['python3', '/skill/scripts/mcp_server.py', '--workspace', '/workspace'])
    expect(typeof spec?.stdio.stdin === 'object' && spec.stdio.stdin.data).toBe(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_modules', arguments: {} } }) + '\n',
    )
  })

  it.each(['pending', 'verbatim', 'draft', 'final'] as const)('retains optional progress fields for %s', (state) => {
    const listing = { ...listings, warning: 'offline', lectures: [{ ...lecture, state, transcript: 'final.md', draft: null, verbatim: 'verbatim.txt' }] }
    expect(parseLectureListingOutput(response(listing), 'toxo')).toEqual(listing)
  })

  it.each([
    ['invalid module fields', response({ ...modules, modules: [{ ...modules.modules[0], notebooks: [1] }] })],
    ['missing frame', '\n[]\nnull\n{broken\n{}\n'],
    ['missing content', frame({})],
    ['invalid JSON text', frame({ content: [{ text: 'broken' }] })],
    ['RPC error', JSON.stringify({ id: 2, error: { message: 'failed' } })],
    ['RPC error without message', JSON.stringify({ id: 2, error: {} })],
    ['tool error', frame({ isError: true, content: [{ text: 'failed' }] })],
    ['tool error without text', frame({ isError: true })],
  ])('rejects %s for modules', (_name, output) => {
    expect(() => parseModuleListingOutput(output)).toThrow(expect.objectContaining({ code: 'transcriber-engine/invalid-modules' }))
  })

  it.each([
    frame({}), frame({ content: [null] }), frame({ content: [{ text: 42 }] }),
    frame({ content: [{ text: '{' }] }), response({ ...listings, lectures: [{ ...lecture, state: 'unknown' }] }),
  ])('rejects malformed lecture answers %s', (output) => {
    expect(() => parseLectureListingOutput(output, 'toxo')).toThrow(expect.objectContaining({ code: 'transcriber-engine/invalid-listing' }))
  })

  it.each([
    JSON.stringify({ id: 2, error: {} }), frame({ isError: true }),
  ])('preserves legacy warning fallback %s', (output) => {
    expect(parseLectureListingOutput(output, 'toxo')).toEqual({ module: 'toxo', lectures: [], materials: [], warning: 'the engine rejected the lecture listing' })
  })

  it.each(['spawn', 'wait', 'empty', 'empty-stderr', 'remote-wait'] as const)('reports the shared MCP %s failure', async (failure) => {
    const spawn = (): SubprocessHandle => {
      if (failure === 'spawn') throw 'spawn failed'
      const process = handle(failure.startsWith('empty') ? '' : response(modules), failure === 'empty-stderr' ? 'stderr failed' : '')
      if (failure === 'wait') process.waitForExit = async () => { throw new Error('wait failed') }
      if (failure === 'remote-wait') process.waitForExit = async () => { throw new RemoteError('gateway/bad-request', 'upstream', {}) }
      return process
    }
    await expect(endpoint(spawn).listModules(controller().signal)).rejects.toMatchObject({ code: failure === 'remote-wait' ? 'gateway/bad-request' : 'transcriber-engine/unavailable' })
  })

  it.each(['before', 'spawn', 'wait', 'wait-throw', 'done'] as const)('cancels MCP when aborted at %s', async (phase) => {
    const abort = controller()
    if (phase === 'before') abort.abort()
    const spawn = vi.fn(() => {
      if (phase === 'spawn') { abort.abort(); throw new Error('aborted spawn') }
      const process = handle(response(modules))
      process.waitForExit = async () => {
        if (phase === 'wait-throw') { abort.abort(); throw new Error('aborted wait') }
        if (phase === 'done') abort.abort()
        return phase !== 'wait'
      }
      return process
    })
    await expect(endpoint(spawn).listModules(abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    if (phase === 'before') expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves decoder failures and maps non-Error decoder failures at the result boundary', () => {
    const parse = JSON.parse
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new Error('decoder failed') })
    expect(() => parseModuleListingOutput(response(modules))).toThrow('decoder failed')
    vi.spyOn(JSON, 'parse').mockImplementationOnce(parse).mockImplementationOnce(() => { throw 'decoder failed' })
    expect(() => parseModuleListingOutput(response(modules))).toThrow(expect.objectContaining({ code: 'transcriber-engine/invalid-modules' }))
    vi.spyOn(JSON, 'parse').mockImplementationOnce(parse).mockImplementationOnce(() => { throw 'decoder failed' })
    expect(() => parseLectureListingOutput(response(listings), 'toxo')).toThrow(expect.objectContaining({ code: 'transcriber-engine/invalid-listing' }))
  })

  it('rejects an empty module request before the process starts', async () => {
    const spawn = vi.fn(() => handle(''))
    await expect(endpoint(spawn).listLectures({ module: '' }, controller().signal)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(spawn).not.toHaveBeenCalled()
  })
})
