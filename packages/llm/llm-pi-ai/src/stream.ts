/**
 * pi-ai assistant event translation into the Harness streaming protocol.
 *
 * pi-ai tool-call arguments are parsed objects while the Harness keeps their
 * raw JSON representation. pi-ai also reports failures as terminal stream
 * events, which this module maps into Harness finish chunks.
 *
 * @module dsh-llm-pi-ai/stream
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE, TOOL_CALL_TRUNCATED_CODE } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isContextOverflow } from '@earendil-works/pi-ai'
import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'
import { quotaFacts } from './quota.ts'
import { toPiReplayState } from './replay.ts'

/**
 * Map pi-ai usage (reasoning folded into output by pi-ai).
 * @param usage - cumulative usage from the terminal pi-ai event.
 * @returns harness counts with pi-ai's exact total; cache fields appear only
 *   when non-zero (pi-ai reports zeros, not absence).
 */
export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

// XXX(pi-ai upstream): pi-ai flattens the caught error to `error.message`
// (api/anthropic-messages.js: `errorMessage = error instanceof Error ?
// error.message : JSON.stringify(error)`), discarding the original Error and its
// `cause` chain before it reaches us. undici carries the actionable transport
// detail on `cause` (e.g. `SocketError: other side closed`) but hands the fetch
// wrapper a bare `terminated`, so we are left pattern-matching terse words here.
// If pi-ai ever forwards the original Error (or a fetch/dispatcher hook that lets
// us capture the cause ourselves), classify on `code`/`cause` instead of text.
function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b404\b|\bmodel\b.{0,160}(?:no longer available|not found|does not exist)|\bmodels\/\S+.{0,160}(?:no longer available|not found)/iu.test(message)) return 'MODEL_UNAVAILABLE'
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  // A rejected request body (gateway or provider size cap): resending the
  // same request cannot succeed, so it is invalid, not transient.
  if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * Map a terminal pi-ai event to the harness finish reason.
 * @param message - the assistant message carried by the `done` or `error` event.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @returns the mapped harness reason. Recognized error text, `stop` usage above
 *   `contextWindow`, and zero-output `length` usage that fills the window map
 *   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
 *   `EMPTY_RESPONSE` error, while terminal `pending` and `deferred` states map
 *   to non-retryable `PI_AI_ERROR` failures. Tool-call `length` and parser EOF
 *   failures map to `TOOL_CALL_TRUNCATED`, requiring corrective input.
 */
export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const harnessOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || harnessOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  if (message.stopReason === 'length'
    || (message.stopReason === 'error' && incompleteJsonAtEnd(message.errorMessage))) {
    const calls = message.content.filter(block => block.type === 'toolCall')
    if (calls.length > 0) {
      return truncatedToolCallReason(calls.map(call => ({ name: call.name, chars: JSON.stringify(call.arguments).length })))
    }
    if (message.stopReason === 'error') {
      return {
        kind: 'error',
        failure: {
          code: TOOL_CALL_TRUNCATED_CODE,
          message: 'Response ended with incomplete JSON before the provider exposed a tool call; resend in smaller pieces.',
        },
      }
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending': return {
      kind: 'error',
      failure: { message: `pi-ai stream for model "${message.model}" ended pending`, code: 'PI_AI_ERROR' },
    }
    case 'deferred': return {
      kind: 'error',
      failure: { message: `pi-ai deferred response for model "${message.model}" is not supported`, code: 'PI_AI_ERROR' },
    }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      const quota = quotaFacts(text)
      const code = quota.daily ? 'DAILY_QUOTA_EXHAUSTED' : quota.minute ? 'RATE_LIMIT' : classifyPiAiError(text)
      return {
        kind: 'error',
        failure: {
          message: quota.daily
            ? `Daily quota exhausted for model "${message.model}". Wait until the daily quota resets or switch model.`
            : text,
          code,
          ...quota.retryAfterMs === undefined ? {} : { providerRetryAfterMs: quota.retryAfterMs },
        },
      }
    }
  }
}

/** Exact parser EOF diagnostics; a malformed complete JSON value is not truncation. */
function incompleteJsonAtEnd(message: string | undefined): boolean {
  return message === 'Incomplete JSON segment at the end'
    || message === 'Unexpected end of JSON input'
    || (message !== undefined && /^Unterminated string in JSON at position \d+(?: \(line \d+ column \d+\))?$/.test(message))
}

/** A parser position at the exact argument end identifies a missing JSON suffix. */
function argumentEndPosition(message: string | undefined, chars: number): boolean {
  if (message === undefined || !/^Expected\b/.test(message)) return false
  const position = /in JSON at position (\d+)/.exec(message)?.[1]
  return position !== undefined && Number(position) === chars
}

function incompleteArguments(raw: string): boolean {
  try {
    JSON.parse(raw)
    return false
  } catch (error: unknown) {
    return error instanceof SyntaxError
      && (incompleteJsonAtEnd(error.message) || argumentEndPosition(error.message, raw.length))
  }
}

function truncatedToolCallReason(calls: { name: string; chars: number }[]): FinishReason {
  return {
    kind: 'error',
    failure: {
      code: TOOL_CALL_TRUNCATED_CODE,
      message: 'Tool call truncated: '
        + calls.map(call => `"${call.name}" after ${call.chars} characters`).join(', ')
        + '; resend in smaller pieces.',
    },
  }
}

/**
 * Translate the pi-ai event stream into StreamChunks. pi-ai never throws
 * mid-stream — failures arrive as `error` events, which become error/aborted
 * `finish` chunks (the harness protocol's other error-delivery style).
 * @param events - one assistant turn's pi-ai event stream.
 * @param contextWindow - resolved catalog capacity for usage-based overflow detection.
 * @param callerSignal - caller cancellation state; an aborted caller makes any
 *   in-band terminal error an aborted finish.
 * @param requestedModel - request model identity for durable replay provenance.
 * @returns the harness chunks, ending with `usage` then `finish`; throws
 *   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event,
 *   except incomplete tool JSON, which finishes with `TOOL_CALL_TRUNCATED`.
 */
export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
  callerSignal?: AbortSignal,
  requestedModel?: string,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string; arguments: string }>()
  const terminalReason = (message: AssistantMessage): FinishReason => {
    if (callerSignal?.aborted) return mapStopReason({ ...message, stopReason: 'aborted' }, contextWindow)
    const mapped = mapStopReason(message, contextWindow)
    const argumentEof = message.stopReason === 'error'
      && [...toolIds.values()].some(call => argumentEndPosition(message.errorMessage, call.arguments.length)
        && incompleteArguments(call.arguments))
    if (mapped.kind === 'error' && mapped.failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return mapped
    if (toolIds.size > 0 && (mapped.kind === 'max-tokens'
      || (mapped.kind === 'error' && mapped.failure.code === TOOL_CALL_TRUNCATED_CODE) || argumentEof)) {
      return truncatedToolCallReason([...toolIds.values()].map(call => ({ name: call.name, chars: call.arguments.length })))
    }
    return mapped
  }
  const emptyCallDeltas = (): StreamChunk[] => [...toolIds.entries()]
    .filter(([, call]) => call.arguments.length === 0)
    .map(([index, call]) => ({
      type: 'tool-call-delta', index, id: brandString<ToolCallId>(call.id), name: call.name, argumentsDelta: '',
    }))

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name, arguments: '' })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        if (known !== undefined) {
          const partial = event.partial.content[event.contentIndex]
          if (partial?.type === 'toolCall') {
            known.id = partial.id
            known.name = partial.name
          }
          known.arguments += event.delta
        }
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: brandString<ToolCallId>(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: brandString<ToolCallId>(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the harness vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done': {
        const reason = terminalReason(event.message)
        if (reason.kind === 'error' && reason.failure.code === TOOL_CALL_TRUNCATED_CODE) yield* emptyCallDeltas()
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason,
          ...reason.kind === 'error' ? {} : { replayState: toPiReplayState(event.message, requestedModel) },
        }
        return
      }
      case 'error': {
        const reason = terminalReason(event.error)
        if (reason.kind === 'error' && reason.failure.code === TOOL_CALL_TRUNCATED_CODE) yield* emptyCallDeltas()
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the harness's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield {
          type: 'finish',
          reason,
        }
        return
      }
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  const incomplete = [...toolIds.values()].filter(call => incompleteArguments(call.arguments))
  if (!callerSignal?.aborted && incomplete.length > 0) {
    yield* emptyCallDeltas()
    yield { type: 'finish', reason: truncatedToolCallReason(incomplete.map(call => ({ name: call.name, chars: call.arguments.length }))) }
    return
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
