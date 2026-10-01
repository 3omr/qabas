/**
 * The library service against a scripted engine: what it stores while reading
 * and after, what it does with a failure, that a superseded read never lands,
 * and the action and opener registries other plugins extend it through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LibraryService, type LibraryAction, type LibraryEngine } from '../src/client/service.ts'

const MODULES = {
  workspace: '/w',
  modules: [{ module: 'ophtha', display_name: 'Ophthalmology', notebooks: ['nb'], root: '/w/modules/ophtha' }],
}

const LECTURES = {
  lectures: [
    { title: 'Orbit', parts: 1, recording_sources: ['Orbit.mp3'], transcribed: true, state: 'final' as const, transcript: '/w/t.md', draft: null, verbatim: null },
    { title: 'Conjunctiva', parts: 1, recording_sources: ['Conjunctiva.mp3'], transcribed: false },
  ],
  materials: [{ name: 'Book.pdf', path: 'Lecture/Book.pdf' }],
}

async function LECTURES_ANSWER(): ReturnType<LibraryEngine['listLectures']> {
  return { ok: true, value: LECTURES }
}

function engine(overrides: Partial<LibraryEngine> = {}): LibraryEngine {
  return {
    listModules: vi.fn(async () => ({ ok: true as const, value: MODULES })),
    listLectures: vi.fn(async () => ({ ok: true as const, value: LECTURES })),
    ...overrides,
  }
}

const services: LibraryService[] = []
function service(source: LibraryEngine): LibraryService {
  const created = new LibraryService(new Context(), source)
  services.push(created)
  return created
}

afterEach(() => {
  services.length = 0
})

describe('LibraryService reads', () => {
  it('stores the modules and the workspace they live in', async () => {
    const library = service(engine())
    expect(library.state.getSnapshot().modules.status).toBe('loading')
    await library.loadModules()
    const { modules, workspace } = library.state.getSnapshot()
    expect(workspace).toBe('/w')
    expect(modules).toEqual({
      status: 'ready',
      refreshing: false,
      value: [{ id: 'ophtha', displayName: 'Ophthalmology', notebooks: ['nb'], root: '/w/modules/ophtha' }],
    })
  })

  it('reads a module when it is first opened, and not again', async () => {
    const listLectures = vi.fn(LECTURES_ANSWER)
    const source = engine({ listLectures })
    const library = service(source)
    await library.loadModules()
    library.navigate({ kind: 'module', module: 'ophtha' })
    await vi.waitFor(() => { expect(library.state.getSnapshot().contents.ophtha?.status).toBe('ready') })
    library.navigate({ kind: 'lecture', module: 'ophtha', lecture: 'Orbit' })
    library.navigate({ kind: 'home' })
    expect(listLectures).toHaveBeenCalledTimes(1)
    const contents = library.state.getSnapshot().contents.ophtha
    expect(contents?.status === 'ready' && contents.value.lectures.map(lecture => lecture.state)).toEqual(['final', 'pending'])
  })

  it('keeps the last answer on screen while a refresh is in flight', async () => {
    let release: () => void = () => undefined
    const source = engine()
    const library = service(source)
    await library.loadModules()
    source.listModules = vi.fn((): ReturnType<LibraryEngine['listModules']> => new Promise((resolve) => {
      release = () => { resolve({ ok: true, value: MODULES }) }
    }))
    const refreshing = library.refresh()
    expect(library.state.getSnapshot().modules).toMatchObject({ status: 'ready', refreshing: true })
    release()
    await refreshing
    expect(library.state.getSnapshot().modules).toMatchObject({ status: 'ready', refreshing: false })
  })

  it('reports a failed read in the engine\'s words', async () => {
    const failure = { code: 'transcriber-engine/unavailable', message: 'nlm is not signed in' }
    const library = service(engine({
      listModules: async () => ({ ok: false, error: failure }) as never,
      listLectures: async () => ({ ok: false, error: failure }) as never,
    }))
    await library.loadModules()
    await library.loadModule('ophtha')
    expect(library.state.getSnapshot().modules).toEqual({ status: 'failed', message: 'nlm is not signed in' })
    expect(library.state.getSnapshot().contents.ophtha).toEqual({ status: 'failed', message: 'nlm is not signed in' })
  })

  it('reports a read that throws the same way', async () => {
    const library = service(engine({ listModules: async () => { throw new Error('not mounted') } }))
    await library.loadModules()
    expect(library.state.getSnapshot().modules).toEqual({ status: 'failed', message: 'not mounted' })
    const strings = service(engine({ listModules: async () => { throw 'plain' as unknown as Error } }))
    await strings.loadModules()
    expect(strings.state.getSnapshot().modules).toEqual({ status: 'failed', message: 'plain' })
  })

  it('drops an answer a newer read superseded', async () => {
    const answers: ((value: Awaited<ReturnType<LibraryEngine['listLectures']>>) => void)[] = []
    const library = service(engine({
      listLectures: () => new Promise((resolve) => { answers.push(resolve) }),
    }))
    const first = library.loadModule('ophtha')
    const second = library.loadModule('ophtha')
    answers[0]?.({ ok: true, value: { lectures: [], materials: [], warning: 'stale' } })
    answers[1]?.({ ok: true, value: LECTURES })
    await Promise.all([first, second])
    const contents = library.state.getSnapshot().contents.ophtha
    expect(contents?.status === 'ready' && contents.value.warning).toBeUndefined()
    expect(contents?.status === 'ready' && contents.value.lectures).toHaveLength(2)
  })

  it('stores a notebook warning beside the local list', async () => {
    const library = service(engine({
      listLectures: async () => ({ ok: true, value: { ...LECTURES, warning: 'notebook down' } }),
    }))
    await library.loadModule('ophtha')
    const contents = library.state.getSnapshot().contents.ophtha
    expect(contents?.status === 'ready' && contents.value.warning).toBe('notebook down')
  })

  it('ignores answers that arrive after disposal, and drops a thrown one too', async () => {
    let release: () => void = () => undefined
    let fail: () => void = () => undefined
    const root = new Context()
    let library: LibraryService | undefined
    const fork = root.plugin({
      apply(ctx: Context) {
        library = new LibraryService(ctx, engine({
          listModules: () => new Promise((resolve) => { release = () => { resolve({ ok: true, value: MODULES }) } }),
          listLectures: () => new Promise((_, reject) => { fail = () => { reject(new Error('late')) } }),
        }))
      },
    })
    await vi.waitFor(() => { expect(library).toBeDefined() })
    if (library === undefined) return
    const reading = library.loadModules()
    const module = library.loadModule('ophtha')
    await fork.dispose()
    release()
    fail()
    await Promise.all([reading, module])
    expect(library.state.getSnapshot().modules.status).toBe('loading')
    expect(library.state.getSnapshot().contents.ophtha?.status).toBe('loading')
  })
})

describe('LibraryService targets', () => {
  it('resolves the route to its module and lecture once both are read', async () => {
    const library = service(engine())
    expect(library.currentTarget()).toBeUndefined()
    await library.loadModules()
    library.navigate({ kind: 'lecture', module: 'ophtha', lecture: 'Orbit' })
    expect(library.currentTarget()?.lecture).toBeUndefined()
    await vi.waitFor(() => { expect(library.currentTarget()?.lecture?.title).toBe('Orbit') })
    library.navigate({ kind: 'module', module: 'ophtha' })
    expect(library.currentTarget()?.module.id).toBe('ophtha')
    expect(library.currentTarget()?.lecture).toBeUndefined()
    library.navigate({ kind: 'lecture', module: 'ophtha', lecture: 'Gone' })
    expect(library.currentTarget()?.lecture).toBeUndefined()
    library.navigate({ kind: 'module', module: 'missing' })
    expect(library.currentTarget()).toBeUndefined()
  })
})

describe('LibraryService registries', () => {
  const action = (id: string, order?: number): LibraryAction => ({
    id,
    ...order === undefined ? {} : { order },
    scope: 'lecture',
    label: () => id,
    appliesTo: () => true,
    run: () => undefined,
  })

  it('orders actions, replaces one by id, and removes only its own registration', () => {
    const library = service(engine())
    const disposeB = library.registerAction(action('b', 20))
    library.registerAction(action('a', 10))
    library.registerAction(action('c'))
    expect(library.actions.getSnapshot().map(item => item.id)).toEqual(['c', 'a', 'b'])
    const replacement = action('b', 5)
    library.registerAction(replacement)
    disposeB()
    expect(library.actions.getSnapshot().map(item => item.id)).toEqual(['c', 'b', 'a'])
    expect(library.actions.getSnapshot()[1]).toBe(replacement)
  })

  it('opens files through the last opener registered, and through nothing after it is gone', () => {
    const library = service(engine())
    library.open('/w/a.md')
    expect(library.canOpen).toBe(false)
    const first = vi.fn()
    const second = vi.fn()
    library.registerOpener(first)
    const disposeSecond = library.registerOpener(second)
    library.open('/w/a.md')
    expect(second).toHaveBeenCalledWith('/w/a.md')
    expect(first).not.toHaveBeenCalled()
    disposeSecond()
    disposeSecond()
    expect(library.canOpen).toBe(false)
  })
})
