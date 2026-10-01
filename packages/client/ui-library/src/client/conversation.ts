/** Session-addressed Conversation actions for library jobs and visible chats. */
import type { Context } from '@deepseek-ai/cordis'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Resolve the Conversation service through the target Session's context.
 * @param ctx - library plugin context with injected Sessions and Conversation.
 * @param sessionId - target Session identity, independent of selection.
 * @returns Conversation actions rebound to the target Session.
 * @throws when the Session scope or active Conversation provider is unavailable.
 */
export function requireConversation(ctx: Context, sessionId: SessionId): IConversation {
  const scoped = ctx.sessions.scope(sessionId)
  if (scoped === undefined) throw new Error(`ui-library: session "${sessionId}" resolved no scope`)
  // Session scopes belong to the controller fiber, whose inject list does not
  // include Conversation. get() preserves the scope tag without requiring that edge.
  const conversation = scoped.get('conversation')
  if (conversation === undefined) throw new Error('ui-library: conversation service unavailable')
  return conversation
}
