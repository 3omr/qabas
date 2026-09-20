/** Live observations used by the blank-session transcription guide. */

import type {
  ClientRemote, RemoteFailure, RemoteResult, TranscriberDoctorReport,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createReadModules, type ModuleView, type TranscriberRemote,
} from '@deepseek-ai/dsh-client-transcriber-workspace'

/** One observed first-run fact. Unknown is never treated as complete. */
export type FirstRunObservation = 'complete' | 'incomplete' | 'unknown'

/** The ordered facts the guide presents. */
export type FirstRunStepId =
  | 'workspace' | 'provider' | 'readiness' | 'notebook'
  | 'module' | 'files' | 'sync' | 'transcript'

/** The live observations needed to choose the next guide step. */
export type FirstRunStepState = Record<FirstRunStepId, FirstRunObservation>

/** Data projected from the workspace and engine for one current Session. */
export interface FirstRunSnapshot {
  readonly loading: boolean
  readonly provider: FirstRunObservation
  readonly readiness: FirstRunObservation
  readonly notebook: FirstRunObservation
  readonly modules: FirstRunObservation
  readonly files: FirstRunObservation
  readonly sync: FirstRunObservation
  readonly transcript: FirstRunObservation
  readonly moduleId?: string
  readonly moduleName?: string
  readonly lectureTitle?: string
}

/** Private state source used by the hero occupant. */
export interface FirstRunSource {
  readonly store: SnapshotStore<FirstRunSnapshot>
  refresh(): void
  dispose(): void
}

/** Initial state before the Host answers any observation. */
export const EMPTY_FIRST_RUN_SNAPSHOT: FirstRunSnapshot = {
  loading: false,
  provider: 'unknown',
  readiness: 'unknown',
  notebook: 'unknown',
  modules: 'unknown',
  files: 'unknown',
  sync: 'unknown',
  transcript: 'unknown',
}

const FIRST_RUN_STEP_IDS: readonly FirstRunStepId[] = [
  'workspace', 'provider', 'readiness', 'notebook', 'module', 'files', 'sync', 'transcript',
]

/** Choose the first step that is not proven complete. */
export function firstIncompleteStep(state: FirstRunStepState): FirstRunStepId | undefined {
  return FIRST_RUN_STEP_IDS.find(step => state[step] !== 'complete')
}

/** Derive the workspace step from the Session list's current directory fact. */
export function workspaceObservation(
  sessionId: SessionId | undefined,
  cwd: string | undefined,
): FirstRunObservation {
  if (sessionId === undefined) return 'incomplete'
  if (cwd === undefined) return 'unknown'
  return cwd.trim() === '' ? 'incomplete' : 'complete'
}

/** Combine the workspace fact with the observer's independent facts. */
export function firstRunStepState(
  snapshot: FirstRunSnapshot,
  workspace: FirstRunObservation,
): FirstRunStepState {
  return {
    workspace,
    provider: snapshot.provider,
    readiness: snapshot.readiness,
    notebook: snapshot.notebook,
    module: snapshot.modules,
    files: snapshot.files,
    sync: snapshot.sync,
    transcript: snapshot.transcript,
  }
}

/** Parse the source-sync record written by the transcription skill. */
export function syncObservationFromState(
  response: RemoteResult<{ readonly text: string }> | undefined,
): FirstRunObservation {
  if (response === undefined) return 'unknown'
  if (!response.ok) return missingWorkspaceFile(response.error) ? 'incomplete' : 'unknown'
  try {
    const parsed = JSON.parse(response.value.text) as { status?: unknown }
    return parsed.status === 'completed' ? 'complete' : 'incomplete'
  } catch {
    return 'unknown'
  }
}

function missingWorkspaceFile(failure: RemoteFailure): boolean {
  return failure.code === 'workspace-file/not-found' || failure.code === 'workspace-file/not-directory'
}

function providerObservation(response: RemoteResult<readonly { id: string }[]>): FirstRunObservation {
  if (!response.ok) return 'unknown'
  return response.value.length > 0 ? 'complete' : 'incomplete'
}

function doctorObservations(report: TranscriberDoctorReport): Pick<FirstRunSnapshot, 'readiness' | 'notebook'> {
  const notebook = report.dependencies.find(dependency => dependency.name === 'nlm')
  const engineDependencies = report.dependencies.filter(dependency => dependency.name !== 'nlm' && dependency.required)
  let readiness: FirstRunObservation
  if (!report.live) readiness = 'unknown'
  else if (!report.python.supported) readiness = 'incomplete'
  else if (engineDependencies.some(dependency => !dependency.resolved || dependency.probe?.passed === false)) {
    readiness = 'incomplete'
  }
  else if (engineDependencies.some(dependency => dependency.probe?.passed !== true)) readiness = 'unknown'
  else readiness = 'complete'
  return {
    readiness,
    notebook: notebook === undefined || !notebook.resolved
      ? 'incomplete'
      : notebook.probe?.passed === true
        ? 'complete'
        : notebook.probe?.passed === false ? 'incomplete' : 'unknown',
  }
}

async function readDoctor(
  engine: ClientRemote['transcriberEngine'] | undefined,
  signal: AbortSignal,
): Promise<Pick<FirstRunSnapshot, 'readiness' | 'notebook'>> {
  if (engine === undefined) return { readiness: 'unknown', notebook: 'unknown' }
  try {
    const response = await engine.doctor({ live: true }, signal)
    return response.ok ? doctorObservations(response.value) : { readiness: 'unknown', notebook: 'unknown' }
  } catch {
    return { readiness: 'unknown', notebook: 'unknown' }
  }
}

async function readWorkspace(
  readModules: ReturnType<typeof createReadModules>,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<RemoteResult<ModuleView[]>> {
  try {
    return await readModules(sessionId, signal, { includeNotebook: false })
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'gateway/internal',
        message: error instanceof Error ? error.message : String(error),
      } as RemoteFailure,
    }
  }
}

function moduleFacts(modules: readonly ModuleView[]): Pick<FirstRunSnapshot, 'files' | 'transcript' | 'moduleId' | 'moduleName' | 'lectureTitle'> {
  const lecture = modules
    .flatMap(module => module.lectures.map(lecture => ({ module, lecture })))
    .find(entry => !entry.lecture.transcribed && entry.lecture.sources.length > 0)
  const firstModule = modules[0]
  return {
    files: modules.some(module => module.lectures.some(lecture => lecture.sources.length > 0))
      ? 'complete' : 'incomplete',
    transcript: modules.some(module => module.lectures.some(lecture => lecture.transcribed))
      ? 'complete' : 'incomplete',
    ...(firstModule === undefined ? {} : { moduleId: firstModule.id, moduleName: firstModule.displayName }),
    ...(lecture === undefined ? {} : { lectureTitle: lecture.lecture.title }),
  }
}

async function readSync(
  remote: Pick<ClientRemote, 'workspaceFiles'>,
  sessionId: SessionId,
  modules: readonly ModuleView[],
  signal: AbortSignal,
): Promise<FirstRunObservation> {
  if (modules.length === 0) return 'incomplete'
  const observations = await Promise.all(modules.map(async (module) => {
    try {
      const response = await remote.workspaceFiles.read(
        sessionId,
        `modules/${module.id}/.transcriber-cache/source-sync/state.json`,
        {},
        signal,
      )
      return syncObservationFromState(response)
    } catch {
      return 'unknown' as const
    }
  }))
  if (observations.some(observation => observation === 'unknown')) return 'unknown'
  return observations.every(observation => observation === 'complete') ? 'complete' : 'incomplete'
}

function applySnapshot(
  store: SnapshotStore<FirstRunSnapshot>,
  provider: FirstRunObservation,
  workspace: RemoteResult<ModuleView[]>,
  doctor: Pick<FirstRunSnapshot, 'readiness' | 'notebook'>,
  sync: FirstRunObservation,
): void {
  if (!workspace.ok) {
    store.set({ ...EMPTY_FIRST_RUN_SNAPSHOT, loading: false, provider, ...doctor })
    return
  }
  const modules = workspace.value
  store.set({
    ...EMPTY_FIRST_RUN_SNAPSHOT,
    loading: false,
    provider,
    ...doctor,
    modules: modules.length > 0 ? 'complete' : 'incomplete',
    sync,
    ...moduleFacts(modules),
  })
}

/** Create the observer for one optional-Session hero binding. */
export function createFirstRunSource(
  remote: Pick<ClientRemote, 'llm' | 'workspaceFiles'> & Partial<Pick<ClientRemote, 'transcriberEngine'>>,
  sessionId: SessionId | undefined,
): FirstRunSource {
  const store = createSnapshotStore<FirstRunSnapshot>(EMPTY_FIRST_RUN_SNAPSHOT)
  if (sessionId === undefined) return { store, refresh: () => {}, dispose: () => {} }

  const readModules = createReadModules({
    workspaceFiles: remote.workspaceFiles,
    ...remote.transcriberEngine === undefined ? {} : { transcriberEngine: remote.transcriberEngine },
  } satisfies TranscriberRemote)
  let generation = 0
  let activeRequest: AbortController | undefined

  const refresh = (): void => {
    activeRequest?.abort()
    const controller = new AbortController()
    activeRequest = controller
    const current = ++generation
    store.set({ ...store.getSnapshot(), loading: true })
    void (async () => {
      let provider: FirstRunObservation
      try {
        provider = providerObservation(await remote.llm.listProviders())
      } catch {
        provider = 'unknown'
      }
      const workspace = await readWorkspace(readModules, sessionId, controller.signal)
      const doctor = await readDoctor(remote.transcriberEngine, controller.signal)
      const sync = workspace.ok
        ? await readSync(remote, sessionId, workspace.value, controller.signal)
        : 'unknown' as const
      if (controller.signal.aborted || current !== generation) return
      applySnapshot(store, provider, workspace, doctor, sync)
    })()
  }

  return {
    store,
    refresh,
    dispose: () => {
      activeRequest?.abort()
      generation += 1
    },
  }
}
