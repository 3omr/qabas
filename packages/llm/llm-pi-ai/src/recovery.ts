/** Same-step pi-ai recovery through Agent request waterfalls; no loop mutation. */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { PiAiAdapter } from './adapter.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { fallbackModels, recoveryMemory } from './recovery-memory.ts'
import { RecoveryStore } from './recovery-store.ts'
import type { ModelFallbackEventData } from './recovery-types.ts'
import { requestPacer } from './pacer.ts'
import type {} from '@deepseek-ai/dsh-credentials'

interface RecoveryState {
  turn: number
  quotaRevision: number
  original: string
  provider: string
  model: string
  thinking?: { step: number; from: string; to: ModelThinkingLevel }
}

/**
 * Install daily quota switches and one thinking correction per model/step.
 * Explicit AgentOptions.allowModelFallback=false or a turn-pinned selection forbids switching.
 * @param ctx - adapter plugin context owning all registrations and pending catalog reads.
 * @param adapter - adapter whose configured catalogs define eligible models.
 * @param profiles - current validated route profiles.
 */
export function installRequestRecovery(
  ctx: Context,
  adapter: PiAiAdapter,
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): void {
  const store = new RecoveryStore(recoveryMemory)
  const states = new WeakMap<Session, RecoveryState>()
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  const disposeCredentialReset = ctx.on('credentials/reference-reset', ref => track((async () => {
    const routes = profiles()
    const providers = new Set([...routes].filter(([, profile]) => profile.apiKeyEnv === ref).map(([provider]) => provider))
    // The Settings card provisions google: {} using pi-ai's native GEMINI_API_KEY lookup.
    if (ref === 'GEMINI_API_KEY' && routes.get('google')?.apiKeyEnv === undefined) providers.add('google')
    for (const provider of providers) {
      await store.clearQuota(provider, ctx.get('storageDomain'))
      requestPacer.clearQuota(provider)
    }
  })()))

  async function fallbackAllowed(agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<boolean> {
    if (agent.options.allowModelFallback === false) return false
    const allowed = await agentEvents(ctx, agent).waterfall('agent/model-fallback-allowed', { turn, step }, () => Promise.resolve(true))
    signal.throwIfAborted()
    return allowed
  }

  function stateFor(agent: Agent, turn: number, config: LlmCallConfig): RecoveryState {
    const previous = states.get(agent.session)
    if (previous?.turn === turn && previous.provider === config.provider
      && previous.quotaRevision === recoveryMemory.quotaRevision(config.provider)
      && (previous.original === config.model || previous.model === config.model)) return previous
    const state: RecoveryState = {
      turn, quotaRevision: recoveryMemory.quotaRevision(config.provider),
      provider: config.provider, original: config.model, model: config.model,
    }
    states.set(agent.session, state)
    return state
  }

  async function switchModel(
    agent: Agent, turn: number, step: number, config: LlmCallConfig, signal: AbortSignal,
  ): Promise<RecoveryState> {
    const profile = profiles().get(config.provider)
    // Callers establish an enabled profile with a validated reset zone.
    if (profile?.dailyQuotaResetTimeZone === undefined) throw new Error('pi-ai recovery requires a reset zone')
    const timeZone = profile.dailyQuotaResetTimeZone
    const catalog = await adapter.listModels(config.provider)
    signal.throwIfAborted()
    const eligible = fallbackModels(catalog)
    const target = eligible.find(model => !recoveryMemory.isExcluded(config.provider, model.id, timeZone))
    if (target === undefined) {
      const excluded = [...new Set([config.model, ...eligible.map(model => model.id)])]
      const hasDaily = excluded.some(model => recoveryMemory.isExhausted(config.provider, model, timeZone))
      throw new LlmError(`No eligible model available for provider "${config.provider}". Exhausted or unavailable models: ${excluded.join(', ')}.`
        + (hasDaily ? " Wait until the provider's daily reset." : ''), hasDaily ? 'DAILY_QUOTA_EXHAUSTED' : 'MODEL_UNAVAILABLE')
    }
    const route = (model: LlmModelInfo): ModelFallbackEventData['from'] => ({ provider: config.provider, model: model.id, name: model.name })
    const from = catalog.find(model => model.id === config.model)
    const data: ModelFallbackEventData = {
      turn, step,
      from: from === undefined ? { provider: config.provider, model: config.model, name: config.model } : route(from),
      to: route(target),
      reason: recoveryMemory.observation(config.provider, config.model)?.kind === 'unavailable'
        ? 'MODEL_UNAVAILABLE' : 'DAILY_QUOTA_EXHAUSTED',
    }
    agent.session.append('llm/model-fallback', data)
    const state = stateFor(agent, turn, config)
    state.model = target.id
    delete state.thinking
    return state
  }

  const disposeRequest = ctx.on('agent/request', (payload, next) => track((async () => {
    const config = await next()
    const { agent, turn, step } = payload
    const signal = AbortSignal.any([payload.signal, lifetime.signal])
    signal.throwIfAborted()
    await store.ready(ctx.get('storageDomain'))
    signal.throwIfAborted()
    const profile = profiles().get(config.provider)
    if (profile === undefined) return config
    let state = stateFor(agent, turn, config)
    const selected = { ...config, model: state.model }
    const unavailable = recoveryMemory.observation(config.provider, state.model)?.kind === 'unavailable'
    const excluded = profile.dailyQuotaResetTimeZone !== undefined
      && recoveryMemory.isExcluded(config.provider, state.model, profile.dailyQuotaResetTimeZone)
    if (unavailable || excluded) {
      const allowed = profile.dailyQuotaFallback && await fallbackAllowed(agent, turn, step, signal)
      if (allowed) {
        state = await switchModel(agent, turn, step, selected, signal)
      } else if (unavailable) {
        throw new LlmError(`Model "${config.provider}/${state.model}" is unavailable; select another model.`, 'MODEL_UNAVAILABLE')
      }
    }
    const { reasoningEffort: _previousEffort, ...withoutEffort } = config
    const switched = state.model !== config.model
    const correction = state.thinking?.step === step ? state.thinking.to
      : recoveryMemory.correctedThinking(config.provider, state.model, switched ? undefined : config.reasoningEffort)
    if (correction !== undefined) return { ...withoutEffort, model: state.model, reasoningEffort: ReasoningEffortId(correction) }
    // Effort belongs to the previous exact model; the replacement resolves its own default.
    return switched ? { ...withoutEffort, model: state.model } : config
  })()), { prepend: true })

  const disposeError = ctx.on('agent/request-error', (payload, next): Promise<RequestErrorAction> => track((async () => {
    const { agent, turn, step, provider, failure } = payload
    const signal = AbortSignal.any([payload.signal, lifetime.signal])
    signal.throwIfAborted()
    const config = agent.session.requestHeader()?.config
    const profile = profiles().get(provider)
    if (config === undefined || profile === undefined) return next()
    if (failure.code === 'DAILY_QUOTA_EXHAUSTED' || failure.code === 'MODEL_UNAVAILABLE') {
      await store.ready(ctx.get('storageDomain'))
      signal.throwIfAborted()
      if (failure.code === 'DAILY_QUOTA_EXHAUSTED'
        && states.get(agent.session)?.quotaRevision !== recoveryMemory.quotaRevision(provider)) return next()
      if (failure.code === 'MODEL_UNAVAILABLE') {
        await store.remember({ kind: 'unavailable', provider, model: config.model })
      }
      if (failure.code === 'DAILY_QUOTA_EXHAUSTED' && profile.dailyQuotaResetTimeZone !== undefined) {
        await store.remember(recoveryMemory.exhaust(provider, config.model, profile.dailyQuotaResetTimeZone))
      }
      if (!profile.dailyQuotaFallback || !await fallbackAllowed(agent, turn, step, signal)) return next()
      await switchModel(agent, turn, step, config, signal)
      return { kind: 'retry' }
    }
    if (failure.code !== 'INVALID_REQUEST'
      || !/\b400\b/u.test(failure.message)
      || !/thinking[\s_-]*level.{0,100}(?:not supported|unsupported)/iu.test(failure.message)) return next()
    const state = stateFor(agent, turn, config)
    if (state.thinking?.step === step) return next()
    const info = await adapter.resolveModel(provider, config.model, signal)
    signal.throwIfAborted()
    const from = /thinking[\s_-]*level\s+["']?(minimal|low|medium|high)/iu.exec(failure.message)?.[1]?.toLowerCase()
      ?? String(config.reasoningEffort ?? 'minimal')
    const levels = ['minimal', 'low', 'medium', 'high'] as const
    const to = levels.slice(Math.max(0, levels.findIndex(level => level === from) + 1))
      .find(level => info.reasoning?.efforts.some(effort => effort.id === level))
      ?? (info.reasoning?.efforts.some(effort => effort.id === 'off') ? 'off' : undefined)
    if (to === undefined) return next()
    agent.session.append('llm/thinking-fallback', {
      turn, step, provider, model: config.model, from, to, reason: 'UNSUPPORTED_THINKING_LEVEL',
    })
    state.thinking = { step, from, to }
    return { kind: 'retry' }
  })()), { prepend: true })

  const disposeEvents = ctx.on('session/event', (session, event) => {
    const type: string = event.type
    if (type === 'model/selection' || type === 'turn/end') {
      states.delete(session)
      return
    }
    const state = states.get(session)
    if (event.type !== 'assistant/message' || state?.thinking === undefined) return
    const source = event.data.message.source
    if (event.data.interrupted !== true && event.data.step === state.thinking.step
      && source.provider === state.provider && source.model === state.model) {
      recoveryMemory.learnThinking(state.provider, state.model, state.thinking.from, state.thinking.to)
    }
  })
  ctx.effect(() => async () => {
    disposeRequest()
    disposeError()
    disposeEvents()
    disposeCredentialReset()
    lifetime.abort(new Error('pi-ai recovery disposed'))
    await Promise.allSettled([...active])
    await store.close()
  }, 'pi-ai: drain model recovery')
}
