/**
 * Authenticated loopback Service Provider for the Tauri native desktop host.
 * Registers installed-app orientation when the system-prompt service is mounted.
 * @module @deepseek-ai/dsh-desktop-native
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DesktopHost, type DesktopNotification, type DesktopStatus, type DesktopProfileCandidate, type DesktopProfileName,
  type DesktopProfileSelection, type NotebookLmAuthPoll, type NotebookLmAuthSession, type NotebookLmAuthSessionId,
} from '@deepseek-ai/dsh-desktop'
import { z as wire } from 'zod'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-cmdline'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Decide whether a live top-level turn may request a background notification.
     * Policies call next() to delegate or return false to suppress delivery; no listener permits delivery.
     * A thrown policy suppresses this notification without changing the committed turn.
     * @param outcome - Completion or failure only; no Session identity or task contents.
     * @param next - Delegate to remaining policies.
     * @mode waterfall
     */
    'desktop/task-notification'(outcome: 'completed' | 'error', next: () => boolean): boolean
  }
}

const TOKEN_HEADER = 'x-dsh-desktop-bridge-token'

const profileName = wire.string().regex(/^(?:web|desktop-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u)
  .transform(value => value as DesktopProfileName)
const profileCandidate = wire.strictObject({
  profile: profileName.refine(value => value !== 'web'), previousProfile: profileName, manifestSha256: wire.string().regex(/^[a-f0-9]{64}$/u),
})
const profileSelection = wire.strictObject({
  ok: wire.literal(true),
  selection: wire.strictObject({
    schemaVersion: wire.literal(1), activeProfile: profileName, previousProfile: profileName.nullable(),
    pending: profileCandidate.nullable(), trial: profileCandidate.nullable(),
    lastFailure: wire.strictObject({ candidate: profileCandidate,
      reason: wire.enum(['interrupted', 'startup-failed', 'invalid-candidate']) }).nullable(),
  }),
})
const notebookLmAuthSession = wire.strictObject({
  ok: wire.literal(true),
  session: wire.string().regex(/^[0-9a-f]{32}$/u).transform(value => value as NotebookLmAuthSessionId),
})
const notebookLmAuthPoll = wire.strictObject({
  ok: wire.literal(true),
  cursor: wire.number().int().nonnegative(),
  output: wire.string(),
  done: wire.boolean(),
  exitCode: wire.number().int().nullable(),
  failure: wire.string().nullable(),
})

const DESKTOP_CONTEXT = 'You are interacting with the user through Harness Desktop, a desktop application built on DeepSeek Harness. '
  + 'References to "this app" or "this interface" mean this desktop application unless the user names another target. '
  + 'The interface provides no implicit screenshot, DOM, or route context. '
  + 'The app manages its bundled runtime. Starting a separate web server or rebuilding a workspace does not update this installed app. '
  + 'Do not modify installed application resources or restart the desktop app unless the user explicitly asks. '
  + 'Work in the selected session workspace; it is separate from the app installation.'

/** Private native-bridge connection parameters injected by the desktop supervisor. */
export interface Config {
  /** Loopback HTTP origin of the per-launch native bridge. */
  endpoint: string
  /** Per-launch bearer token known only to the native host and Harness child. */
  token: string
  /** Maximum time allowed for one native operation. */
  timeoutMs?: number
  /** Notify about completed or failed top-level turns while the app is in the background. */
  notifyOnTurnEnd?: boolean
  /** Per-child acknowledgement identity; requires launcher-owned appReady when configured. */
  startupToken?: string
}

interface ResolvedConfig {
  endpoint: string
  token: string
  timeoutMs: number
  notifyOnTurnEnd: boolean
  startupToken?: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().role('secret').required(),
  timeoutMs: z.natural().min(1).default(5_000),
  notifyOnTurnEnd: z.boolean().default(false),
  startupToken: z.string().role('secret'),
})

/**
 * Resolve and validate the private bridge origin before any operation can send its token.
 * @param config - schema-resolved plugin configuration.
 * @returns Normalized configuration with a URL origin and explicit timeout.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const endpoint = new URL(config.endpoint)
  if (endpoint.protocol !== 'http:'
    || endpoint.hostname !== '127.0.0.1'
    || endpoint.port === ''
    || endpoint.username !== ''
    || endpoint.password !== ''
    || endpoint.pathname !== '/'
    || endpoint.search !== ''
    || endpoint.hash !== '') {
    throw new Error('desktop-native: endpoint must be an http://127.0.0.1:<port> origin')
  }
  if (config.token.length === 0) throw new Error('desktop-native: token must not be empty')
  if (config.startupToken !== undefined && !/^[a-f0-9]{32}$/u.test(config.startupToken)) {
    throw new Error('desktop-native: startupToken must be a per-child hexadecimal identity')
  }
  return {
    endpoint: endpoint.origin,
    token: config.token,
    timeoutMs: config.timeoutMs ?? 5_000,
    notifyOnTurnEnd: config.notifyOnTurnEnd ?? false,
    ...config.startupToken === undefined ? {} : { startupToken: config.startupToken },
  }
}

/** Tauri-hosted implementation of `ctx.desktop` over a private per-launch HTTP bridge. */
export class NativeDesktopHost extends DesktopHost {
  static Config = Config
  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.startupToken !== undefined) {
      const ready = ctx.get('appReady')
      if (ready === undefined) throw new Error('desktop-native: startup acknowledgement requires launcher-owned appReady')
      const attempt = this.config.startupToken
      ctx.effect(() => {
        const abort = new AbortController()
        let pending: Promise<void> | undefined
        const detach = ready.onReady(() => {
          pending = this.request('POST', '/v1/runtime-ready', { attempt }, abort.signal).catch(() => {
            if (!abort.signal.aborted) ctx.logger.warn('desktop-native: startup acknowledgement could not be delivered')
          })
        })
        return async () => { detach(); abort.abort(); await pending }
      }, 'desktopNative.startupAcknowledgement')
    }
    if (this.config.notifyOnTurnEnd) {
      ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end' || session.header.parentSession !== undefined) return
        const kind = event.data.reason.kind
        if (kind !== 'completed' && kind !== 'error') return
        // The post-commit observer never blocks the agent or includes task contents.
        void this.notifyTurn(kind).catch(() => { ctx.logger.warn('desktop-native: background notification could not be delivered') })
      })
    }
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: 'app:desktop-surface',
        order: promptCtx.systemPrompt.getSectionOrder('WEB_SURFACE'),
        text: DESKTOP_CONTEXT,
      })
    })
  }

  /**
   * Probe the native bridge for desktop availability.
   * @returns The current native desktop status after the bridge responds.
   */
  async status(): Promise<DesktopStatus> {
    await this.request('GET', '/v1/status')
    return { available: true }
  }

  /**
   * Ask the native shell to reveal and focus its main window.
   * @returns After the native shell acknowledges the request.
   */
  show(): Promise<void> {
    return this.request('POST', '/v1/show')
  }

  openLocalAgents(): Promise<void> {
    return this.request('POST', '/v1/local-agents')
  }

  /**
   * Deliver a user-visible notification through the native shell.
   * @param notification - Notification title and optional body to display.
   * @returns After the native shell accepts the notification.
   */
  notify(notification: DesktopNotification): Promise<void> {
    return this.request('POST', '/v1/notify', notification)
  }

  /**
   * Enable or disable native login startup for the desktop application.
   * @param enabled - Whether the application should start at login.
   * @returns After the operating system records the state.
   */
  setAutostart(enabled: boolean): Promise<void> {
    return this.request('POST', '/v1/autostart', { enabled })
  }

  async profileSelection(): Promise<DesktopProfileSelection> {
    const response = await this.fetch('GET', '/v1/profile-selection')
    return profileSelection.parse(JSON.parse(await readSelection(response))).selection
  }

  queueProfile(candidate: DesktopProfileCandidate): Promise<void> {
    return this.request('POST', '/v1/profile-queue', candidate)
  }

  cancelProfile(profile: DesktopProfileName): Promise<void> {
    return this.request('POST', '/v1/profile-cancel', { profile })
  }

  async startNotebookLmAuth(): Promise<NotebookLmAuthSession> {
    const response = await this.fetch('POST', '/v1/notebooklm-auth/start')
    const value = notebookLmAuthSession.parse(JSON.parse(await readBody(response, 65_536, 'NotebookLM auth')))
    return { session: value.session }
  }

  async pollNotebookLmAuth(
    session: NotebookLmAuthSession,
    cursor: number,
    signal?: AbortSignal,
  ): Promise<NotebookLmAuthPoll> {
    const query = new URLSearchParams({ session: session.session, cursor: String(cursor) })
    const response = await this.fetch('GET', `/v1/notebooklm-auth/poll?${query.toString()}`, undefined, signal)
    const value = notebookLmAuthPoll.parse(JSON.parse(await readBody(response, 1_048_576, 'NotebookLM auth')))
    return {
      cursor: value.cursor,
      output: value.output,
      done: value.done,
      exitCode: value.exitCode,
      failure: value.failure,
    }
  }

  writeNotebookLmAuth(session: NotebookLmAuthSession, line: string): Promise<void> {
    return this.request('POST', '/v1/notebooklm-auth/write', { session: session.session, line })
  }

  cancelNotebookLmAuth(session: NotebookLmAuthSession): Promise<void> {
    return this.request('POST', '/v1/notebooklm-auth/cancel', { session: session.session })
  }

  private async notifyTurn(outcome: 'completed' | 'error'): Promise<void> {
    if (!this.ctx.waterfall('desktop/task-notification', outcome, () => true)) return
    await this.notify({
      title: 'Harness Desktop',
      body: outcome === 'completed'
        ? 'Task finished. Open Harness Desktop to review.'
        : 'Task failed. Open Harness Desktop to review.',
      backgroundOnly: true,
    })
  }

  private async request(method: 'GET' | 'POST', pathname: string, body?: object, signal?: AbortSignal): Promise<void> {
    await this.fetch(method, pathname, body, signal)
  }

  private async fetch(method: 'GET' | 'POST', pathname: string, body?: object, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetch(new URL(pathname, this.config.endpoint), {
        method,
        headers: {
          [TOKEN_HEADER]: this.config.token,
          ...body === undefined ? {} : { 'content-type': 'application/json' },
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: signal === undefined ? AbortSignal.timeout(this.config.timeoutMs)
          : AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
      })
    } catch (error) {
      throw new Error(`desktop-native: native operation failed: ${renderError(error)}`)
    }
    if (!response.ok) {
      throw new Error(`desktop-native: native operation failed with HTTP ${String(response.status)}`)
    }
    return response
  }
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Bound the complete native selection response, including its JSON envelope. */
async function readSelection(response: Response): Promise<string> {
  return readBody(response, 65_536, 'Profile selection')
}

async function readBody(response: Response, maxBytes: number, label: string): Promise<string> {
  if (response.body === null) throw new Error(`desktop-native: missing ${label} response`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error(`desktop-native: ${label} response exceeds byte limit`)
      chunks.push(chunk.value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export default NativeDesktopHost
