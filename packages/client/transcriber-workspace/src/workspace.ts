/**
 * Read the transcriber's disk workspace first, then merge the engine's slower
 * NotebookLM inventory for browser consumers.
 *
 * The disk read stays on the workspace-files Remote because a Sidebar redraw
 * cannot start a subprocess. The engine listing is an additional operation,
 * started only for an initial read or an explicit refresh; run-progress polling
 * asks for the disk half only.
 */
import type {
  ClientRemote, RemoteFailure, RemoteResult, TranscriberLectureEntry,
  TranscriberLectureListing,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  RECORDING_EXTENSIONS, extensionOf, lecturesOf, type LectureUnit, type RecordingFile,
} from './lectures.ts'
import { createReadLatestRun, type TranscriberRun } from './runs.ts'

/** The workspace folder holding one folder per module. */
const MODULES_DIR = 'modules'

/** The file that makes a folder a module rather than a stray directory. */
const MODULE_CONFIG = 'module.json'

/** The module subfolder holding recordings, read recursively. */
const LECTURE_DIR = 'Lecture'

/** The module subfolder holding finished transcripts and their index. */
const TRANSCRIPTS_DIR = 'Transcripts'

/** The module subfolder holding question papers and the generated index. */
const QUESTIONS_DIR = 'Questions'

/** The generated question index whose presence makes preparation unnecessary. */
const QUESTION_FILE = 'exam-index.json'

/** How deep under `Lecture/` the panel will walk. */
const MAX_LECTURE_DEPTH = 4

/** State of the additional NotebookLM listing for one module. */
export type NotebookStatus = 'pending' | 'ready' | 'failed' | 'unavailable'

/** One module as the panel and composer draw it. */
export interface ModuleView {
  /** Folder name under `modules/`, and the id every tool takes. */
  readonly id: string
  /** The module's own name from `module.json`, falling back to its folder name. */
  readonly displayName: string
  /** The module's lectures, transcribed and pending alike, in listing order. */
  readonly lectures: readonly LectureUnit[]
  /** The newest run attempt, when the module has a run cache. */
  readonly run?: TranscriberRun
  /** Whether the separate NotebookLM listing has answered for this module. */
  readonly notebookStatus: NotebookStatus
  /** Plain engine or transport message when the remote listing is unavailable. */
  readonly notebookWarning?: string
  /** Whether `Questions/exam-index.json` is already present on disk. */
  readonly questionFileExists: boolean
}

/** The slice of the Client Remote this reader calls. */
export type TranscriberRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read'>
  readonly transcriberEngine?: {
    readonly listLectures: ClientRemote['transcriberEngine']['listLectures']
  }
}

/** Optional phases for one workspace read. */
export interface ReadModulesOptions {
  /** Skip the NotebookLM subprocess; used by the existing run-progress tick. */
  readonly includeNotebook?: boolean
  /** The last complete view, used to retain NotebookLM rows during disk refreshes. */
  readonly previous?: readonly ModuleView[]
  /** Called after the disk half is ready and again after a NotebookLM merge. */
  readonly onDisk?: (modules: readonly ModuleView[]) => void
}

/** Read the workspace's modules for one session. */
export type ReadModules = (
  sessionId: SessionId,
  signal: AbortSignal,
  options?: ReadModulesOptions,
) => Promise<RemoteResult<ModuleView[]>>

/** A recording listing with no browser-only status fields yet. */
interface DiskModuleView extends Omit<ModuleView, 'notebookStatus' | 'notebookWarning'> {
  readonly notebookStatus: 'pending'
}

/** A listing failure that only means the folder is not there. */
function isMissing(failure: RemoteFailure): boolean {
  return failure.code === 'workspace-file/not-found' || failure.code === 'workspace-file/not-directory'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function lectureKey(title: string): string {
  return title.trim().toLocaleLowerCase()
}

function localLectureFor(
  lectures: readonly LectureUnit[],
  remote: TranscriberLectureEntry,
): LectureUnit | undefined {
  return lectures.find(lecture => lectureKey(lecture.title) === lectureKey(remote.title))
}

function lectureFromRemote(remote: TranscriberLectureEntry): LectureUnit {
  return {
    title: remote.title,
    sources: [],
    transcribed: remote.transcribed,
    inNotebookOnly: remote.in_notebook_only,
  }
}

/**
 * Merge one engine answer over the disk lecture list without duplicating rows.
 * @param local - lecture rows classified from workspace files.
 * @param remote - lecture rows returned by the engine.
 * @returns merged lecture rows with local sources preserved.
 */
export function mergeNotebookLectures(
  local: readonly LectureUnit[],
  remote: readonly TranscriberLectureEntry[],
): LectureUnit[] {
  const claimed = new Set<string>()
  const merged: LectureUnit[] = []
  for (const remoteLecture of remote) {
    const localLecture = localLectureFor(local, remoteLecture)
    if (localLecture === undefined) {
      merged.push(lectureFromRemote(remoteLecture))
      continue
    }
    claimed.add(lectureKey(localLecture.title))
    merged.push({
      ...localLecture,
      transcribed: remoteLecture.transcribed,
      inNotebookOnly: localLecture.sources.length === 0 && remoteLecture.in_notebook_only,
    })
  }
  for (const localLecture of local) {
    if (!claimed.has(lectureKey(localLecture.title))) merged.push(localLecture)
  }
  return merged
}

function retainNotebookRows(
  disk: DiskModuleView,
  previous: ModuleView | undefined,
): ModuleView {
  if (previous === undefined) return disk
  const remoteOnly = previous.lectures.filter(lecture => lecture.inNotebookOnly)
  const localTitles = new Set(disk.lectures.map(lecture => lectureKey(lecture.title)))
  const lectures = [
    ...disk.lectures.map((lecture) => {
      const old = previous.lectures.find(candidate => lectureKey(candidate.title) === lectureKey(lecture.title))
      return old?.inNotebookOnly && lecture.sources.length === 0
        ? { ...lecture, inNotebookOnly: true }
        : lecture
    }),
    ...remoteOnly.filter(lecture => !localTitles.has(lectureKey(lecture.title))),
  ]
  return {
    ...disk,
    lectures,
    notebookStatus: previous.notebookStatus,
    ...previous.notebookWarning === undefined ? {} : { notebookWarning: previous.notebookWarning },
  }
}

function mergeNotebookAnswer(disk: DiskModuleView, listing: TranscriberLectureListing): ModuleView {
  const failed = listing.warning !== undefined
  return {
    ...disk,
    lectures: mergeNotebookLectures(disk.lectures, listing.lectures),
    notebookStatus: failed ? 'failed' : 'ready',
    ...failed ? { notebookWarning: listing.warning } : {},
  }
}

/**
 * Bind the workspace read to one Remote face.
 * @param remote - the Client Remote faces carrying workspace files and the engine.
 * @returns the session-scoped workspace reader.
 */
export function createReadModules(remote: TranscriberRemote): ReadModules {
  const files = remote.workspaceFiles
  const readLatestRun = createReadLatestRun(remote)

  /** One directory's entries, with a folder that is simply absent read as empty. */
  const listOrEmpty = async (
    sessionId: SessionId,
    path: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ name: string; type: string }[]>> => {
    const listing = await files.list(sessionId, path, signal)
    if (listing.ok) return { ok: true, value: [...listing.value.entries] }
    return isMissing(listing.error) ? { ok: true, value: [] } : listing
  }

  /** Every recording under one module's `Lecture/`, depth-first and depth-capped. */
  const recordingsOf = async (
    sessionId: SessionId,
    lectureRoot: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<RecordingFile[]>> => {
    const found: RecordingFile[] = []
    const walk = async (path: string, depth: number): Promise<RemoteFailure | undefined> => {
      const listing = await listOrEmpty(sessionId, path, signal)
      if (!listing.ok) return listing.error
      for (const entry of [...listing.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const child = `${path}/${entry.name}`
        if (entry.type === 'directory') {
          if (depth >= MAX_LECTURE_DEPTH) continue
          const failure = await walk(child, depth + 1)
          if (failure !== undefined) return failure
        } else if (RECORDING_EXTENSIONS.has(extensionOf(entry.name))) {
          found.push({ name: entry.name, path: child })
        }
      }
      return undefined
    }
    const failure = await walk(lectureRoot, 1)
    return failure === undefined ? { ok: true, value: found } : { ok: false, error: failure }
  }

  /** The module's own name, or its folder name when `module.json` cannot be read. */
  const displayNameOf = async (sessionId: SessionId, id: string, signal: AbortSignal): Promise<string> => {
    const result = await files.read(sessionId, `${MODULES_DIR}/${id}/${MODULE_CONFIG}`, {}, signal)
    if (!result.ok) return id
    try {
      const name = (JSON.parse(result.value.text) as { display_name?: unknown }).display_name
      return typeof name === 'string' && name.trim().length > 0 ? name.trim() : id
    } catch {
      return id
    }
  }

  const readDisk = async (
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<RemoteResult<DiskModuleView[]>> => {
    const root = await listOrEmpty(sessionId, MODULES_DIR, signal)
    if (!root.ok) return root
    const modules: DiskModuleView[] = []
    for (const entry of root.value) {
      if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
      const moduleRoot = `${MODULES_DIR}/${entry.name}`
      const inside = await listOrEmpty(sessionId, moduleRoot, signal)
      if (!inside.ok) return inside
      if (!inside.value.some(child => child.name === MODULE_CONFIG && child.type === 'file')) continue

      const recordings = await recordingsOf(sessionId, `${moduleRoot}/${LECTURE_DIR}`, signal)
      if (!recordings.ok) return recordings
      const transcripts = await listOrEmpty(sessionId, `${moduleRoot}/${TRANSCRIPTS_DIR}`, signal)
      if (!transcripts.ok) return transcripts
      const questions = await listOrEmpty(sessionId, `${moduleRoot}/${QUESTIONS_DIR}`, signal)
      if (!questions.ok) return questions
      const run = await readLatestRun(sessionId, entry.name, signal)
      if (!run.ok) return run

      modules.push({
        id: entry.name,
        displayName: await displayNameOf(sessionId, entry.name, signal),
        lectures: lecturesOf(
          recordings.value,
          transcripts.value.filter(child => child.type === 'file').map(child => child.name),
        ),
        ...(run.value === undefined ? {} : { run: run.value }),
        notebookStatus: 'pending',
        questionFileExists: questions.value.some(
          child => child.type === 'file' && child.name === QUESTION_FILE,
        ),
      })
    }
    return { ok: true, value: modules }
  }

  return async (sessionId, signal, options = {}) => {
    const disk = await readDisk(sessionId, signal)
    if (!disk.ok) return disk
    if (options.includeNotebook === false) {
      const previous = options.previous ?? []
      const retained = disk.value.map(module => retainNotebookRows(
        module,
        previous.find(candidate => candidate.id === module.id),
      ))
      options.onDisk?.(retained)
      return { ok: true as const, value: retained }
    }

    options.onDisk?.(disk.value)
    const engine = remote.transcriberEngine
    if (engine === undefined) {
      return {
        ok: true as const,
        value: disk.value.map(module => ({ ...module, notebookStatus: 'unavailable' as const })),
      }
    }

    const modules = await Promise.all(disk.value.map(async (module) => {
      try {
        const listing = await engine.listLectures({ module: module.id }, signal)
        return listing.ok
          ? mergeNotebookAnswer(module, listing.value)
          : {
            ...module,
            notebookStatus: 'failed' as const,
            notebookWarning: listing.error.message,
          }
      } catch (error: unknown) {
        return {
          ...module,
          notebookStatus: 'failed' as const,
          notebookWarning: messageOf(error),
        }
      }
    }))
    const final = { ok: true as const, value: modules }
    options.onDisk?.(final.value)
    return final
  }
}
