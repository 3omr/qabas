/** Registry Remotes validate engine answers and remove temporary browser imports. */

import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriberEngine, parseLectureListingOutput } from '../src/index.ts'

let root: string
let endpoint: TranscriberEngine
let respond: (tool: string, arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
const calls: { tool: string; arguments: Record<string, unknown> }[] = []
const specs: SubprocessSpawnSpec[] = []
const signal = (): AbortSignal => new AbortController().signal
const frame = (answer: unknown): string => JSON.stringify({ id: 2, result: { content: [{ text: JSON.stringify(answer) }] } })

function spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
  specs.push(spec)
  const stdin = spec.stdio.stdin
  if (typeof stdin !== 'object' || typeof stdin.data !== 'string') throw new Error('Missing MCP input')
  const request = JSON.parse(stdin.data.split('\n')[1] ?? '') as { params: { name: string; arguments: Record<string, unknown> } }
  const call = { tool: request.params.name, arguments: request.params.arguments }
  calls.push(call)
  let stdout = ''
  const done = respond(call.tool, call.arguments, spec.signal ?? signal()).then((answer) => {
    stdout = typeof answer === 'string' ? answer : frame(answer)
    return { exitCode: 0, signal: null }
  })
  return {
    stdin: undefined, stdout: undefined, stderr: undefined, done,
    collected: { stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) } },
    terminate: () => {}, waitForExit: async () => true,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qabas-edit-test-'))
  await mkdir(join(root, 'modules', 'toxo'), { recursive: true })
  await writeFile(join(root, 'modules', 'toxo', 'module.json'), '{}')
  calls.length = 0
  specs.length = 0
  endpoint = new TranscriberEngine(new Context(), {
    environment: { TRANSCRIBER_WORKSPACE: root, TRANSCRIBER_SKILL_ROOT: '/skill' }, fileExists: () => true, spawn,
  })
})
afterEach(async () => { vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

const definition = { id: 'shock', title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'], created: 'today', updated: 'today' }
const inventory = { module: 'toxo', files: [{ path: 'Lecture/Shock.m4a', name: 'Shock.m4a', kind: 'recording', size_bytes: 9,
  lectures: [{ id: 'shock', title: 'Shock', origin: 'manual' }], in_notebook: null }], warning: 'offline' }
const uploaded = { module: 'toxo', notebook: { id: 'nb', title: 'Toxo' }, status: 'ready', next: 'Continue', files: [{
  path: '/workspace/modules/toxo/Lecture/Shock.m4a', name: 'Shock.m4a', size_bytes: 9, size_mb: 0,
  status: 'already-uploaded', ready: true, source_id: 'source',
}] }

describe('lecture management Remotes', () => {
  it('routes hide and restore without a chat and preserves hidden file metadata', async () => {
    respond = async (tool, args) => tool === 'list_module_files'
      ? { ...inventory, files: [{ ...inventory.files[0], hidden: true, lectures: [] }] }
      : { module: 'toxo', recordings: args.recordings ?? ['Shock.m4a'] }
    expect(await endpoint.hideLecture({ module: 'toxo', title: 'Shock' }, signal())).toEqual({ module: 'toxo', recordings: ['Shock.m4a'] })
    expect(await endpoint.restoreRecordings({ module: 'toxo', recordings: ['Shock.m4a'] }, signal())).toEqual({ module: 'toxo', recordings: ['Shock.m4a'] })
    expect(calls.slice(0, 2)).toEqual([
      { tool: 'hide_lecture', arguments: { module: 'toxo', title: 'Shock', confirmed: true } },
      { tool: 'restore_recordings', arguments: { module: 'toxo', recordings: ['Shock.m4a'], confirmed: true } },
    ])
    expect((await endpoint.listModuleFiles({ module: 'toxo' }, signal())).files[0]?.hidden).toBe(true)
  })

  it('refuses unsafe restore names and malformed visibility results', async () => {
    respond = async () => ({ module: 'toxo', recordings: ['../outside.mp3'] })
    await expect(endpoint.restoreRecordings({ module: 'toxo', recordings: ['../outside.mp3'] }, signal())).rejects.toHaveProperty('code', 'gateway/bad-request')
    expect(calls).toEqual([])
    await expect(endpoint.hideLecture({ module: 'toxo', title: 'Shock' }, signal())).rejects.toHaveProperty('code', 'transcriber-engine/invalid-edit-result')
  })

  it('preserves manual definitions and the module question bank in lecture listings', () => {
    const listing = { module: 'toxo', questions: 'needs-conversion', materials: [], lectures: [{
      title: 'Shock', id: 'shock', origin: 'manual', materials: ['Shock.pdf'], recording_sources: ['Shock.m4a'], paths: [],
      parts: 1, transcribed: false, in_notebook_only: false,
    }] }
    expect(parseLectureListingOutput(frame(listing), 'toxo')).toEqual(listing)
  })

  it('routes inventory and confirmed student edits to the registry MCP tools', async () => {
    respond = async tool => ({ list_module_files: inventory, define_lecture: definition, delete_lecture: { deleted: 'shock' },
      rename_file: { path: join(root, 'modules', 'toxo', 'Lecture', 'New.m4a') }, remove_file: { trash_path: 'trash/old.m4a' }, upload_recordings: uploaded })[tool]
    expect(await endpoint.listModuleFiles({ module: 'toxo' }, signal())).toEqual(inventory)
    expect(await endpoint.defineLecture({ module: 'toxo', ...definition }, signal())).toEqual(definition)
    expect(await endpoint.deleteLecture({ module: 'toxo', id: 'shock' }, signal())).toEqual({ deleted: 'shock' })
    expect(await endpoint.renameFile({ module: 'toxo', path: 'Lecture/Shock.m4a', new_name: 'New.m4a' }, signal())).toEqual({ path: 'Lecture/New.m4a' })
    expect(await endpoint.removeFile({ module: 'toxo', path: 'Lecture/Shock.m4a' }, signal())).toEqual({ trash_path: 'trash/old.m4a' })
    expect(await endpoint.uploadRecordings({ module: 'toxo', files: ['Lecture/Shock.m4a'] }, signal())).toEqual(uploaded)
    expect(calls.map(call => call.tool)).toEqual(['list_module_files', 'define_lecture', 'delete_lecture', 'rename_file', 'remove_file', 'upload_recordings'])
    for (const call of calls) expect(call.arguments.confirmed).toBe(true)
    expect(calls[1]?.arguments).toEqual({ module: 'toxo', id: 'shock', title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'], confirmed: true })
  })

  it('reads the whole library and preserves isolated errors, presence timestamps, and question status', async () => {
    const listing = { module: 'toxo', lectures: [{ title: 'Shock', recording_sources: ['Shock.m4a'], paths: [],
      parts: 1, transcribed: false, in_notebook_only: false, in_notebook: null }], materials: [],
    questions: 'indexed', remote_as_of: null, warning: 'Offline' }
    const library = { workspace: root, modules: [{ ...listing, display_name: 'Toxo', root: 'module-root', notebooks: ['nb'],
      exam_index: 'stale', question_files: 3 }, { module: 'broken', display_name: 'Broken', root: 'broken-root', notebooks: [], error: 'Bad module' }] }
    respond = async tool => tool === 'list_library' ? library : listing
    expect(await endpoint.listLibrary({ remote: 'skip' }, signal())).toEqual(library)
    expect(calls[0]).toEqual({ tool: 'list_library', arguments: { remote: 'skip' } })
    expect(specs[0]?.stdio.stdout).toEqual({ maxBytes: 4 * 1024 * 1024 })
    expect(specs[0]?.stdio.stderr).toEqual({ maxBytes: 4 * 1024 * 1024 })
    expect(await endpoint.listLectures({ module: 'toxo', refresh: true }, signal())).toEqual(listing)
    expect(calls[1]?.arguments).toEqual({ module: 'toxo', refresh: true })
    respond = async () => ({ ...inventory, remote_as_of: '2026-10-02T10:00:00Z' })
    expect((await endpoint.listModuleFiles({ module: 'toxo', refresh: true }, signal())).remote_as_of).toBe('2026-10-02T10:00:00Z')
    expect(calls[2]?.arguments.refresh).toBe(true)
  })

  it('validates proposals and sends only confirmed definitions when applying an organization', async () => {
    const proposal = { source: 'agy', lectures: [{ title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'],
      existing_id: 'shock', change: 'same' }], unassigned: { recordings: [], materials: ['Book.pdf'] }, notes: ['Shared book'] }
    respond = async tool => tool === 'propose_organization' ? proposal : { module: 'toxo', lectures: [definition] }
    expect(await endpoint.proposeOrganization({ module: 'toxo', refresh: true }, signal())).toEqual(proposal)
    expect(await endpoint.applyOrganization({ module: 'toxo', lectures: [definition], replaceExisting: true }, signal())).toEqual({ module: 'toxo', lectures: [definition] })
    expect(calls[1]?.arguments).toEqual({ module: 'toxo', lectures: [{ id: 'shock', title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'] }],
      replace_existing: true, confirmed: true })
  })

  it('waits for the exam launcher text, preserving its summary rather than parsing it as JSON', async () => {
    const output = 'Exam index: 12 questions\n-> /workspace/modules/toxo/Questions/exam-index.json\n'
    respond = async () => JSON.stringify({ id: 2, result: { content: [{ text: output }] } })
    expect(await endpoint.buildExamIndex({ module: 'toxo' }, signal())).toEqual({ output })
    expect(calls[0]?.tool).toBe('build_exam_index')
  })

  it.each(['proposeOrganization', 'buildExamIndex'] as const)('cancels %s at its configured deadline', async (method) => {
    endpoint = new TranscriberEngine(new Context(), {
      environment: { TRANSCRIBER_WORKSPACE: root, TRANSCRIBER_SKILL_ROOT: '/skill' }, fileExists: () => true, spawn,
      organizationTimeoutMs: 300000, examIndexTimeoutMs: 1200000,
    })
    let ready!: () => void
    const spawned = new Promise<void>((resolve) => { ready = resolve })
    respond = async (_tool, _arguments, callSignal) => new Promise((resolve) => {
      callSignal.addEventListener('abort', () => { resolve({}) }, { once: true })
      ready()
    })
    vi.useFakeTimers()
    const reading = endpoint[method]({ module: 'toxo' }, signal())
    const rejected = expect(reading).rejects.toMatchObject({ code: 'transcriber-engine/tool-timeout' })
    await spawned
    await vi.advanceTimersByTimeAsync(method === 'proposeOrganization' ? 300000 : 1200000)
    await rejected
  })

  it.each([
    ['proposeOrganization', { source: 'unknown', lectures: [], unassigned: { recordings: [], materials: [] }, notes: [] }],
    ['applyOrganization', { module: 'toxo', lectures: [{ ...definition, created: 3 }] }],
  ] as const)('rejects malformed %s output', async (method, answer) => {
    respond = async () => answer
    const request = { module: 'toxo', lectures: [], replaceExisting: false }
    await expect(endpoint[method](request, signal())).rejects.toMatchObject({ code: 'transcriber-engine/invalid-edit-result' })
  })

  it.each(['listLibrary', 'proposeOrganization', 'applyOrganization', 'buildExamIndex'] as const)(
    'reports an engine refusal from %s as a typed failure', async (method) => {
      respond = async () => JSON.stringify({ id: 2, result: { isError: true, content: [{ text: 'Engine refused' }] } })
      const request = { module: 'toxo', remote: 'cached' as const, lectures: [], replaceExisting: false }
      await expect(endpoint[method](request, signal())).rejects.toMatchObject({
        code: method === 'listLibrary' ? 'transcriber-engine/invalid-modules' : 'transcriber-engine/edit-rejected',
      })
    },
  )

  it('refuses a malformed library answer and invalid read flags', async () => {
    respond = async () => ({ workspace: root, modules: [{ module: 'toxo' }] })
    await expect(endpoint.listLibrary({}, signal())).rejects.toMatchObject({ code: 'transcriber-engine/invalid-modules' })
    calls.length = 0
    await expect(endpoint.listLibrary({ remote: 'bad' } as never, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(endpoint.listLectures({ module: 'toxo', refresh: 'yes' } as never, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it.each([
    ['refused', JSON.stringify({ id: 2, result: { isError: true, content: [{ text: 'File already exists' }] } }), 'transcriber-engine/edit-rejected'],
    ['RPC refusal', JSON.stringify({ id: 2, error: { message: 'Unknown module' } }), 'transcriber-engine/edit-rejected'],
    ['invalid JSON', JSON.stringify({ id: 2, result: { content: [{ text: '{' }] } }), 'transcriber-engine/invalid-edit-result'],
    ['invalid fields', { module: 'toxo', files: [{ ...inventory.files[0], size_bytes: -1 }] }, 'transcriber-engine/invalid-edit-result'],
    ['escaped inventory', { module: 'toxo', files: [{ ...inventory.files[0], path: '../outside' }] }, 'transcriber-engine/invalid-edit-result'],
  ])('reports %s as a typed error', async (_name, answer, code) => {
    respond = async () => answer
    await expect(endpoint.listModuleFiles({ module: 'toxo' }, signal())).rejects.toMatchObject({ code })
  })

  it.each(['../outside', '.', '/absolute', 'C:\\outside', 'missing'])('refuses invalid or absent module %s before MCP starts', async (module) => {
    await expect(endpoint.listModuleFiles({ module }, signal())).rejects.toMatchObject({ code: module === 'missing' ? 'transcriber-engine/edit-unavailable' : 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it('refuses a module symlink resolving outside modules/', async () => {
    await mkdir(join(root, 'private'))
    await writeFile(join(root, 'private', 'module.json'), '{}')
    await symlink(join(root, 'private'), join(root, 'modules', 'escape'), 'junction')
    await expect(endpoint.listModuleFiles({ module: 'escape' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it('refuses traversal and invalid rename arguments before MCP starts', async () => {
    await expect(endpoint.removeFile({ module: 'toxo', path: 'Lecture/../../outside' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    await expect(endpoint.renameFile({ module: 'toxo', path: 'Lecture/Shock.m4a', new_name: '../New.m4a' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it.each(['success', 'refused', 'cancelled'] as const)('removes browser staging after %s', async (settlement) => {
    const abort = new AbortController()
    const bytes = Buffer.from([0, 255, 1, 128])
    let source = ''
    respond = async (_tool, arguments_) => {
      source = String(arguments_.source_path)
      expect(await readFile(source)).toEqual(bytes)
      expect(arguments_).toMatchObject({ kind: 'recording', name: 'Shock.m4a', replace: false, confirmed: true })
      if (settlement === 'cancelled') abort.abort()
      if (settlement === 'refused') return JSON.stringify({ id: 2, result: { isError: true, content: [{ text: 'Collision' }] } })
      return { path: join(root, 'modules', 'toxo', 'Lecture', 'Shock.m4a'), kind: 'recording', size_bytes: bytes.length }
    }
    const promise = endpoint.importFile({ module: 'toxo', name: 'Shock.m4a', kind: 'recording', bytes: bytes.toString('base64'), replace: false }, abort.signal)
    if (settlement === 'success') expect(await promise).toEqual({ path: 'Lecture/Shock.m4a', kind: 'recording', size_bytes: 4 })
    else await expect(promise).rejects.toMatchObject({ code: settlement === 'cancelled' ? 'gateway/cancelled' : 'transcriber-engine/edit-rejected' })
    await expect(stat(dirname(source))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('imports a 70 MiB recording within the default unary HTTP body budget', async () => {
    const bytes = Buffer.alloc(70 * 1024 * 1024, 7)
    const request = { module: 'toxo', name: 'Large.m4a', kind: 'recording' as const, bytes: bytes.toString('base64') }
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(300 * 1024 * 1024)
    respond = async (_tool, arguments_) => {
      expect((await stat(String(arguments_.source_path))).size).toBe(bytes.length)
      return { path: join(root, 'modules', 'toxo', 'Lecture', 'Large.m4a'), kind: 'recording', size_bytes: bytes.length }
    }
    expect((await endpoint.importFile(request, signal())).size_bytes).toBe(bytes.length)
  })

  it('rejects noncanonical bytes, traversal names, and oversized imports before staging', async () => {
    endpoint = new TranscriberEngine(new Context(), { environment: { TRANSCRIBER_WORKSPACE: root }, maxImportBytes: 2, spawn })
    for (const bytes of ['!!!!', Buffer.alloc(3).toString('base64')]) {
      await expect(endpoint.importFile({ module: 'toxo', name: 'File.m4a', kind: 'recording', bytes }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    await expect(endpoint.importFile({ module: 'toxo', name: '../File.m4a', kind: 'recording', bytes: '' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it('cancels before a registry call begins', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(endpoint.listModuleFiles({ module: 'toxo' }, abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(calls).toEqual([])
  })
})

describe('session-free module creation', () => {
  const created = { module: 'new-module-2', displayName: 'New module' }
  const textResponse = (text: string): string => JSON.stringify({ id: 2, result: { content: [{ type: 'text', text }] } })

  it('creates an absent module with explicit confirmation and reads fresh listings afterwards', async () => {
    let exists = false
    respond = async (tool, args) => {
      if (tool === 'create_module') {
        expect(args).toEqual({ module: created.module, display_name: created.displayName, confirmed: true })
        await mkdir(join(root, 'modules', created.module))
        exists = true
        return textResponse('Created module and notebook')
      }
      return { workspace: root, modules: exists ? [{ module: created.module, display_name: created.displayName, notebooks: ['nb'], root }] : [] }
    }
    expect((await endpoint.listLibrary({}, signal())).modules).toEqual([])
    expect(await endpoint.createModule(created, signal())).toBe('Created module and notebook')
    expect((await stat(join(root, 'modules', created.module))).isDirectory()).toBe(true)
    expect((await endpoint.listModules(signal())).modules[0]?.module).toBe(created.module)
    respond = async () => ({ workspace: root, modules: [{ module: created.module, display_name: created.displayName, notebooks: ['nb'], root,
      lectures: [], materials: [], exam_index: 'missing', question_files: 0 }] })
    expect((await endpoint.listLibrary({}, signal())).modules[0]?.module).toBe(created.module)
  })

  it.each(['', 'UPPER', 'two words', 'a_b', '../escape', 'a/b', 'a.b', 'عربي'])('refuses the slug %s before starting MCP', async (module) => {
    await expect(endpoint.createModule({ ...created, module }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it('refuses an empty display name before starting MCP', async () => {
    await expect(endpoint.createModule({ ...created, displayName: '' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it.each([
    ['RPC refusal', JSON.stringify({ id: 2, error: { message: 'Notebook unavailable' } }), 'edit-rejected'],
    ['tool refusal', JSON.stringify({ id: 2, result: { isError: true, content: [{ text: 'Already exists' }] } }), 'edit-rejected'],
    ['empty refusal', JSON.stringify({ id: 2, result: { isError: true } }), 'edit-rejected'],
    ['missing frame', '{}', 'invalid-edit-result'],
    ['missing text', JSON.stringify({ id: 2, result: { content: [] } }), 'invalid-edit-result'],
  ])('returns a typed %s', async (_name, answer, code) => {
    respond = async () => answer
    await expect(endpoint.createModule(created, signal())).rejects.toMatchObject({ code: `transcriber-engine/${code}` })
  })

  it('cancels module creation at the configured deadline', async () => {
    vi.useFakeTimers()
    endpoint = new TranscriberEngine(new Context(), {
      environment: { TRANSCRIBER_WORKSPACE: root, TRANSCRIBER_SKILL_ROOT: '/skill' }, fileExists: () => true, spawn, createModuleTimeoutMs: 10,
    })
    respond = async (_tool, _args, callSignal) => new Promise((_resolve, reject) => {
      callSignal.addEventListener('abort', () => { reject(new Error('engine cancelled')) }, { once: true })
    })
    const pending = expect(endpoint.createModule(created, signal())).rejects.toMatchObject({
      code: 'transcriber-engine/tool-timeout', details: { tool: 'create_module', timeoutMs: 10 },
    })
    await vi.advanceTimersByTimeAsync(10)
    await pending
  })

  it('preserves caller cancellation instead of reporting a deadline', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(endpoint.createModule(created, abort.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
    expect(calls).toEqual([])
  })
})

describe('module-wide sources', () => {
  it.each([{ materials: ['Book.pdf', 'notes/Overview.pdf'] }, { materials: [] }])('saves the selection $materials without a confirmation argument', async ({ materials }) => {
    respond = async (_tool, args) => ({ module: args.module, general_materials: args.materials })
    expect(await endpoint.setGeneralMaterials({ module: 'toxo', materials }, signal())).toEqual({ module: 'toxo', general_materials: materials })
    expect(calls).toEqual([{ tool: 'set_general_materials', arguments: { module: 'toxo', materials } }])
  })

  it('preserves optional fields in lecture, library, and file inventories', async () => {
    const listing = { module: 'toxo', lectures: [], materials: [], general_materials: ['Book.pdf', 'notes/Overview.pdf'] }
    const library = { workspace: root, modules: [{ ...listing, display_name: 'Toxo', root, notebooks: [], exam_index: 'missing', question_files: 0 },
      { module: 'broken', display_name: 'Broken', root, notebooks: [], error: 'Offline', general_materials: ['Shared.pdf'] }] }
    const files = { ...inventory, files: [{ ...inventory.files[0], general: true }, { ...inventory.files[0], general: false }] }
    respond = async tool => ({ list_lectures: listing, list_library: library, list_module_files: files })[tool]
    expect(await endpoint.listLectures({ module: 'toxo' }, signal())).toEqual(listing)
    expect(await endpoint.listLibrary({}, signal())).toEqual(library)
    expect(await endpoint.listModuleFiles({ module: 'toxo' }, signal())).toEqual(files)
  })

  it.each([{ general: ['Book.pdf'] }, { general: [] }])('preserves organization general sources $general through proposal and application', async ({ general }) => {
    const proposal = { source: 'automatic', lectures: [], unassigned: { recordings: [], materials: [] }, notes: [], general }
    respond = async tool => tool === 'propose_organization' ? proposal : { module: 'toxo', lectures: [] }
    expect(await endpoint.proposeOrganization({ module: 'toxo' }, signal())).toEqual(proposal)
    expect(await endpoint.applyOrganization({ module: 'toxo', lectures: [], replaceExisting: false, general }, signal())).toEqual({ module: 'toxo', lectures: [] })
    expect(calls[1]?.arguments).toEqual({ module: 'toxo', lectures: [], replace_existing: false, general, confirmed: true })
  })

  it.each([
    { module: '../outside', materials: [] },
    { module: 'toxo', materials: ['../outside.pdf'] },
    { module: 'toxo', materials: ['/absolute.pdf'] },
    { module: 'toxo', materials: ['C:\\outside.pdf'] },
    { module: 'toxo', materials: [''] },
  ])('refuses unsafe module or material paths %j before starting MCP', async (request) => {
    await expect(endpoint.setGeneralMaterials(request, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it.each([
    ['RPC refusal', JSON.stringify({ id: 2, error: { message: 'Unknown material' } }), 'edit-rejected'],
    ['tool refusal', JSON.stringify({ id: 2, result: { isError: true, content: [{ text: 'Unknown material' }] } }), 'edit-rejected'],
    ['wrong array', { module: 'toxo', general_materials: [42] }, 'invalid-edit-result'],
    ['missing array', { module: 'toxo' }, 'invalid-edit-result'],
    ['escaped path', { module: 'toxo', general_materials: ['../outside.pdf'] }, 'invalid-edit-result'],
    ['invalid JSON', JSON.stringify({ id: 2, result: { content: [{ text: '{' }] } }), 'invalid-edit-result'],
  ])('returns a typed %s when saving general materials', async (_name, answer, code) => {
    respond = async () => answer
    await expect(endpoint.setGeneralMaterials({ module: 'toxo', materials: [] }, signal())).rejects.toMatchObject({ code: `transcriber-engine/${code}` })
  })

  it.each([
    ['listLectures', { module: 'toxo', lectures: [], materials: [], general_materials: [42] }, 'invalid-listing'],
    ['listLibrary', { workspace: 'root', modules: [{ module: 'toxo', display_name: 'Toxo', root: 'root', notebooks: [], error: 'Offline', general_materials: [42] }] }, 'invalid-modules'],
    ['listModuleFiles', { ...inventory, files: [{ ...inventory.files[0], general: 'yes' }] }, 'invalid-edit-result'],
    ['proposeOrganization', { source: 'automatic', lectures: [], unassigned: { recordings: [], materials: [] }, notes: [], general: [42] }, 'invalid-edit-result'],
  ] as const)('refuses malformed optional fields from %s', async (method, answer, code) => {
    respond = async () => answer
    await expect(endpoint[method]({ module: 'toxo' }, signal())).rejects.toMatchObject({ code: `transcriber-engine/${code}` })
  })

  it('refuses traversal in organization general sources before starting MCP', async () => {
    await expect(endpoint.applyOrganization({ module: 'toxo', lectures: [], replaceExisting: false, general: ['../outside.pdf'] }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(calls).toEqual([])
  })

  it.each(['deadline', 'caller'] as const)('cancels source selection through the %s signal', async (owner) => {
    endpoint = new TranscriberEngine(new Context(), {
      environment: { TRANSCRIBER_WORKSPACE: root, TRANSCRIBER_SKILL_ROOT: '/skill' }, fileExists: () => true, spawn, generalMaterialsTimeoutMs: 10,
    })
    let ready!: () => void
    const spawned = new Promise<void>((resolve) => { ready = resolve })
    respond = async (_tool, _args, callSignal) => new Promise((resolve) => {
      callSignal.addEventListener('abort', () => { resolve({}) }, { once: true })
      ready()
    })
    vi.useFakeTimers()
    const abort = new AbortController()
    const rejected = expect(endpoint.setGeneralMaterials({ module: 'toxo', materials: [] }, abort.signal)).rejects.toMatchObject({
      code: owner === 'deadline' ? 'transcriber-engine/tool-timeout' : 'gateway/cancelled',
    })
    await spawned
    if (owner === 'deadline') await vi.advanceTimersByTimeAsync(10)
    else abort.abort()
    await rejected
  })
})
