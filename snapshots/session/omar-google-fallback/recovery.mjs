/** Replay exercises the shipping recovery hook with recorded model outcomes. */
import { installGoogleFallback } from '@deepseek-ai/dsh-llm-agy'
export const name = 'omar-snapshot-recovery'
export const inject = ['llm']
export function apply(ctx) { installGoogleFallback(ctx, true) }
