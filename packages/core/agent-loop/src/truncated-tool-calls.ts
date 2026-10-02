/** Durable failed calls and corrective feedback for output truncation. */

import { createToolResultMessage, createUserMessage, LlmError, TOOL_CALL_TRUNCATED_CODE } from '@deepseek-ai/dsh-llm'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Record calls without dispatch and stop after the second consecutive truncation of one tool in a turn.
 * @param session - durable conversation receiving the failed calls.
 * @param position - turn and step owning the response.
 * @param calls - raw calls from the failed stream.
 * @param consecutive - turn-local truncation counts, reset when that tool completes a normal step.
 */
export function recordTruncatedToolCalls(
  session: Session,
  position: { turn: number; step: number },
  calls: ToolCallBlock[],
  consecutive: Map<string | null, number>,
): void {
  let exhausted: ToolCallBlock | undefined
  const counted = new Set<string>()
  for (const call of calls) {
    if (!counted.has(call.name)) {
      counted.add(call.name)
      const count = (consecutive.get(call.name) ?? 0) + 1
      consecutive.set(call.name, count)
      if (count >= 2) exhausted = call
    }
    const callEvent = session.append('tool/call', {
      ...position, callId: call.id, name: call.name, arguments: call.arguments,
    })
    session.append('llm/tool-call-truncated', { ...position, tool: call.name, chars: call.arguments.length })
    session.append('tool/result', {
      ...position,
      message: createToolResultMessage({
        callId: call.id,
        isError: true,
        content: [{ type: 'text', text: `Tool call "${call.name}" was cut off at the output limit or stream end after ${call.arguments.length} characters; re-send it in smaller pieces, splitting content across more parts.` }],
      }),
      error: { name: 'LlmError', code: TOOL_CALL_TRUNCATED_CODE },
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
  }
  if (exhausted !== undefined) {
    throw new LlmError(`Tool "${exhausted.name}" was truncated in 2 consecutive responses in this turn after ${exhausted.arguments.length} characters; reduce each part before continuing.`, TOOL_CALL_TRUNCATED_CODE)
  }
}

/**
 * Correct an SDK-buffered JSON failure without inventing a tool identity or arguments.
 * @param session - durable conversation receiving the corrective instruction.
 * @param position - turn and step owning the failed attempt.
 * @param consecutive - turn-local counts; null tracks responses with no exposed call.
 */
export function recordUnexposedTruncation(
  session: Session,
  position: { turn: number; step: number },
  consecutive: Map<string | null, number>,
): void {
  const count = (consecutive.get(null) ?? 0) + 1
  consecutive.set(null, count)
  session.append('llm/tool-call-truncated', { ...position, tool: null, chars: null })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Your response was cut off mid-JSON before a tool call could be read; re-send the call in smaller pieces, splitting content across more parts.' }],
    source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-agent-loop' },
  }), { surfaceOp: 'append' })
  if (count >= 2) throw new LlmError('Response JSON was truncated twice in this turn before any tool identity or argument size was available; reduce each part before continuing.', TOOL_CALL_TRUNCATED_CODE)
}
