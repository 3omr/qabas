/** Background lecture pipelines and chat fallback, with persisted FIFO admission. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TranscriberPipelineOutcome } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { actionRules, sentence, TRANSCRIBER_PRESET } from './chat-actions.ts'
import { requireConversation } from './conversation.ts'
import { lectureStopReason } from './job-failure.ts'
import { jobProgress, stepProgress } from './job-progress.ts'
import type { LibraryAction, LibraryTarget } from './service.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** Work offered by the library's action registry. */
export type JobKind = 'transcribe' | 'redo' | 'continue' | 'questions' | 'audit'

/**
 * Whether a job works on one lecture: it needs the lecture's title, carries
 * it to the pipeline, and tracks finalization separately from a finished repair budget.
 * @param kind - background job operation.
 * @returns whether the job runs the lecture transcription procedure.
 */
export function isLectureJob(kind: JobKind): boolean {
  return kind === 'transcribe' || kind === 'redo' || kind === 'continue'
}
/** Admission, live activity, and terminal outcomes of one background job. */
export type JobStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed'
/** Current or last transcriber tool, with optional draft-part progress. */
export interface JobStep {
  readonly tool: string
  readonly part?: number
  readonly parts?: number
  /** The completed begin call uploaded at least one recording. */
  readonly uploaded?: boolean
}
/** A resumable stop requiring student action or an explicit Continue. */
export interface JobStop {
  readonly kind: 'network' | 'quota' | 'auth' | 'missing-recording' | 'retry-limit'
  /** When a spent quota renews, as the provider reported it. */
  readonly resetAt?: string
  /** The signed-out service, named for the student. */
  readonly service?: 'NotebookLM' | 'Antigravity' | 'Google'
}
/** Fixed stop note for exhausted automatic engine retries. */
export const PIPELINE_RETRY_LIMIT_NOTE = 'Automatic retries stopped after repeated engine errors; your retained work is available through Continue.'

/** Persisted job identity and target, with live question presentation. */
export interface LibraryJob {
  readonly id: string
  readonly sessionId?: string
  /** Retained engine identity and deadline across an internal chat repair and reload. */
  readonly resumeManifest?: string
  readonly repairDeadline?: number
  readonly chatRepair?: boolean
  /** Automatic recovery attempts persist across reloads and stop at the recorded limit. */
  readonly retry?: { readonly attempt: number; readonly limit: number }
  readonly kind: JobKind
  readonly module: string
  readonly moduleName: string
  readonly lecture?: string
  readonly status: JobStatus
  readonly step?: JobStep
  /** Latest progress of the running transcriber call, cleared at its result or next call. */
  readonly progress?: { readonly done: number; readonly total?: number; readonly message?: string }
  /** A successful finalize in this lecture job's session survives later model errors and reloads. */
  readonly goalReached?: boolean
  /** Source warnings and any failure after finalization, persisted for the job tray. */
  readonly note?: string
  readonly question?: { readonly key: string; readonly questions: readonly AskUserQuestionItem[] }
  /** Why the pipeline stopped for the student: the only stops it does not repair itself. */
  readonly stop?: JobStop
  readonly summary?: string
  readonly error?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Background library work, independent of the selected conversation. */
    libraryJobs: LibraryJobs
  }
}

const PersistedJob = z.object({
  id: z.string().min(1), sessionId: z.string().min(1).optional(),
  resumeManifest: z.string().min(1).optional(), repairDeadline: z.number().positive().optional(), chatRepair: z.boolean().optional(),
  retry: z.object({ attempt: z.number().int().nonnegative(), limit: z.number().int().nonnegative() }).optional(),
  kind: z.enum(['transcribe', 'redo', 'continue', 'questions', 'audit'] as const),
  module: z.string(), moduleName: z.string(), lecture: z.string().optional(),
  status: z.enum(['queued', 'starting', 'running', 'waiting', 'done', 'stopped', 'failed'] as const),
  step: z.object({
    tool: z.string(), part: z.number().int().positive().optional(), parts: z.number().int().positive().optional(),
  }).optional(),
  progress: z.object({
    done: z.number().nonnegative(), total: z.number().nonnegative().optional(), message: z.string().optional(),
  }).optional(),
  goalReached: z.boolean().optional(), note: z.string().optional(),
  stop: z.object({
    kind: z.enum(['network', 'quota', 'auth', 'missing-recording', 'retry-limit'] as const),
    resetAt: z.string().optional(), service: z.enum(['NotebookLM', 'Antigravity', 'Google'] as const).optional(),
  }).optional(),
  summary: z.string().optional(), error: z.string().optional(),
  startedAt: z.number(), finishedAt: z.number().optional(),
}).refine(job => !isLectureJob(job.kind) || job.lecture !== undefined)

/**
 * Restore what the browser kept, one job at a time. Storage outlives code: a
 * job written by an older build (or by a bug since fixed) is dropped, never
 * thrown on — one bad entry took the whole library down at startup.
 * @param stored - whatever the persisted store holds.
 * @returns the valid jobs, first copy of each id.
 */
export function restoreJobs(stored: unknown): readonly LibraryJob[] {
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  const jobs: LibraryJob[] = []
  for (const entry of stored) {
    const parsed = PersistedJob.safeParse(entry)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    const job = parsed.data as LibraryJob
    if (isLectureJob(job.kind) && job.status === 'failed') {
      const reason = job.goalReached === true ? undefined : lectureStopReason(job.error ?? '')
      const { error: _error, ...retained } = job
      jobs.push({ ...retained, status: job.goalReached === true ? 'done' : reason === undefined ? 'queued' : 'stopped',
        ...reason === undefined ? {} : { summary: reason },
        note: reason ?? job.note ?? 'A previous run retained its work; Continue can resume it.' })
    } else jobs.push(job)
  }
  return jobs
}

function finished(job: LibraryJob): boolean {
  return job.status === 'done' || job.status === 'stopped' || job.status === 'failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ActiveJob {
  abort?: AbortController
  deadlineTimer?: ReturnType<typeof setTimeout>
  binding?: SessionBinding
  chat?: { getSnapshot(): ChatSnapshot | undefined }
  release: () => Promise<void>
  launch?: Promise<void>
  observedRunning: boolean
  cancelling: boolean
}

/** Owns background admission and observes the existing public Session and Conversation faces. */
export class LibraryJobs extends Service {
  /** Newest-first jobs; questions are live and are never restored from storage. */
  readonly jobs: SnapshotStore<readonly LibraryJob[]>
  private readonly active = new Map<string, ActiveJob>()
  private alive = true

  /**
   * @param ctx - client plugin context with library, Sessions, and pending interactions.
   * @param concurrency - validated maximum active jobs, including waiting jobs.
   * @param chatRepairTimeoutMs - maximum last-resort conversation duration.
   * @param chatRepairCancelGraceMs - base retry delay and grace after canceling legacy chat writes.
   * @param pipelineRetryLimit - maximum automatic retries of failed lecture engine requests.
   */
  constructor(
    ctx: Context, private readonly concurrency: number, private readonly chatRepairTimeoutMs = 5 * 60 * 1000,
    private readonly chatRepairCancelGraceMs = 30000, private readonly pipelineRetryLimit = 3,
  ) {
    super(ctx, 'libraryJobs')
    const persisted = createSnapshotStore<unknown>([], { persist: { name: 'dsh.library.jobs' } })
    this.jobs = createSnapshotStore<readonly LibraryJob[]>(restoreJobs(persisted.getSnapshot()))
    ctx.effect(() => {
      const unsubscribe = this.jobs.subscribe(() => {
        persisted.set(this.jobs.getSnapshot().map(({ question: _question, ...job }) => job))
      })
      const releaseList = ctx.sessions.list.subscribe(() => { this.restore() })
      const releaseQuestions = ctx.uiSession.pendingInteractions.subscribe(() => {
        for (const [id, runtime] of this.active) this.observe(id, runtime)
      })
      return async () => {
        this.alive = false
        releaseList()
        releaseQuestions()
        for (const runtime of this.active.values()) {
          runtime.abort?.abort()
          clearTimeout(runtime.deadlineTimer)
        }
        await Promise.all([...this.active.values()].flatMap(runtime => [
          runtime.release(), Promise.resolve(runtime.launch),
        ]))
        unsubscribe()
      }
    }, 'ui-library: background job observations')
    this.restore()
  }

  /**
   * Queue work without selecting its session. Lecture kinds require an exact unit title.
   * @param kind - requested procedure.
   * @param target - module and optional lecture.
   * @returns stable job identity, available before session creation.
   */
  start(kind: JobKind, target: LibraryTarget): string {
    if (isLectureJob(kind) && target.lecture === undefined) {
      throw new Error(`${kind} requires a lecture`)
    }
    const id = randomUUID()
    const lecture = isLectureJob(kind) ? target.lecture?.title : undefined
    this.jobs.set([{
      id, kind, module: target.module.id, moduleName: target.module.displayName,
      ...lecture === undefined ? {} : { lecture }, status: 'queued', startedAt: Date.now(),
    }, ...this.jobs.getSnapshot()])
    this.pump()
    return id
  }

  /**
   * Queue targets in their supplied order.
   * @param kind - requested procedure.
   * @param targets - ordered work.
   * @returns stable identities in target order.
   */
  startMany(kind: JobKind, targets: readonly LibraryTarget[]): string[] {
    return targets.map(target => this.start(kind, target))
  }

  /**
   * Settle the same pending object the conversation composer answers.
   * @param jobId - job with a current question.
   * @param answer - complete answer batch.
   * @returns settlement; rejects if the job has no pending question.
   */
  async answer(jobId: string, answer: AskUserQuestionAnswer): Promise<void> {
    const pending = this.pending(this.require(jobId))
    if (pending === undefined) throw new Error(`job ${jobId} has no pending question`)
    await pending.answer(answer)
  }

  /**
   * Select the job's session in the Conversation panel; queued jobs have none.
   * @param jobId - existing job identity.
   */
  open(jobId: string): void {
    const { sessionId } = this.require(jobId)
    if (sessionId === undefined) return
    this.ctx.sessions.open(sessionId as SessionId)
    this.ctx.layout.selectPanel('conversation' as MainPanelId)
  }

  /**
   * Drop queued work or request interruption. Active slots remain occupied until idle.
   * @param jobId - existing job identity.
   * @returns cancellation admission; transport failures reject.
   */
  async cancel(jobId: string): Promise<void> {
    const job = this.require(jobId)
    if (finished(job)) return
    const runtime = this.active.get(jobId)
    if (runtime === undefined) {
      this.end(job, 'stopped')
      return
    }
    runtime.cancelling = true
    runtime.abort?.abort()
    await runtime.launch
    const current = this.require(jobId)
    if (finished(current)) return
    if (runtime.binding === undefined) {
      await runtime.release()
      this.end(current, 'stopped')
      return
    }
    try {
      await requireConversation(this.ctx, runtime.binding.sessionId).cancel()
    } catch (error) {
      runtime.cancelling = false
      throw error
    }
    this.observe(jobId, runtime)
  }

  /**
   * Remove a terminal job; live and queued jobs stay visible.
   * @param jobId - existing job identity.
   */
  dismiss(jobId: string): void {
    if (!finished(this.require(jobId))) return
    this.jobs.set(this.jobs.getSnapshot().filter(job => job.id !== jobId))
  }

  private require(id: string): LibraryJob {
    const job = this.jobs.getSnapshot().find(job => job.id === id)
    if (job === undefined) throw new Error(`unknown library job ${id}`)
    return job
  }

  private patch(id: string, patch: { [Key in keyof LibraryJob]?: LibraryJob[Key] | undefined }): void {
    this.jobs.set(this.jobs.getSnapshot().map(job => job.id === id
      ? Object.fromEntries(Object.entries({ ...job, ...patch }).filter(([, field]) => field !== undefined)) as unknown as LibraryJob
      : job))
  }

  private pending(job: LibraryJob): PendingQuestion | undefined {
    if (job.sessionId === undefined) return undefined
    const pending = this.ctx.uiSession.pendingInteractions.getSnapshot().get(job.sessionId as SessionId)
    return pending !== undefined && 'questions' in pending ? pending : undefined
  }

  private restore(): void {
    if (!this.alive || this.ctx.sessions.list.getSnapshot().phase !== 'ready') return
    const restored = this.jobs.getSnapshot().filter(job => !finished(job) && job.status !== 'queued' && !this.active.has(job.id))
    for (const job of restored) {
      this.active.set(job.id, { release: () => Promise.resolve(), observedRunning: job.status !== 'starting', cancelling: false })
    }
    for (const job of restored) {
      if (job.sessionId === undefined) {
        if (isLectureJob(job.kind)) {
          this.active.delete(job.id)
          this.patch(job.id, { status: 'queued', kind: 'continue', progress: undefined })
        } else this.end(job, 'stopped')
      }
      else {
        const runtime = this.active.get(job.id) as ActiveJob
        runtime.launch = this.resume(job, runtime)
      }
    }
    this.pump()
  }

  private async resume(job: LibraryJob, runtime: ActiveJob): Promise<void> {
    try {
      if (isLectureJob(job.kind) && job.chatRepair !== true) {
        this.patch(job.id, { chatRepair: true, repairDeadline: Date.now() + this.chatRepairTimeoutMs + 60000 })
      }
      await this.attach(this.require(job.id), runtime)
    } catch (error) {
      this.fail(job.id, error)
    }
  }

  private pump(): void {
    if (!this.alive) return
    for (const job of [...this.jobs.getSnapshot()].reverse()) {
      if (this.active.size >= this.concurrency) break
      if (job.status !== 'queued') continue
      const runtime: ActiveJob = { release: () => Promise.resolve(), observedRunning: false, cancelling: false }
      this.active.set(job.id, runtime)
      this.patch(job.id, { status: 'starting' })
      runtime.launch = this.launch(job, runtime)
    }
  }

  private async launch(job: LibraryJob, runtime: ActiveJob): Promise<void> {
    try {
      const cwd = this.ctx.library.state.getSnapshot().workspace
      if (cwd === undefined) throw new Error('library workspace is not loaded')
      if (isLectureJob(job.kind) && this.ctx.get('remote')?.transcriberEngine.runLecturePipeline !== undefined) {
        if (await this.pipeline(job, runtime)) return
        if (!this.alive || runtime.cancelling) {
          if (this.alive) this.end(this.require(job.id), 'stopped')
          return
        }
      }
      if (isLectureJob(job.kind) && this.require(job.id).chatRepair !== true) {
        this.patch(job.id, { chatRepair: true, repairDeadline: Date.now() + this.chatRepairTimeoutMs + 60000 })
      }
      const sessionId = await this.ctx.sessions.create({ cwd, agentPreset: TRANSCRIBER_PRESET })
      this.patch(job.id, { sessionId })
      if (!this.alive) return
      if (runtime.cancelling) {
        this.end(this.require(job.id), 'stopped')
        return
      }
      const binding = await this.attach(this.require(job.id), runtime)
      if (binding === undefined || runtime.binding !== binding) return
      await requireConversation(this.ctx, binding.sessionId).send(sentence(job.kind, {
        module: { displayName: job.moduleName },
        ...job.lecture === undefined ? {} : { lecture: { title: job.lecture } },
      }))
      this.observe(job.id, runtime)
    } catch (error) {
      this.fail(job.id, error)
    }
  }

  private async pipeline(job: LibraryJob, runtime: ActiveJob, salvage = false): Promise<boolean> {
    const engine = this.ctx.get('remote')?.transcriberEngine
    if (engine?.runLecturePipeline === undefined) return false
    const abort = new AbortController()
    runtime.abort = abort
    let outcome: TranscriberPipelineOutcome | undefined
    try {
      this.patch(job.id, { status: 'running', ...salvage ? { repairDeadline: undefined } : {} })
      for await (const frame of engine.runLecturePipeline({
        module: job.module, lecture: job.lecture as string, mode: salvage ? 'continue' : job.kind as 'transcribe' | 'redo' | 'continue',
        ...salvage ? { salvage: true, resume_manifest: job.resumeManifest } : {},
      }, abort.signal)) {
        if (!this.alive || runtime.cancelling) break
        if (frame.type === 'progress') {
          this.patch(job.id, stepProgress(frame.step, { done: frame.done, total: frame.total, message: frame.message }))
        } else {
          outcome = frame.outcome
          if (outcome.status === 'finalized') {
            const note = [...new Set([...(this.require(job.id).note?.split('\n') ?? []), ...(outcome.note?.split('\n') ?? [])])]
              .filter(Boolean).join('\n') || undefined
            this.patch(job.id, { goalReached: true, note })
          }
        }
      }
      if (!this.alive) return true
      if (runtime.cancelling) {
        this.end(this.require(job.id), outcome?.status === 'finalized' ? 'done' : 'stopped', undefined,
          outcome?.status === 'finalized' ? outcome.summary : undefined)
        return true
      }
      if (outcome === undefined) throw new Error('Lecture pipeline ended without an outcome')
      switch (outcome.status) {
        case 'finalized':
          // The engine's finalize report is for logs; the tray says "done" itself.
          this.patch(job.id, { goalReached: true })
          this.end(this.require(job.id), 'done')
          return true
        case 'stopped': {
          const service = /NotebookLM/u.test(outcome.reason) ? 'NotebookLM' : /Antigravity/u.test(outcome.reason) ? 'Antigravity' : 'Google'
          const stop: JobStop = {
            kind: outcome.kind,
            ...outcome.reset_at === undefined ? {} : { resetAt: outcome.reset_at },
            ...outcome.kind === 'auth' ? { service } : {},
          }
          this.patch(job.id, { step: { tool: outcome.step }, stop })
          this.end(this.require(job.id), 'stopped', undefined, outcome.reason)
          return true
        }

      }
    } catch (error: unknown) {
      if (runtime.cancelling) {
        if (this.alive) this.end(this.require(job.id), this.require(job.id).goalReached === true ? 'done' : 'stopped')
        return true
      }
      const stopped = lectureStopReason(errorMessage(error))
      if (stopped !== undefined) {
        if (this.alive) this.end(this.require(job.id), 'stopped', undefined, stopped)
        return true
      }
      const code = typeof error === 'object'  && error !== null && 'code' in error ? error.code : undefined
      if (['gateway/method-unavailable', 'gateway/service-unavailable', 'gateway/definition-unavailable',
        'gateway/invocation-unavailable'].includes(String(code))) return false
      throw error
    } finally { delete runtime.abort }
  }

  private async attach(job: LibraryJob, runtime: ActiveJob): Promise<SessionBinding | undefined> {
    const binding = this.ctx.sessions.binding(job.sessionId as SessionId)
    if (binding === undefined) {
      this.end(job, 'failed', `session ${job.sessionId} is unavailable`)
      return undefined
    }
    runtime.binding = binding
    const watch = this.ctx.sessions.watch(binding.sessionId)
    const chat = this.ctx.uiConversation.binding(binding).target('chat')
    const changed = (): void => { this.observe(job.id, runtime) }
    runtime.release = this.ctx.effect(function* () {
      yield () => { delete runtime.binding; return watch.release() }
      yield binding.session.subscribe(changed)
      yield chat.subscribe(changed)
    }, 'ui-library: retained session history')
    await watch.ready
    if (!this.alive || this.active.get(job.id) !== runtime || runtime.binding !== binding) return undefined
    runtime.chat = chat
    if (job.chatRepair === true) {
      const remaining = Math.max(0, (job.repairDeadline ?? Date.now() + this.chatRepairTimeoutMs) - Date.now() - 60000)
      runtime.deadlineTimer = setTimeout(() => {
        this.salvage(job.id, runtime)
      }, Math.min(this.chatRepairTimeoutMs, remaining))
    }
    this.observe(job.id, runtime)
    return binding
  }

  private observe(id: string, runtime: ActiveJob): void {
    if (!this.alive || this.active.get(id) !== runtime || runtime.binding === undefined || runtime.chat === undefined) return
    const job = this.require(id)
    const session = runtime.binding.session.getSnapshot()
    const progress = jobProgress(runtime.chat.getSnapshot())
    const goalReached = isLectureJob(job.kind) && (job.goalReached === true || progress.finalized)
    if (progress.warnings.length > 0) {
      const note = [...new Set([...(job.note?.split('\n') ?? []), ...progress.warnings])].join('\n')
      if (note !== job.note) this.patch(id, { note })
    }
    if (goalReached && job.goalReached !== true) this.patch(id, { goalReached: true })
    const error = session.lastAgentError ?? session.promptError?.error.message ?? session.openError?.message
    if (error !== undefined) {
      if (job.chatRepair === true && !goalReached && !runtime.cancelling) {
        const reason = lectureStopReason(error)
        if (reason !== undefined) this.end(this.require(id), 'stopped', undefined, reason)
        else this.salvage(id, runtime)
      } else this.end(this.require(id), goalReached ? 'done' : 'failed', error, progress.summary)
      return
    }
    if (session.removed) {
      this.end(this.require(id), 'stopped')
      return
    }
    if (progress.call !== undefined) {
      const step = progress.call.step
      if (job.step?.tool !== step.tool || (step.uploaded === true && job.step.uploaded !== true)) {
        void this.ctx.library.loadModule(job.module, step.uploaded === true)
      }
      this.patch(id, { step, progress: progress.call.progress })
    }
    const pending = this.pending(job)
    runtime.observedRunning ||= session.running || progress.reason !== undefined
    if (pending !== undefined) {
      if (job.chatRepair === true) {
        this.salvage(id, runtime)
        return
      }
      this.patch(id, { status: 'waiting', question: { key: pending.key, questions: pending.questions } })
    } else if (session.running) {
      this.patch(id, { status: 'running', question: undefined })
    } else if ((runtime.observedRunning || runtime.cancelling) && !session.awaitingFirstTurn
      && (progress.reason !== undefined || runtime.cancelling)) {
      if (progress.reason?.kind === 'error') {
        if (job.chatRepair === true && !goalReached && !runtime.cancelling) {
          const reason = lectureStopReason(progress.reason.error.message)
          if (reason !== undefined) this.end(this.require(id), 'stopped', undefined, reason)
          else this.salvage(id, runtime)
        } else this.end(this.require(id), goalReached ? 'done' : 'failed', progress.reason.error.message, progress.summary)
        return
      }
      const complete = isLectureJob(job.kind)
        ? goalReached
        : progress.reason?.kind === 'completed'
      if (job.chatRepair === true && !goalReached && !runtime.cancelling) { this.salvage(id, runtime); return }
      this.end(this.require(id), complete && (goalReached || !runtime.cancelling) ? 'done' : 'stopped', undefined, progress.summary)
    } else {
      this.patch(id, { status: 'starting', question: undefined })
    }
  }

  private salvage(id: string, runtime: ActiveJob): void {
    if (!this.alive || this.active.get(id) !== runtime || runtime.binding === undefined) return
    const release = runtime.release
    const binding = runtime.binding
    const abort = new AbortController()
    runtime.abort = abort
    delete runtime.binding
    delete runtime.chat
    clearTimeout(runtime.deadlineTimer)
    runtime.release = () => Promise.resolve()
    this.patch(id, { status: 'running', question: undefined })
    runtime.launch = (async () => {
      let cleanup: (() => void) | undefined
      let quiet: boolean
      try {
        await requireConversation(this.ctx, binding.sessionId).cancel()
        quiet = await new Promise<boolean>((resolve) => {
          const check = (): void => {
            if (!binding.session.getSnapshot().running) resolve(true)
          }
          const remove = this.ctx.effect(() => binding.session.subscribe(check), 'ui-library: repair quiescence')
          const stopped = (): void => { resolve(false) }
          abort.signal.addEventListener('abort', stopped, { once: true })
          const timer = setTimeout(() => { resolve(false) }, this.chatRepairCancelGraceMs)
          check()
          if (abort.signal.aborted) stopped()
          cleanup = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', stopped); void remove() }
        })
      } finally {
        cleanup?.()
        delete runtime.abort
        await release()
      }
      if (!this.alive || runtime.cancelling) { if (this.alive) this.end(this.require(id), 'stopped'); return }
      if (!quiet) throw new Error('The conversation has not released its writes; retained work remains available for Continue.')
      const handled = await this.pipeline(this.require(id), runtime, true)
      if (!handled) throw new Error('No engine salvage Remote is available; the retained lecture work remains available for Continue.')
    })().catch((error: unknown) => { this.fail(id, error) })
  }

  private fail(id: string, error: unknown): void {
    if (this.alive) {
      const job = this.require(id)
      this.end(job, job.goalReached === true ? 'done' : 'failed', errorMessage(error))
    }
  }

  private retryLecture(job: LibraryJob, runtime: ActiveJob | undefined, error: string | undefined): void {
    const retry = { attempt: (job.retry?.attempt ?? 0) + 1, limit: job.retry?.limit ?? this.pipelineRetryLimit }
    this.patch(job.id, { status: runtime === undefined ? 'queued' : 'running', error, retry,
      step: job.step ?? { tool: 'begin_lecture' }, progress: undefined, question: undefined, finishedAt: undefined })
    if (runtime === undefined) { this.pump(); return }
    const released = runtime.release()
    runtime.release = () => released
    runtime.deadlineTimer = setTimeout(() => {
      runtime.launch = (async () => {
        await released
        if (!this.alive || runtime.cancelling || this.active.get(job.id) !== runtime) return
        if (!await this.pipeline(this.require(job.id), runtime, true)) {
          await this.launch({ ...this.require(job.id), kind: 'continue' }, runtime)
        }
      })().catch((error: unknown) => { this.fail(job.id, error) })
    }, Math.min(2147483647, this.chatRepairCancelGraceMs * 2 ** (retry.attempt - 1)))
  }

  private end(job: LibraryJob, status: 'done' | 'stopped' | 'failed', error?: string, summary?: string): void {
    const runtime = this.active.get(job.id)
    clearTimeout(runtime?.deadlineTimer)
    if (isLectureJob(job.kind) && status === 'failed') {
      const reason = lectureStopReason(error ?? '')
      if (reason !== undefined) { status = 'stopped'; summary = reason; error = undefined }
      else if (job.goalReached === true) status = 'done'
      else if ((job.retry?.attempt ?? 0) < (job.retry?.limit ?? this.pipelineRetryLimit)) {
        this.retryLecture(job, runtime, error)
        return
      } else {
        status = 'stopped'
        summary = PIPELINE_RETRY_LIMIT_NOTE
        this.patch(job.id, { stop: { kind: 'retry-limit' }, note: [job.note, PIPELINE_RETRY_LIMIT_NOTE].filter(Boolean).join('\n') })
        job = this.require(job.id)
      }
    }
    void runtime?.release().catch((error: unknown) => { this.ctx.logger.error(error) })
    this.active.delete(job.id)
    this.patch(job.id, { status, error: status === 'done' ? undefined : error,
      note: [job.note, status === 'done' ? error : undefined].filter(Boolean).join('\n') || undefined, summary, progress: undefined, question: undefined, finishedAt: Date.now() })
    void this.ctx.library.loadModule(job.module)
    this.pump()
  }
}

/**
 * Preserve the library action rules while admitting background jobs.
 * @param t - library translator.
 * @param jobs - background runner.
 * @returns actions with the same ids, order, scope, labels, and applicability as chat actions.
 */
export function jobActions(t: TranslateNS<'library'>, jobs: LibraryJobs): LibraryAction[] {
  return actionRules(t).map(action => ({
    ...action, run: (target) => { jobs.start(action.id, target) },
  }))
}
