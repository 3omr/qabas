/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** One method a flow offers, as the page lists it. */
export interface AuthorizationMethodView {
  readonly id: string
  readonly label: string
}

/** One thing that can be signed into. */
export interface AuthorizationEntryView {
  /** The credential record, e.g. `llm-pi-ai/anthropic`. */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** Ways in, most preferred first. An `oauth` method is a subscription sign-in. */
  readonly methods: readonly AuthorizationMethodView[]
  /** An attempt is already running for this key, so a second `run` would refuse. */
  readonly inFlight: boolean
  /**
   * A credential for this key is stored.
   *
   * The seam does not carry this: it knows what can be authorized, not what
   * already is. A page listing routes needs both, because a route signed into
   * with no API key set is ready, and saying "setup needed" about it is the
   * one wrong answer a reader would act on.
   */
  readonly signedIn: boolean
}

/** One frame of a running attempt. */
export type AuthorizationFrame =
  /** Something to show: a message, and any page or code it refers to. */
  | { readonly type: 'notice'; readonly message: string; readonly url?: string; readonly code?: string }
  /** A question. The page must reply with `answer(key, id, value)`. */
  | {
    readonly type: 'prompt'
    readonly id: string
    readonly message: string
    /** `secret` must not echo: it carries a key or an authorization code. */
    readonly kind: 'text' | 'secret' | 'select'
    readonly placeholder?: string
    readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
  }
  /** How it ended. `authorized` means the credential is stored. */
  | { readonly type: 'settled'; readonly outcome: 'authorized' | 'cancelled' }

/** Result of one authenticated Gemini catalog check; never contains the credential or provider body. */
export type GeminiKeyCheck =
  | { readonly status: 'works' | 'invalid-key' | 'network' | 'no-key' }
  | { readonly status: 'quota'; readonly limit: 'daily' | 'per-minute' | 'unknown' }
