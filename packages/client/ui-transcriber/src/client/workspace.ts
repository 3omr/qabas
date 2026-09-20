/**
 * Reading the transcriber's workspace layout through the Remote file service.
 *
 * The layout is a convention, not configuration: `modules/` under the
 * workspace root, one folder per module carrying `module.json`, and inside it
 * `Lecture/` for the recordings and `Transcripts/` for what the pipeline
 * produced. The engine resolves the same three names, so nothing here is a
 * setting a user could change out from under the panel.
 *
 * Everything is read, nothing is written: the panel draws what is on disk and
 * the chat's tools are what change it.
 */
import type { ClientRemote, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RECORDING_EXTENSIONS, extensionOf, lecturesOf, type LectureUnit } from './lectures.ts'
import { createReadLatestRun, type TranscriberRun } from './runs.ts'

/** The workspace folder holding one folder per module. */
const MODULES_DIR = 'modules'

/** The file that makes a folder a module rather than a stray directory. */
const MODULE_CONFIG = 'module.json'

/** The module subfolder holding recordings, read recursively. */
const LECTURE_DIR = 'Lecture'

/** The module subfolder holding finished transcripts and their index. */
const TRANSCRIPTS_DIR = 'Transcripts'

/**
 * How deep under `Lecture/` the panel will walk.
 *
 * The engine globs the whole subtree; a sidebar that redraws on every change
 * wants a listing that cannot become unbounded, and a recording nested deeper
 * than this is not a layout anyone has.
 */
const MAX_LECTURE_DEPTH = 4

/** One module as the panel draws it. */
export interface ModuleView {
  /** Folder name under `modules/`, and the id every tool takes. */
  readonly id: string
  /** The module's own name from `module.json`, falling back to its folder name. */
  readonly displayName: string
  /** The module's lectures, transcribed and pending alike, in listing order. */
  readonly lectures: readonly LectureUnit[]
  /** The newest run attempt, when the module has a run cache. */
  readonly run?: TranscriberRun
}

/** The slice of the Client Remote this panel calls. */
export type TranscriberRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read'>
}

/** Read the workspace's modules for one session. */
export type ReadModules = (sessionId: SessionId, signal: AbortSignal) => Promise<RemoteResult<ModuleView[]>>

/** A listing failure that only means the folder is not there. */
function isMissing(failure: RemoteFailure): boolean {
  return failure.code === 'workspace-file/not-found' || failure.code === 'workspace-file/not-directory'
}

/**
 * Bind the workspace read to one Remote face.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the read the panel's face performs.
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
    const result = await files.list(sessionId, path, signal)
    if (result.ok) return { ok: true, value: [...result.value.entries] }
    // A workspace with no modules folder yet, or a module with no Lecture
    // folder, is the normal first screen of setup rather than a failure.
    return isMissing(result.error) ? { ok: true, value: [] } : result
  }

  /** Every recording under one module's `Lecture/`, depth-first and depth-capped. */
  const recordingsOf = async (
    sessionId: SessionId,
    lectureRoot: string,
    signal: AbortSignal,
  ): Promise<RemoteResult<{ name: string; path: string }[]>> => {
    const found: { name: string; path: string }[] = []
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
      // A module.json the panel cannot parse is the engine's problem to report,
      // with a message the panel could not improve on. The folder name is a
      // true answer to "what is this module called" in the meantime.
      return id
    }
  }

  return async (sessionId, signal) => {
    const root = await listOrEmpty(sessionId, MODULES_DIR, signal)
    if (!root.ok) return root
    const modules: ModuleView[] = []
    for (const entry of root.value) {
      if (entry.type !== 'directory' || entry.name.startsWith('.')) continue
      const moduleRoot = `${MODULES_DIR}/${entry.name}`
      const inside = await listOrEmpty(sessionId, moduleRoot, signal)
      if (!inside.ok) return inside
      // A folder with no module.json is not a module. The engine skips it for
      // the same reason: reading it as one fails the whole run.
      if (!inside.value.some(child => child.name === MODULE_CONFIG && child.type === 'file')) continue

      const recordings = await recordingsOf(sessionId, `${moduleRoot}/${LECTURE_DIR}`, signal)
      if (!recordings.ok) return recordings
      const transcripts = await listOrEmpty(sessionId, `${moduleRoot}/${TRANSCRIPTS_DIR}`, signal)
      if (!transcripts.ok) return transcripts
      const run = await readLatestRun(sessionId, entry.name, signal)
      if (!run.ok) return run

      const view = {
        id: entry.name,
        displayName: await displayNameOf(sessionId, entry.name, signal),
        lectures: lecturesOf(
          recordings.value,
          transcripts.value.filter(child => child.type === 'file').map(child => child.name),
        ),
        ...(run.value === undefined ? {} : { run: run.value }),
      } satisfies ModuleView
      modules.push(view)
    }
    return { ok: true, value: modules }
  }
}
