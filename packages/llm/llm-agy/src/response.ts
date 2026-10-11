/** Validation of Antigravity's process JSON before any content is published. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'

const answerSchema = z.object({
  text: z.string(),
  tool_calls: z.array(z.object({ name: z.string(), arguments_json: z.string() })),
}).strict()
const envelopeSchema = z.object({
  status: z.string().optional(),
  errors: z.unknown().optional(),
  error: z.unknown().optional(),
  structured_output: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  }).loose().optional(),
}).loose()

/** JSON schema handed to the CLI; tool arguments remain raw JSON strings. */
export const responseSchema = z.toJSONSchema(answerSchema)

/**
 * Classify CLI diagnostics into stable retry and student-action codes.
 * @param detail - process or in-band error diagnostic.
 * @returns adapter failure whose transient codes use the shared retry policy.
 */
export function agyFailure(detail: string): LlmError {
  const code = /not[- ]signed[- ]in|sign in|log.?in|unauthenticated|authentication required/iu.test(detail) ? 'AGY_NOT_SIGNED_IN'
    : /quota|resource.?exhausted|usage limit/iu.test(detail) ? 'AGY_QUOTA'
      : /connection reset|eligibility check failed|network|ECONNRESET|socket|connection refused/iu.test(detail) ? 'TRANSPORT'
        : 'AGY_FAILED'
  return new LlmError(`Omar: ${detail}`, code)
}

/**
 * Validate complete CLI output and all tool calls before publishing blocks.
 * @param output - collected stdout.
 * @param request - tools offered to this model request.
 * @returns validated answer and optional token accounting.
 */
export function parseResponse(
  output: string, request: GenerateOptions,
): { answer: z.infer<typeof answerSchema>; usage: TokenUsage | undefined } {
  const envelope = envelopeSchema.parse(JSON.parse(output) as unknown)
  if (envelope.status === 'ERROR') throw agyFailure(JSON.stringify(envelope.errors ?? envelope.error ?? envelope))
  let candidate = envelope.structured_output
  const text = z.object({ text: z.string() }).safeParse(candidate)
  if (text.success) {
    const nested = text.data.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    let decoded: unknown
    try {
      decoded = JSON.parse(nested)
    } catch (_ordinaryAnswerText) {
      // Plain answer text is not another schema response.
    }
    const unwrapped = answerSchema.safeParse(decoded)
    if (unwrapped.success) candidate = unwrapped.data
  }
  const answer = answerSchema.parse(candidate)
  const tools = new Set(request.tools?.map(tool => tool.name))
  for (const call of answer.tool_calls) {
    if (!tools.has(call.name)) throw new LlmError(`Omar requested unknown tool "${call.name}"`, 'AGY_INVALID_TOOL_CALL')
    let arguments_: unknown
    try {
      arguments_ = JSON.parse(call.arguments_json)
    } catch {
      throw new LlmError(`Omar tool "${call.name}" arguments_json is not valid JSON`, 'AGY_INVALID_TOOL_CALL')
    }
    if (typeof arguments_ !== 'object' || arguments_ === null || Array.isArray(arguments_)) {
      throw new LlmError(`Omar tool "${call.name}" arguments_json must encode an object`, 'AGY_INVALID_TOOL_CALL')
    }
  }
  const usage = envelope.usage
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens
  return { answer, usage: inputTokens === undefined || outputTokens === undefined ? undefined : {
    inputTokens, outputTokens, totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  } }
}
