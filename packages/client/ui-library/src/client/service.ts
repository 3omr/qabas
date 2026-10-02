/** Shared library selection, engine reads, and registries for actions and file openers. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { readLibraryCache, writeLibraryCache } from './cache.ts'
import type { TranscriberLibraryListing, TranscriberLibraryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  lectureFromEngine, type EngineLectureEntry, type LibraryLecture, type LibraryMaterial,
  type LibraryModule, type ModuleContents,
} from './model.ts'
import type { LectureEditing, LibrarySetup } from './editing.ts'

/** Where the library panel is. */
export type LibraryRoute =
  | { readonly kind: 'home' }
  | { readonly kind: 'module'; readonly module: string }
  | { readonly kind: 'lecture'; readonly module: string; readonly lecture: string }

/** Something the library read, while it is being read and after. */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T; readonly refreshing: boolean }
  | { readonly status: 'failed'; readonly message: string }

/** Everything the library panel and the sidebar tree draw. */
export interface LibraryState {
  readonly route: LibraryRoute
  /** The workspace the engine serves, once it has answered. */
  readonly workspace?: string
  readonly modules: Loadable<readonly LibraryModule[]>
  /** Per-module lectures, keyed by module id; absent until first asked for. */
  readonly contents: Readonly<Record<string, Loadable<ModuleContents>>>
}

/** The module and, for lecture-scoped actions, the lecture an action runs on. */
export interface LibraryTarget {
  readonly module: LibraryModule
  readonly lecture?: LibraryLecture
}

/** A button the library draws on a module or lecture page. */
export interface LibraryAction {
  /** Stable id; registering the same id again replaces the earlier action. */
  readonly id: string
  /** Lower sorts first. */
  readonly order?: number
  /** Where the action is offered. */
  readonly scope: 'module' | 'lecture'
  /** Visible label, already localized. */
  label(): string
  /** Whether the action applies to this target at all. */
  appliesTo(target: LibraryTarget): boolean
  /** Drawn as the page's primary button when true (the first applicable one wins). */
  primary?(target: LibraryTarget): boolean
  /** Do it. */
  run(target: LibraryTarget): void | Promise<void>
}

/** Opens a workspace file somewhere the student can read it. */
export type LibraryOpener = (absolutePath: string) => void

/** The engine calls the library makes; the transcriber-engine Remote satisfies it. */
export interface LibraryEngine {
  listModules(this: void, signal: AbortSignal): Promise<RemoteResult<{
    readonly workspace: string
    readonly modules: readonly {
      readonly module: string
      readonly display_name: string
      readonly notebooks: readonly string[]
      readonly root: string
    }[]
  }>>
  listLibrary?(this: void, request: TranscriberLibraryRequest, signal: AbortSignal): Promise<RemoteResult<TranscriberLibraryListing>>
  listLectures(this: void, request: { readonly module: string; readonly refresh?: boolean }, signal: AbortSignal): Promise<RemoteResult<{
    readonly lectures: readonly EngineLectureEntry[]
    readonly materials: readonly LibraryMaterial[]
    readonly warning?: string
    readonly remote_as_of?: string | null | undefined
    readonly questions?: 'indexed' | 'missing' | 'needs-conversion'
  }>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The study library: route, workspace contents, actions and openers. */
    library: LibraryService
  }
}

/** A read's answer with its failure reduced to what the page says. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sortActions(actions: Iterable<LibraryAction>): LibraryAction[] {
  return [...actions].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
}

/** Owns the library's state and its registries. */
export class LibraryService extends Service {
  /** Route and workspace contents. */
  readonly state: SnapshotStore<LibraryState>
  /** Registered actions, in order. */
  readonly actions: SnapshotStore<readonly LibraryAction[]>
  /** The calls that let the student edit lectures and files; absent keeps the library read-only. */
  readonly editing: SnapshotStore<LectureEditing | undefined> = createSnapshotStore<LectureEditing | undefined>(undefined)
  /** Choosing the library folder and adding modules; absent on an older Host. */
  readonly setup: SnapshotStore<LibrarySetup | undefined> = createSnapshotStore<LibrarySetup | undefined>(undefined)
  private readonly actionById = new Map<string, LibraryAction>()
  private opener: LibraryOpener | undefined
  private readonly inflight = new Map<string, AbortController>()
  private readonly lifetime = new AbortController()
  private readonly notebookChanged = new Set<string>()
  private readonly moduleRevisions = new Map<string, number>()

  /**
   * @param ctx - client root context.
   * @param engine - the transcriber engine's listing calls.
   */
  constructor(ctx: Context, private readonly engine: LibraryEngine) {
    super(ctx, 'library')
    const cached = readLibraryCache()
    this.state = createSnapshotStore<LibraryState>({
      route: { kind: 'home' },
      modules: { status: 'loading' },
      contents: {},
      ...cached,
    })
    this.actions = createSnapshotStore<readonly LibraryAction[]>([])
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const controller of this.inflight.values()) controller.abort()
    }, 'ui-library: in-flight reads')
  }

  /**
   * Go somewhere in the library. Opening a module or lecture reads its
   * lectures if they have not been read yet.
   * @param route - destination.
   */
  navigate(route: LibraryRoute): void {
    this.state.set({ ...this.state.getSnapshot(), route })
    if (route.kind !== 'home' && this.state.getSnapshot().contents[route.module] === undefined) {
      void this.loadModule(route.module)
    }
  }

  /** Re-read the library with fresh notebook inventories. */
  async refresh(): Promise<void> {
    const loaded = Object.keys(this.state.getSnapshot().contents)
    await this.loadModules('refresh')
    if (this.engine.listLibrary === undefined) {
      await Promise.all(loaded.map(async (module) => { await this.loadModule(module, true) }))
    }
  }

  /**
   * Read the workspace's modules.
   * @param remote - cached notebook presence at startup, fresh presence on student refresh.
   * @returns once the answer is in the store.
   */
  async loadModules(remote: 'cached' | 'refresh' = 'cached'): Promise<void> {
    const previous = this.state.getSnapshot().modules
    this.patch({
      modules: previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' },
    })
    const listLibrary = this.engine.listLibrary
    if (listLibrary !== undefined) {
      await this.loadLibrary(remote, listLibrary)
      return
    }
    const result = await this.guard('modules', signal => this.engine.listModules(signal))
    if (result === undefined) return
    if (!result.ok) {
      this.patch({ modules: { status: 'failed', message: result.message } })
      return
    }
    const modules = result.value.modules.map(module => ({
      id: module.module,
      displayName: module.display_name,
      notebooks: module.notebooks,
      root: module.root,
    }))
    const contents = result.value.workspace === this.state.getSnapshot().workspace ? this.state.getSnapshot().contents : {}
    this.patch({ workspace: result.value.workspace, modules: { status: 'ready', value: modules, refreshing: false }, contents })
    writeLibraryCache(this.state.getSnapshot())
  }

  /**
   * Read one module's lectures and materials.
   * @param module - module id.
   * @param refresh - force a fresh notebook inventory after a notebook write.
   * @returns once the answer is in the store.
   */
  async loadModule(module: string, refresh = false): Promise<void> {
    if (this.engine.listLibrary !== undefined && this.inflight.has('modules')
      && this.state.getSnapshot().contents[module] === undefined) return
    this.moduleRevisions.set(module, (this.moduleRevisions.get(module) ?? 0) + 1)
    const previous = this.state.getSnapshot().contents[module]
    this.patchContents(module, previous?.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' })
    const refreshNotebook = refresh || this.notebookChanged.has(module)
    this.notebookChanged.delete(module)
    const result = await this.guard(`module:${module}`, signal => this.engine.listLectures({ module, ...refreshNotebook ? { refresh: true } : {} }, signal))
    if (result === undefined) return
    if (!result.ok) {
      this.patchContents(module, { status: 'failed', message: result.message })
      return
    }
    const contents: ModuleContents = {
      lectures: result.value.lectures.map(lectureFromEngine),
      materials: result.value.materials,
      ...result.value.warning === undefined ? {} : { warning: result.value.warning },
      ...result.value.remote_as_of === undefined ? {} : { remoteAsOf: result.value.remote_as_of },
      ...previous?.status === 'ready' && previous.value.questionIndex !== undefined ? { questionIndex: previous.value.questionIndex } : {},
    }
    this.patchContents(module, { status: 'ready', value: contents, refreshing: false })
    writeLibraryCache(this.state.getSnapshot())
  }

  /**
   * Mark a notebook write so the next module read bypasses the remote cache.
   * @param module - changed notebook's module.
   */
  invalidateNotebook(module: string): void {
    this.notebookChanged.add(module)
  }

  /**
   * Publish an exam index built by the engine without rereading other modules.
   * @param module - indexed module.
   */
  questionIndexBuilt(module: string): void {
    const contents = this.state.getSnapshot().contents[module]
    if (contents?.status !== 'ready') return
    this.patchContents(module, { ...contents, value: { ...contents.value,
      questionIndex: { state: 'built', files: contents.value.questionIndex?.files ?? 0 } } })
    writeLibraryCache(this.state.getSnapshot())
  }

  private async loadLibrary(remote: 'cached' | 'refresh', list: NonNullable<LibraryEngine['listLibrary']>): Promise<void> {
    const revisions = new Map(this.moduleRevisions)
    const snapshot = this.state.getSnapshot()
    for (const [module, contents] of Object.entries(snapshot.contents)) {
      if (contents.status === 'ready') this.patchContents(module, { ...contents, refreshing: true })
    }
    const result = await this.guard('modules', signal => list({ remote }, signal))
    if (result === undefined) return
    if (!result.ok) {
      this.patch({ modules: { status: 'failed', message: result.message } })
      return
    }
    const current = this.state.getSnapshot()
    const contents: Record<string, Loadable<ModuleContents>> = {}
    for (const module of result.value.modules) {
      // A module read started after this library read owns the newer module contents.
      const newer = current.workspace === result.value.workspace && this.moduleRevisions.get(module.module) !== revisions.get(module.module)
        ? current.contents[module.module] : undefined
      contents[module.module] = newer ?? ('error' in module
        ? { status: 'failed', message: module.error }
        : { status: 'ready', refreshing: false, value: {
          lectures: module.lectures.map(lectureFromEngine), materials: module.materials,
          questionIndex: { state: module.exam_index, files: module.question_files },
          ...module.warning === undefined ? {} : { warning: module.warning },
          ...module.remote_as_of === undefined ? {} : { remoteAsOf: module.remote_as_of },
        } })
    }
    const modules = result.value.modules.map(module => ({ id: module.module, displayName: module.display_name,
      notebooks: module.notebooks, root: module.root }))
    this.patch({ workspace: result.value.workspace, modules: { status: 'ready', value: modules, refreshing: false }, contents })
    writeLibraryCache(this.state.getSnapshot())
  }

  /**
   * Install the library setup calls.
   * @param setup - the engine calls.
   * @returns a disposer that removes them again.
   */
  provideSetup(setup: LibrarySetup): () => void {
    this.setup.set(setup)
    return () => { if (this.setup.getSnapshot() === setup) this.setup.set(undefined) }
  }

  /**
   * Let the student edit lectures and files through these calls.
   * @param editing - the engine calls.
   * @returns disposer that removes exactly this provider.
   */
  provideEditing(editing: LectureEditing): () => void {
    this.editing.set(editing)
    return () => { if (this.editing.getSnapshot() === editing) this.editing.set(undefined) }
  }

  /**
   * Add a page action, replacing any action with the same id.
   * @param action - the action.
   * @returns disposer that removes exactly this registration.
   */
  registerAction(action: LibraryAction): () => void {
    this.actionById.set(action.id, action)
    this.actions.set(sortActions(this.actionById.values()))
    return () => {
      if (this.actionById.get(action.id) !== action) return
      this.actionById.delete(action.id)
      this.actions.set(sortActions(this.actionById.values()))
    }
  }

  /**
   * Set where files open. The last registration wins, and disposing it
   * restores nothing: a panel that goes away takes opening with it.
   * @param opener - opens an absolute workspace path.
   * @returns disposer.
   */
  registerOpener(opener: LibraryOpener): () => void {
    this.opener = opener
    return () => {
      if (this.opener === opener) this.opener = undefined
    }
  }

  /** Whether any panel can open files. */
  get canOpen(): boolean {
    return this.opener !== undefined
  }

  /**
   * Open a workspace file.
   * @param absolutePath - the file.
   */
  open(absolutePath: string): void {
    this.opener?.(absolutePath)
  }

  /**
   * The module and lecture the route points at, when both are loaded.
   * @returns the current target, or undefined on the home page or while loading.
   */
  currentTarget(): LibraryTarget | undefined {
    const { route, modules, contents } = this.state.getSnapshot()
    if (route.kind === 'home' || modules.status !== 'ready') return undefined
    const module = modules.value.find(item => item.id === route.module)
    if (module === undefined) return undefined
    if (route.kind === 'module') return { module }
    const moduleContents = contents[route.module]
    if (moduleContents?.status !== 'ready') return { module }
    const lecture = moduleContents.value.lectures.find(item => item.title === route.lecture)
    return lecture === undefined ? { module } : { module, lecture }
  }

  private patch(partial: Partial<LibraryState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...partial })
  }

  private patchContents(module: string, value: Loadable<ModuleContents>): void {
    const snapshot = this.state.getSnapshot()
    this.state.set({ ...snapshot, contents: { ...snapshot.contents, [module]: value } })
  }

  /**
   * Run one read, cancelling an earlier read of the same thing. A superseded
   * or disposed read resolves to undefined so its answer is never stored.
   */
  private async guard<T>(
    key: string,
    read: (signal: AbortSignal) => Promise<RemoteResult<T>>,
  ): Promise<Outcome<T> | undefined> {
    this.inflight.get(key)?.abort()
    const controller = new AbortController()
    this.inflight.set(key, controller)
    try {
      const result = await read(AbortSignal.any([controller.signal, this.lifetime.signal]))
      if (controller.signal.aborted || this.lifetime.signal.aborted) return undefined
      return result.ok ? result : { ok: false, message: result.error.message }
    } catch (error: unknown) {
      // The Remote face folds carrier failures into its error branch; what
      // still rejects is an assembly fault, which the page reports the same way.
      if (controller.signal.aborted || this.lifetime.signal.aborted) return undefined
      return { ok: false, message: messageOf(error) }
    } finally {
      if (this.inflight.get(key) === controller) this.inflight.delete(key)
    }
  }
}
