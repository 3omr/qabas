/**
 * Host owner of the `authorization` Remote namespace: `ctx.authorization` as a
 * browser configuration page drives it.
 *
 * The seam it wraps is a conversation, not a call. A flow says "open this page"
 * and then asks "paste the code", and both have to reach a browser that is not
 * the browser doing the signing in. So one attempt is one server-to-client
 * stream of frames plus a second call carrying the answer back: `run` opens the
 * stream, every question arrives as a `prompt` frame with an id, and `answer`
 * resolves the promise the flow is blocked on. `cancel` exists for the same
 * reason the seam's own `cancel` does -- a Cancel button arrives on a different
 * request from the one it is cancelling, with no handle on its signal.
 *
 * Nothing secret travels outward. A flow's notices carry a sign-in URL or a
 * device code, which are addresses rather than credentials; the credential the
 * flow obtains is written into the credential store on the host and never
 * serialized to the caller.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { Context } from '@deepseek-ai/cordis'
import type { AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { AuthorizationEntryView, AuthorizationFrame } from './types.ts'

/**
 * Split `scope/id` into the two segments `credentialKey` validates.
 * @param key - the key as the wire spells it.
 * @returns the branded key.
 * @throws RemoteError when it is not two segments the grammar admits.
 */
function parseKey(key: string): CredentialKey {
  const slash = key.indexOf('/')
  if (slash <= 0 || slash === key.length - 1) {
    throw new RemoteError('gateway/bad-request', 'a credential key is "scope/id"', {})
  }
  try {
    return credentialKey(key.slice(0, slash), key.slice(slash + 1))
  } catch (error: unknown) {
    throw new RemoteError('gateway/bad-request', 'invalid credential key', {}, { cause: error })
  }
}

/** A credential key, as the seam spells one. */
const keySchema = z.string().min(1).max(200)


/** One question waiting on an answer from the page. */
interface PendingPrompt {
  resolve(value: string): void
  reject(error: Error): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 */
export class AuthorizationController extends TypertRemoteService {
  /**
   * The seam is required rather than optional: the controller is mounted from
   * inside its injection, so a composition without it simply has no
   * `authorization` namespace and a page asking for one is told the namespace
   * is unknown -- which the Models page already reads as "nothing to sign
   * into". Guarding for an absent seam here would be guarding for a state
   * this class cannot be constructed in.
   */
  static inject = ['authorization']

  /** Questions in flight, per attempt key, by prompt id. */
  private readonly pending = new Map<string, Map<string, PendingPrompt>>()
  private nextPromptId = 0

  /** @param ctx - Host context where an authorization seam may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /** The seam this controller is mounted beside. */
  private seam(): Context['authorization'] {
    return this.ctx.authorization
  }

  /**
   * Everything that can be signed into.
   * @returns one entry per registered flow, in registration order.
   */
  @Remote
  list(): AuthorizationEntryView[] {
    return this.seam().list().map(entry => ({
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight,
    }))
  }

  /**
   * Run one sign-in, reporting it as it happens.
   *
   * The stream ends with a `settled` frame; a flow that fails ends the stream
   * with the error instead, because a failure is not an outcome the page can
   * act on the way a refusal is.
   * @param key - the credential record to authorize.
   * @param method - which of the flow's methods; omitted takes its first.
   * @param signal - withdraws the attempt when the page navigates away.
   * @returns the attempt's frames, in order.
   */
  @Remote({ mode: 'stream' })
  async *run(key: string, method: string | undefined, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
    const parsed = keySchema.safeParse(key)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'invalid credential key', {})

    const frames: AuthorizationFrame[] = []
    let wake: (() => void) | undefined
    const push = (frame: AuthorizationFrame): void => {
      frames.push(frame)
      wake?.()
    }

    const questions = new Map<string, PendingPrompt>()
    this.pending.set(parsed.data, questions)

    const attempt = this.seam().begin({
      key: parseKey(parsed.data),
      ...method === undefined ? {} : { method },
      signal,
      interaction: {
        notify: (notice: AuthorizationNotice) => {
          push({
            type: 'notice',
            message: notice.message,
            ...notice.url === undefined ? {} : { url: notice.url },
            ...notice.code === undefined ? {} : { code: notice.code },
          })
        },
        prompt: (prompt: AuthorizationPrompt) => new Promise<string>((resolve, reject) => {
          const id = `p${this.nextPromptId += 1}`
          questions.set(id, { resolve, reject })
          push({
            type: 'prompt',
            id,
            message: prompt.message,
            kind: prompt.kind,
            ...prompt.kind === 'select'
              ? { options: prompt.options }
              : prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
          })
        }),
      },
    })

    // The attempt's settlement is one more thing to wake the loop, so the
    // generator never sits on an empty queue after the flow has finished.
    let settled: 'authorized' | 'cancelled' | undefined
    let failure: Error | undefined
    const finished = attempt.then(
      (outcome) => { settled = outcome.status },
      (error: unknown) => {
        // The seam rejects with its own error classes; anything else is still
        // a breakage the stream must end on rather than swallow.
        failure = error instanceof Error ? error : new Error(String(error))
      },
    ).finally(() => { wake?.() })

    try {
      for (;;) {
        for (;;) {
          const frame = frames.shift()
          if (frame === undefined) break
          yield frame
        }
        if (settled !== undefined) {
          yield { type: 'settled', outcome: settled }
          return
        }
        if (failure !== undefined) throw failure
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        wake = undefined
      }
    } finally {
      this.pending.delete(parsed.data)
      // A question still waiting when the stream ends would otherwise leave the
      // flow blocked on a promise nobody can resolve.
      for (const question of questions.values()) {
        question.reject(new AuthorizationDeclinedError('the sign-in surface went away'))
      }
      this.seam().cancel(parseKey(parsed.data))
      await finished
    }
  }

  /**
   * Answer a question the running attempt asked.
   * @param key - the attempt's credential record.
   * @param id - the `prompt` frame's id.
   * @param value - the typed text, or the chosen option's id.
   */
  @Remote
  answer(key: string, id: string, value: string): void {
    const question = this.pending.get(key)?.get(id)
    if (question === undefined) {
      // A late answer is not an error worth failing a page over: the attempt
      // may have been cancelled between the question and the reply.
      return
    }
    this.pending.get(key)?.delete(id)
    question.resolve(value)
  }

  /**
   * Withdraw the attempt running for a key.
   * @param key - the credential record whose sign-in should stop.
   */
  @Remote
  cancel(key: string): void {
    this.seam().cancel(parseKey(key))
  }
}

export default AuthorizationController
