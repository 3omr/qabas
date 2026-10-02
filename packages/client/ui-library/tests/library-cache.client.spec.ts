// @vitest-environment jsdom
/** Whole-library reads and browser recovery through the real library service. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { TranscriberLibraryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { LibraryService, type LibraryEngine } from '../src/client/service.ts'

const listing: TranscriberLibraryListing = { workspace: '/study', modules: [{
  module: 'eye', display_name: 'Eyes', root: '/study/modules/eye', notebooks: ['nb'],
  lectures: [{ title: 'Orbit', parts: 1, recording_sources: ['Orbit.mp3'], paths: [],
    in_notebook_only: true, transcribed: true, state: 'final', transcript: '/study/Orbit.md' }],
  materials: [{ name: 'Book.pdf', path: '/study/Book.pdf' }], questions: 'indexed',
  remote_as_of: '2026-10-02T10:00:00Z', exam_index: 'stale', question_files: 2, warning: 'Offline cache',
}, { module: 'broken', display_name: 'Broken', root: '/study/modules/broken', notebooks: [], error: 'Bad module' }] }

const ok = <T>(value: T) => ({ ok: true as const, value })
const contexts: Context[] = []
function engine(): LibraryEngine {
  return { listLibrary: vi.fn(async () => ok(listing)),
    listModules: vi.fn(async () => ok({ workspace: '/study', modules: listing.modules })),
    listLectures: vi.fn(async () => ok({ lectures: [], materials: [] })) }
}
function library(source: LibraryEngine): LibraryService {
  const ctx = new Context()
  contexts.push(ctx)
  return new LibraryService(ctx, source)
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  localStorage.clear()
})

it('loads all contents with one call, isolates a failed module, and refreshes notebook presence on request', async () => {
  const source = engine()
  const service = library(source)
  await service.loadModules()
  service.navigate({ kind: 'module', module: 'eye' })
  service.navigate({ kind: 'lecture', module: 'eye', lecture: 'Orbit' })
  expect(source.listLibrary).toHaveBeenCalledTimes(1)
  expect(source.listLibrary).toHaveBeenCalledWith({ remote: 'cached' }, expect.any(AbortSignal))
  expect(source.listModules).not.toHaveBeenCalled()
  expect(source.listLectures).not.toHaveBeenCalled()
  expect(service.state.getSnapshot().contents).toMatchObject({ eye: { status: 'ready', refreshing: false, value: {
    questionIndex: { state: 'stale', files: 2 }, remoteAsOf: '2026-10-02T10:00:00Z', warning: 'Offline cache',
    lectures: [{ title: 'Orbit', state: 'final', inNotebookOnly: true, transcript: '/study/Orbit.md' }],
  } }, broken: { status: 'failed', message: 'Bad module' } })
  await service.refresh()
  expect(source.listLibrary).toHaveBeenLastCalledWith({ remote: 'refresh' }, expect.any(AbortSignal))
  expect(source.listLectures).not.toHaveBeenCalled()
})

it('paints a stored snapshot immediately while waiting for its fresh replacement', async () => {
  await library(engine()).loadModules()
  let release!: (answer: Awaited<ReturnType<NonNullable<LibraryEngine['listLibrary']>>>) => void
  const source = engine()
  source.listLibrary = () => new Promise((resolve) => { release = resolve })
  const service = library(source)
  expect(service.state.getSnapshot()).toMatchObject({ workspace: '/study', modules: { status: 'ready', refreshing: true },
    contents: { eye: { status: 'ready', refreshing: true, value: { questionIndex: { state: 'stale', files: 2 } } } } })
  const reading = service.loadModules()
  release(ok({ workspace: '/other', modules: [] }))
  await reading
  expect(service.state.getSnapshot()).toMatchObject({ workspace: '/other', contents: {}, modules: { status: 'ready', refreshing: false, value: [] } })
  expect(localStorage.getItem('qabas.library.v1:/study')).not.toBeNull()
  expect(localStorage.getItem('qabas.library.v1:/other')).not.toBeNull()
})

it.each(['getItem', 'setItem'] as const)('keeps the live library usable when storage %s throws', async (method) => {
  vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
  const service = library(engine())
  await service.loadModules()
  expect(service.state.getSnapshot().modules.status).toBe('ready')
  expect(service.state.getSnapshot().contents.eye?.status).toBe('ready')
})

it.each(['{', '{"workspace":"/wrong"}', '{"workspace":"/study","modules":[],"contents":{}}'])('discards corrupt or incompatible storage %s', async (contents) => {
  localStorage.setItem('qabas.library.v1', '/study')
  localStorage.setItem('qabas.library.v1:/study', contents)
  const service = library(engine())
  expect(service.state.getSnapshot().modules.status).toBe('loading')
  await service.loadModules()
  expect(service.state.getSnapshot().modules.status).toBe('ready')
})

it('uses the older listing path when the mounted Remote lacks listLibrary', async () => {
  const source = engine()
  delete source.listLibrary
  const service = library(source)
  await service.loadModules()
  service.navigate({ kind: 'module', module: 'eye' })
  await vi.waitFor(() => { expect(service.state.getSnapshot().contents.eye?.status).toBe('ready') })
  expect(source.listModules).toHaveBeenCalledTimes(1)
  expect(source.listLectures).toHaveBeenCalledWith({ module: 'eye' }, expect.any(AbortSignal))
})

it('reloads only the edited module with fresh presence after a notebook write and retains built question status', async () => {
  const source = engine()
  const service = library(source)
  await service.loadModules()
  service.invalidateNotebook('eye')
  service.questionIndexBuilt('eye')
  await service.loadModule('eye')
  expect(source.listLibrary).toHaveBeenCalledTimes(1)
  expect(source.listLectures).toHaveBeenCalledWith({ module: 'eye', refresh: true }, expect.any(AbortSignal))
  expect(service.state.getSnapshot().contents.eye).toMatchObject({ status: 'ready', value: { questionIndex: { state: 'built', files: 2 } } })
})

it('keeps a module answer newer than an overlapping whole-library refresh', async () => {
  const source = engine()
  const service = library(source)
  await service.loadModules()
  let release!: (answer: Awaited<ReturnType<NonNullable<LibraryEngine['listLibrary']>>>) => void
  source.listLibrary = () => new Promise((resolve) => { release = resolve })
  const refresh = service.refresh()
  await service.loadModule('eye')
  release(ok(listing))
  await refresh
  expect(service.state.getSnapshot().contents.eye).toMatchObject({ status: 'ready', value: { lectures: [] } })
})

it('waits for the whole-library answer when an older cached snapshot has no module contents', async () => {
  const older = engine()
  delete older.listLibrary
  await library(older).loadModules()
  const source = engine()
  let release!: (answer: Awaited<ReturnType<NonNullable<LibraryEngine['listLibrary']>>>) => void
  source.listLibrary = () => new Promise((resolve) => { release = resolve })
  const service = library(source)
  const reading = service.loadModules()
  service.navigate({ kind: 'module', module: 'eye' })
  expect(source.listLectures).not.toHaveBeenCalled()
  release(ok(listing))
  await reading
  expect(service.state.getSnapshot().contents.eye?.status).toBe('ready')
})
