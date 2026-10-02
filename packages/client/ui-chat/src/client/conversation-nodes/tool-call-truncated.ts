/** Durable tool-call truncation notice for the Chat timeline. */

import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Tool and raw argument size reached before truncation. */
    'tool-call-truncated': SessionEventMap['llm/tool-call-truncated']
  }
}

interface TruncatedToolCallState {
  seq: number
  data: SessionEventMap['llm/tool-call-truncated']
}

/** One independent localized notice per failed tool call. */
export const toolCallTruncatedDefinition: ConversationNodeDefinition<TruncatedToolCallState> = {
  kind: 'tool-call-truncated',
  target: 'chat',
  match: event => event.type === 'llm/tool-call-truncated' ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => {
    if (match.event.type !== 'llm/tool-call-truncated') throw new Error('tool-call-truncated requires llm/tool-call-truncated')
    return { seq: match.event.seq, data: match.event.data }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'tool-call-truncated', context.state.seq, context.state.data),
}

/**
 * Register the truncation timeline contribution owned by this plugin fiber.
 * @param ctx - UI Conversation context.
 */
export function registerToolCallTruncatedConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(toolCallTruncatedDefinition)
}
