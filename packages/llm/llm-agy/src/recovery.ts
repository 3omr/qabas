/** Cross-provider recovery using the Agent model-fallback policy and durable notice. */
import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm-pi-ai/recovery-types'

/**
 * Retry an unavailable agy turn once on a configured Google route with a saved key.
 * @param ctx - adapter fiber owning the waterfalls and turn-local selections.
 * @param enabled - deployment permission for cross-provider fallback.
 */
export function installGoogleFallback(ctx: Context, enabled: boolean): void {
  if (!enabled) return
  const states = new WeakMap<Session, { turn: number; config: LlmCallConfig }>()
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const config = await next()
    const fallback = states.get(agent.session)
    return fallback?.turn === turn ? fallback.config : config
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    if (provider !== 'agy' || (failure.code !== 'AGY_NOT_INSTALLED' && failure.code !== 'AGY_NOT_SIGNED_IN' && failure.code !== 'AGY_QUOTA')
      || states.get(agent.session)?.turn === turn || agent.options.allowModelFallback === false) return next()
    const allowed = await agentEvents(ctx, agent).waterfall('agent/model-fallback-allowed', { turn, step }, () => Promise.resolve(true))
    signal.throwIfAborted()
    if (!allowed || !ctx.llm.listProviders().some(route => route.id === 'google')) return next()
    const credentials = ctx.get('credentials')
    if (credentials === undefined || (await credentials.resolve(credentialRef('GEMINI_API_KEY')))?.value === undefined) return next()
    const models = await ctx.llm.listModels('google')
    signal.throwIfAborted()
    const target = models.find(model => /gemini.*flash/iu.test(model.id) && !/preview|lite|image|audio|tts/iu.test(model.id))
    if (target === undefined) return next()
    const current = agent.session.requestHeader()?.config
    if (current === undefined) return next()
    agent.session.append('llm/model-fallback', {
      turn, step, from: { provider: 'agy', model: current.model, name: 'Omar' },
      to: { provider: 'google', model: target.id, name: target.name }, reason: failure.code,
    })
    const { reasoningEffort: _effort, maxTokens: _outputLimit, ...sampling } = current
    states.set(agent.session, { turn, config: { ...sampling, provider: 'google', model: target.id } })
    return { kind: 'retry' }
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    const type: string = event.type
    if (type === 'turn/end' || type === 'model/selection') states.delete(session)
  })
}
