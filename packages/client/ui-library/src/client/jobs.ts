/** Background transcriber sessions, their FIFO admission, and shared question presentation. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { actionRules, sentence, TRANSCRIBER_PRESET } from './chat-actions.ts'
import { requireConversation } from './conversation.ts'
import { jobProgress } from './job-progress.ts'
import type { LibraryAction, LibraryTarget } from './service.ts'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

/** Work offered by the library's action registry. */
export type JobKind = 'transcribe' | 'redo' | 'continue' | 'questions' | 'audit'
/** Admission, live activity, and terminal outcomes of one background session. */
export type JobStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'done' | 'stopped' | 'failed'
/** Current or last transcriber tool, with optional draft-part progress. */
export interface JobStep {
  readonly tool: string
  readonly part?: number
  readonly parts?: number
}
/** Persisted job identity and target, with live question presentation. */
export interface LibraryJob {
  readonly id: string
  readonly sessionId?: string
  readonly kind: JobKind
  readonly module: string
  readonly moduleName: string
  readonly lecture?: string
  readonly status: JobStatus
  readonly step?: JobStep
  readonly question?: { readonly key: string; readonly questions: readonly AskUserQuestionItem[] }
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
  kind: z.enum(['transcribe', 'redo', 'continue', 'questions', 'audit'] as const),
  module: z.string(), moduleName: z.string(), lecture: z.string().optional(),
  status: z.enum(['queued', 'starting', 'running', 'waiting', 'done', 'stopped', 'failed'] as const),
  step: z.object({
    tool: z.string(), part: z.number().int().positive().optional(), parts: z.number().int().positive().optional(),
  }).optional(),
  summary: z.string().optional(), error: z.string().optional(),
  startedAt: z.number(), finishedAt: z.number().optional(),
}).refine(job => (job.kind !== 'transcribe' && job.kind !== 'redo' && job.kind !== 'continue') || job.lecture !== undefined)
const PersistedJobs = z.array(PersistedJob).refine(jobs => new Set(jobs.map(job => job.id)).size === jobs.length)

function finished(job: LibraryJob): boolean {
  return job.status === 'done' || job.status === 'stopped' || job.status === 'failed'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ActiveJob {
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
   */
  constructor(ctx: Context, private readonly concurrency: number) {
    super(ctx, 'libraryJobs')
    const persisted = createSnapshotStore<unknown>([], { persist: { name: 'dsh.library.jobs' } })
    this.jobs = createSnapshotStore<readonly LibraryJob[]>(PersistedJobs.parse(persisted.getSnapshot()) as readonly LibraryJob[])
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
    if ((kind === 'transcribe' || kind === 'continue') && target.lecture === undefined) {
      throw new Error(`${kind} requires a lecture`)
    }
    const id = randomUUID()
    const lecture = kind === 'transcribe' || kind === 'continue' ? target.lecture?.title : undefined
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
    await runtime.launch
    const current = this.require(jobId)
    if (finished(current)) return
    try {
      await requireConversation(this.ctx, (runtime.binding as SessionBinding).sessionId).cancel()
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
      if (job.sessionId === undefined) this.end(job, 'stopped')
      else {
        const runtime = this.active.get(job.id) as ActiveJob
        runtime.launch = this.resume(job, runtime)
      }
    }
    this.pump()
  }

  private async resume(job: LibraryJob, runtime: ActiveJob): Promise<void> {
    try {
      await this.attach(job, runtime)
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
    this.observe(job.id, runtime)
    return binding
  }

  private observe(id: string, runtime: ActiveJob): void {
    if (!this.alive || this.active.get(id) !== runtime || runtime.binding === undefined || runtime.chat === undefined) return
    const job = this.require(id)
    const session = runtime.binding.session.getSnapshot()
    const progress = jobProgress(runtime.chat.getSnapshot())
    const error = session.lastAgentError ?? session.promptError?.error.message ?? session.openError?.message
    if (error !== undefined) {
      this.end(job, 'failed', error)
      return
    }
    if (session.removed) {
      this.end(job, 'stopped')
      return
    }
    if (progress.call !== undefined) {
      const step = progress.call.step
      if (job.step?.tool !== step.tool) void this.ctx.library.loadModule(job.module)
      this.patch(id, { step })
    }
    const pending = this.pending(job)
    runtime.observedRunning ||= session.running || progress.reason !== undefined
    if (pending !== undefined) {
      this.patch(id, { status: 'waiting', question: { key: pending.key, questions: pending.questions } })
    } else if (session.running) {
      this.patch(id, { status: 'running', question: undefined })
    } else if ((runtime.observedRunning || runtime.cancelling) && !session.awaitingFirstTurn
      && (progress.reason !== undefined || runtime.cancelling)) {
      if (progress.reason?.kind === 'error') {
        this.end(job, 'failed', progress.reason.error.message, progress.summary)
        return
      }
      const complete = job.kind === 'transcribe' || job.kind === 'continue'
        ? progress.call?.step.tool === 'finalize' && progress.call.successful
        : progress.reason?.kind === 'completed'
      this.end(this.require(id), complete && !runtime.cancelling ? 'done' : 'stopped', undefined, progress.summary)
    } else {
      this.patch(id, { status: 'starting', question: undefined })
    }
  }

  private fail(id: string, error: unknown): void {
    if (this.alive) this.end(this.require(id), 'failed', errorMessage(error))
  }

  private end(job: LibraryJob, status: 'done' | 'stopped' | 'failed', error?: string, summary?: string): void {
    const runtime = this.active.get(job.id)
    void runtime?.release().catch((error: unknown) => { this.ctx.logger.error(error) })
    this.active.delete(job.id)
    this.patch(job.id, { status, error, summary, question: undefined, finishedAt: Date.now() })
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
