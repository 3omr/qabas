/**
 * Host owner of the `credentials` Remote namespace: the reference half of
 * `ctx.credentials` as a browser configuration page reads and writes it.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/credentials.ts
 */

import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { checkGeminiKey } from './gemini-key.ts'
import type { GeminiKeyCheck } from './types.ts'

/** Deployment bounds for authenticated credential checks. */
export interface CredentialsControllerConfig {
  /** Gemini request deadline in milliseconds, including reading its quota response. */
  readonly geminiKeyCheckTimeoutMs?: number
}

/** Host HTTP transport replaceable by a fake fetch. */
export interface CredentialsControllerInternals {
  readonly fetch?: typeof fetch
}

/**
 * Fan-out bound on one remote `describe` batch. A settings page asks about the
 * references its own rows name, so this is far above any real page and still
 * keeps one authenticated request from starting unbounded provider work.
 */
const MAX_DESCRIBE_REFS = 64

const credentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const describeRequestSchema = z.object({
  refs: z.array(credentialRefSchema).max(MAX_DESCRIBE_REFS),
})
const setRequestSchema = z.object({ ref: credentialRefSchema, value: z.string().min(1) })
const unsetRequestSchema = z.object({ ref: credentialRefSchema })

/** Parse the domain constraints that are more specific than generated TypeScript codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/**
 * Copy exactly the fields {@link CredentialInfo} declares. The Gateway returns
 * a business result without decoding it, so a provider whose `describe` carried
 * extra enumerable properties would otherwise serialize them to the caller.
 * @param info - the provider's answer for one reference.
 * @returns the same facts with nothing else attached.
 */
function projectCredentialInfo(info: CredentialInfo): CredentialInfo {
  return {
    configured: info.configured,
    ...info.source === undefined ? {} : { source: info.source },
    writable: info.writable,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `credentials` Remote namespace. */
    credentialsController: CredentialsController
  }
}

/**
 * Host service backing the generated `ctx.remote.credentials` namespace. It
 * carries every wire obligation the credential seam itself does not: the batch
 * fan-out bound, the field-by-field view projection, the reference-grammar
 * guard, and the refusal mapping. Secret values cross in one direction only —
 * no method here returns one.
 */
export class CredentialsController extends TypertRemoteService {
  static Config: Schema<CredentialsControllerConfig> = Schema.object({
    geminiKeyCheckTimeoutMs: Schema.number().step(1).min(1).max(2 ** 31 - 1).default(5000),
  })

  private readonly checkTimeoutMs: number
  private readonly request: typeof fetch
  /**
   * @param ctx - Host context where a credential provider may be mounted.
   * @param config - validated request deadline.
   * @param internals - HTTP transport for Host tests.
   */
  constructor(ctx: Context, config: CredentialsControllerConfig = {}, internals: CredentialsControllerInternals = {}) {
    super(ctx, 'credentialsController', { namespace: 'credentials' })
    const resolved = CredentialsController.Config(config) as Required<CredentialsControllerConfig>
    this.checkTimeoutMs = resolved.geminiKeyCheckTimeoutMs
    this.request = internals.fetch ?? globalThis.fetch
  }

  /**
   * Check the current stored GEMINI_API_KEY using one authenticated models request.
   * A successful check awaits credential-dependent recovery resets.
   * @param signal - caller cancellation, combined with the configured short deadline.
   * @returns credential-safe status; catalog acceptance does not prove generation quota or model access.
   * @throws RemoteError when no credential provider is mounted.
   * @throws Error when a recovery reset fails after a successful check.
   */
  @Remote
  async checkGeminiKey(signal: AbortSignal): Promise<GeminiKeyCheck> {
    const credential = await this.provider().resolve(credentialRef('GEMINI_API_KEY'))
    if (credential === undefined || credential.value.trim() === '') return { status: 'no-key' }
    const result = await checkGeminiKey(credential.value, AbortSignal.any([signal, AbortSignal.timeout(this.checkTimeoutMs)]), this.request)
    if (result.status === 'works') await this.ctx.serial('credentials/reference-reset', credentialRef('GEMINI_API_KEY'))
    return result
  }

  /**
   * Describe several references for one configuration surface. Batched because
   * a settings page describes every reference its rows name at once, and one
   * round trip keeps those rows from settling separately.
   * @param refs - reference names, at most {@link MAX_DESCRIBE_REFS}; a name outside the grammar
   *   rejects the whole call as `gateway/bad-request`.
   * @returns one view per requested name, keyed by that name.
   * @throws RemoteError when the request is invalid or no credential provider is mounted.
   */
  @Remote
  async describe(refs: string[]): Promise<Record<string, CredentialInfo>> {
    const request = parseRequest('credentials.describe', describeRequestSchema, { refs })
    const branded = request.refs.map(ref => [ref, credentialRef(ref)] as const)
    const credentials = this.provider()
    const entries = await Promise.all(branded.map(async ([ref, key]) =>
      [ref, projectCredentialInfo(await credentials.describe(key))] as const))
    return Object.fromEntries(entries)
  }

  /**
   * Store one value from a configuration surface. The value crosses the wire in
   * this direction only: no read path returns it.
   * Awaits credential-dependent recovery resets after the write commits.
   * @param ref - reference name to store under.
   * @param value - the non-empty secret value.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   * @throws Error when a recovery reset fails after the credential write commits.
   */
  @Remote
  async set(ref: string, value: string): Promise<void> {
    const request = parseRequest('credentials.set', setRequestSchema, { ref, value })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.set(branded, request.value))
    await this.ctx.serial('credentials/reference-reset', branded)
  }

  /**
   * Remove one reference from a configuration surface.
   * Awaits credential-dependent recovery resets after the removal commits.
   * @param ref - reference name to remove.
   * @throws RemoteError when the request is invalid, no provider is mounted, or the provider refuses the write.
   * @throws Error when a recovery reset fails after the credential removal commits.
   */
  @Remote
  async unset(ref: string): Promise<void> {
    const request = parseRequest('credentials.unset', unsetRequestSchema, { ref })
    const branded = credentialRef(request.ref)
    const credentials = this.provider()
    await this.write(request.ref, () => credentials.unset(branded))
    await this.ctx.serial('credentials/reference-reset', branded)
  }

  /** Resolve the optional provider or report how to supply it. */
  private provider(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }

  /**
   * Run one remote write and report every refusal as `credential/rejected`
   * carrying the seam's own message: a read-only source shadowing the reference
   * is what a configuration surface must show verbatim. Callers brand the
   * reference before entering, so a name outside the grammar never reaches this
   * path and fails the same way it does on the read side. The details name only
   * the reference, so no failure path can carry the value back out.
   */
  private async write(ref: string, write: () => Promise<void>): Promise<void> {
    try {
      await write()
    } catch (error: unknown) {
      throw new RemoteError(
        'credential/rejected',
        error instanceof Error ? error.message : String(error),
        { ref },
        { cause: error },
      )
    }
  }
}

export default CredentialsController
