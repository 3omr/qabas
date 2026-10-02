/** Durable pi-ai request recovery records; safe for browser type imports. */

/** Provider route and catalog model recorded at a recovery transition. */
export interface RecoveryModel {
  provider: string
  model: string
  name: string
}

/** Same-step switch after a model exhausts its daily quota or becomes unavailable. */
export interface ModelFallbackEventData {
  turn: number
  step: number
  from: RecoveryModel
  to: RecoveryModel
  reason: 'DAILY_QUOTA_EXHAUSTED' | 'MODEL_UNAVAILABLE'
}

/** One same-step correction of a provider-rejected thinking level. */
export interface ThinkingFallbackEventData {
  turn: number
  step: number
  provider: string
  model: string
  from: string
  to: string
  reason: 'UNSUPPORTED_THINKING_LEVEL'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable route change before retrying the same admitted step. */
    'llm/model-fallback': ModelFallbackEventData
    /** Durable reasoning correction before retrying the same admitted step. */
    'llm/thinking-fallback': ThinkingFallbackEventData
  }
}
