/**
 * Read and fold the transcriber engine's append-only run events for browser consumers.
 *
 * The engine writes one run directory per attempt. A resumed attempt appends a
 * new `init`, so the last valid `init` is the fold's starting point. The file
 * can also be read while its last JSON line is being written; an incomplete
 * final line is ignored and the preceding events remain useful.
 */
import type { ClientRemote, RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const RUNS_DIR = '.transcriber-cache/runs'
const EVENTS_FILE = 'events.ndjson'
const COMPLETE_PHASE_STATES = new Set<RunPhaseState>(['validated', 'repaired', 'reused'])
const EMITTED_PHASE_STATES = new Set<Exclude<RunPhaseState, 'pending'>>([
  'running', 'validated', 'failed', 'repaired', 'reused',
])

/** The checkpoint states emitted by the engine, plus the derived initial state. */
export type RunPhaseState = 'pending' | 'running' | 'validated' | 'failed' | 'repaired' | 'reused'

/** The overall state the panel can show for a run. */
export type TranscriberRunStatus = 'running' | 'success' | 'failed'

/** One phase in the order declared by the run's latest `init` event. */
export interface TranscriberRunPhase {
  /** Engine phase id. */
  readonly name: string
  /** Label supplied by the engine for this phase. */
  readonly label: string
  /** Latest observed checkpoint, or `pending` before its first event. */
  readonly state: RunPhaseState
}

/** The panel-ready projection of one transcription run. */
export interface TranscriberRun {
  /** Engine run id of the current attempt. */
  readonly runId: string
  /** Title used to associate the run with a lecture row. */
  readonly title: string
  /** All phases in the current attempt's declared order. */
  readonly phases: readonly TranscriberRunPhase[]
  /** Phase ids whose latest state is complete. */
  readonly done: readonly string[]
  /** Phase ids whose latest state is running. */
  readonly running: readonly string[]
  /** Phase ids whose latest state is failed. */
  readonly failed: readonly string[]
  /** Whether the current attempt has emitted its terminal `result`. */
  readonly finished: boolean
  /** Overall status, including a failed phase before the terminal result. */
  readonly status: TranscriberRunStatus
}

/** The workspace file methods needed by the run reader. */
export type TranscriberRunsRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'read'>
}

/** Read the newest run for one module, or `undefined` when no run exists yet. */
export type ReadLatestRun = (
  sessionId: SessionId,
  moduleId: string,
  signal: AbortSignal,
) => Promise<RemoteResult<TranscriberRun | undefined>>

interface InitEvent {
  readonly event: 'init'
  readonly runId: string
  readonly title: string
  readonly phases: readonly string[]
  readonly labels: Readonly<Record<string, string>>
}

interface PhaseEvent {
  readonly event: 'phase'
  readonly phase: string
  readonly state: Exclude<RunPhaseState, 'pending'>
  readonly label: string
}

interface ResultEvent {
  readonly event: 'result'
  readonly status: string
}

type RunEvent = InitEvent | PhaseEvent | ResultEvent

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function stringListField(record: JsonRecord, key: string): string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return [...value]
}

function labelsField(record: JsonRecord): Readonly<Record<string, string>> {
  const value = record.labels
  if (!isRecord(value)) return {}
  const labels: Record<string, string> = {}
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === 'string') labels[key] = label
  }
  return labels
}

function emittedPhaseStateOf(value: string): Exclude<RunPhaseState, 'pending'> | undefined {
  return EMITTED_PHASE_STATES.has(value as Exclude<RunPhaseState, 'pending'>)
    ? value as Exclude<RunPhaseState, 'pending'>
    : undefined
}

function runEventOf(value: unknown): RunEvent | undefined {
  if (!isRecord(value)) return undefined
  const kind = stringField(value, 'event')
  if (kind === 'init') {
    const runId = stringField(value, 'run_id')
    const title = stringField(value, 'title')
    const phases = stringListField(value, 'phases')
    if (runId === undefined || title === undefined || phases === undefined) return undefined
    return { event: kind, runId, title, phases, labels: labelsField(value) }
  }
  if (kind === 'phase') {
    const phase = stringField(value, 'phase')
    const state = stringField(value, 'state')
    const label = stringField(value, 'label')
    if (phase === undefined || label === undefined || state === undefined) return undefined
    const emittedState = emittedPhaseStateOf(state)
    return emittedState === undefined ? undefined : { event: kind, phase, state: emittedState, label }
  }
  if (kind === 'result') {
    const status = stringField(value, 'status')
    return status === undefined ? undefined : { event: kind, status }
  }
  return undefined
}

function completeLines(text: string): string[] {
  const lines = text.split('\n')
  const last = lines.at(-1)
  // A final newline terminates the preceding JSON line. Without it, an
  // unparseable final line is the emitter's partial write and is discarded.
  if (last === '') lines.pop()
  return lines
}

function parseEvents(text: string): RunEvent[] {
  const events: RunEvent[] = []
  for (const line of completeLines(text)) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalized.trim() === '') continue
    try {
      const event = runEventOf(JSON.parse(normalized) as unknown)
      if (event !== undefined) events.push(event)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // The final line is allowed to be half written while a run is live.
      // Other malformed lines are ignored as unknown engine output as well.
    }
  }
  return events
}

function projectionOf(events: readonly RunEvent[]): TranscriberRun | undefined {
  let initIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.event === 'init') {
      initIndex = index
      break
    }
  }
  if (initIndex === -1) return undefined

  const init = events[initIndex]
  if (init === undefined || init.event !== 'init') return undefined
  const states = new Map<string, RunPhaseState>(init.phases.map(phase => [phase, 'pending']))
  const labels = new Map(init.phases.map(phase => [phase, init.labels[phase] ?? phase]))
  let resultStatus: string | undefined
  for (const event of events.slice(initIndex + 1)) {
    if (event.event === 'phase' && states.has(event.phase)) {
      states.set(event.phase, event.state)
      labels.set(event.phase, event.label)
    } else if (event.event === 'result') {
      resultStatus = event.status
    }
  }

  const phases = init.phases.map(name => ({
    name,
    label: labels.get(name) ?? name,
    state: states.get(name) ?? 'pending',
  }))
  const done = phases.filter(phase => COMPLETE_PHASE_STATES.has(phase.state)).map(phase => phase.name)
  const running = phases.filter(phase => phase.state === 'running').map(phase => phase.name)
  const failed = phases.filter(phase => phase.state === 'failed').map(phase => phase.name)
  const finished = resultStatus !== undefined
  const status: TranscriberRunStatus = finished
    ? resultStatus === 'SUCCESS' ? 'success' : 'failed'
    : failed.length > 0 ? 'failed' : 'running'
  return {
    runId: init.runId,
    title: init.title,
    phases,
    done,
    running,
    failed,
    finished,
    status,
  }
}

/**
 * Fold one events file, returning no run when it contains no valid `init`.
 * @param text - UTF-8 text read from `events.ndjson`.
 * @returns the latest attempt's panel projection, or `undefined` without an init event.
 */
export function foldRunEvents(text: string): TranscriberRun | undefined {
  return projectionOf(parseEvents(text))
}

function isMissing(failure: RemoteFailure): boolean {
  return failure.code === 'workspace-file/not-found' || failure.code === 'workspace-file/not-directory'
}

function newestRunDirectory(entries: readonly { name: string; type: string }[]): string | undefined {
  return entries
    .filter(entry => entry.type === 'directory')
    .map(entry => entry.name)
    .sort((left, right) => left < right ? 1 : left > right ? -1 : 0)[0]
}

/**
 * Bind run discovery to the read-only workspace file service.
 * @param remote - the workspace listing and reading face.
 * @returns a reader for the newest run of one module.
 */
export function createReadLatestRun(remote: TranscriberRunsRemote): ReadLatestRun {
  const files = remote.workspaceFiles
  return async (sessionId, moduleId, signal) => {
    const listing = await files.list(sessionId, `modules/${moduleId}/${RUNS_DIR}`, signal)
    if (!listing.ok) return isMissing(listing.error) ? { ok: true, value: undefined } : listing
    const runId = newestRunDirectory(listing.value.entries)
    if (runId === undefined) return { ok: true, value: undefined }

    const events = await files.read(
      sessionId,
      `modules/${moduleId}/${RUNS_DIR}/${runId}/${EVENTS_FILE}`,
      {},
      signal,
    )
    if (!events.ok) return isMissing(events.error) ? { ok: true, value: undefined } : events
    return { ok: true, value: foldRunEvents(events.value.text) }
  }
}
