/** Durable same-step model-switch notice for the Chat timeline. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ModelFallbackEventData } from '@deepseek-ai/dsh-llm-pi-ai/recovery-types'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Daily-quota replacement route and its exhausted predecessor. */
    'model-fallback': ModelFallbackEventData
  }
}

interface ModelFallbackState {
  seq: number
  data: ModelFallbackEventData
}

/** One independent visible line for each committed quota switch. */
export const modelFallbackDefinition: ConversationNodeDefinition<ModelFallbackState> = {
  kind: 'model-fallback',
  target: 'chat',
  match: event => event.type === 'llm/model-fallback' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'llm/model-fallback') throw new Error('model-fallback requires llm/model-fallback')
    return { seq: match.event.seq, data: match.event.data }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'model-fallback', context.state.seq, context.state.data),
}

/**
 * Register the model-switch timeline contribution owned by this plugin fiber.
 * @param ctx - UI Conversation context.
 */
export function registerModelFallbackConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(modelFallbackDefinition)
}
