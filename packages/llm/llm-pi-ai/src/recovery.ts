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
import type { ModelFallbackEventData } from './recovery-types.ts'

interface RecoveryState {
  turn: number
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
  const states = new WeakMap<Session, RecoveryState>()
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => active.delete(tracked))
    active.add(tracked)
    return tracked
  }

  async function fallbackAllowed(agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<boolean> {
    if (agent.options.allowModelFallback === false) return false
    const allowed = await agentEvents(ctx, agent).waterfall('agent/model-fallback-allowed', { turn, step }, () => Promise.resolve(true))
    signal.throwIfAborted()
    return allowed
  }

  function stateFor(agent: Agent, turn: number, config: LlmCallConfig): RecoveryState {
    const previous = states.get(agent.session)
    if (previous?.turn === turn && previous.provider === config.provider
      && (previous.original === config.model || previous.model === config.model)) return previous
    const state: RecoveryState = { turn, provider: config.provider, original: config.model, model: config.model }
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
    const target = eligible.find(model => !recoveryMemory.isExhausted(config.provider, model.id, timeZone))
    if (target === undefined) {
      const exhausted = [...new Set([config.model, ...eligible.map(model => model.id)])]
      throw new LlmError(`Daily quota exhausted for provider "${config.provider}" models: ${exhausted.join(', ')}. Wait until the provider's daily reset.`, 'DAILY_QUOTA_EXHAUSTED')
    }
    const route = (model: LlmModelInfo): ModelFallbackEventData['from'] => ({ provider: config.provider, model: model.id, name: model.name })
    const from = catalog.find(model => model.id === config.model)
    const data: ModelFallbackEventData = {
      turn, step,
      from: from === undefined ? { provider: config.provider, model: config.model, name: config.model } : route(from),
      to: route(target),
      reason: 'DAILY_QUOTA_EXHAUSTED',
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
    const profile = profiles().get(config.provider)
    if (profile === undefined) return config
    let state = stateFor(agent, turn, config)
    const selected = { ...config, model: state.model }
    if (profile.dailyQuotaFallback && profile.dailyQuotaResetTimeZone !== undefined
      && recoveryMemory.isExhausted(config.provider, state.model, profile.dailyQuotaResetTimeZone)
      && await fallbackAllowed(agent, turn, step, signal)) {
      state = await switchModel(agent, turn, step, selected, signal)
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
    if (failure.code === 'DAILY_QUOTA_EXHAUSTED') {
      if (profile.dailyQuotaResetTimeZone !== undefined) {
        recoveryMemory.exhaust(provider, config.model, profile.dailyQuotaResetTimeZone)
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
    lifetime.abort(new Error('pi-ai recovery disposed'))
    await Promise.allSettled([...active])
  }, 'pi-ai: drain model recovery')
}
