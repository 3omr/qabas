/** Antigravity CLI Service Provider for the LLM capability seam. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from './adapter.ts'
import { Config } from './config.ts'
import { installGoogleFallback } from './recovery.ts'

export { Config } from './config.ts'
export { AgyAdapter } from './adapter.ts'
export { installGoogleFallback } from './recovery.ts'

export const name = 'llm-agy'
export const inject = ['llm', 'subprocess']

/**
 * Mount a model-only agy route and its conditional Google fallback.
 * @param ctx - LLM registry and shared process owner.
 * @param config - validated model, effort and process limits.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = new AgyAdapter(ctx.subprocess, config)
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter(['agy'], adapter)
    return async () => { registration(); await adapter.dispose() }
  }, 'agy: model route and process cleanup')
  ctx.llm.registerModelDiscovery('llm-agy', async (_request, signal) => {
    const models = await adapter.listModels('agy', signal)
    if (!models.some(model => model.id === config.defaultModel)) {
      throw new LlmError(`Omar configured default model "${config.defaultModel}" is absent from agy models`, 'AGY_MODEL_UNAVAILABLE')
    }
    return models
  })
  installGoogleFallback(ctx, config.googleFallback)
}
