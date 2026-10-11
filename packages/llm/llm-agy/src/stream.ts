/** Decode documented agy NDJSON and expose only schema answer text, never tool JSON. */
import { parse, PartialJSON, MalformedJSON } from 'partial-json'
import { z } from 'zod'
import { agyFailure } from './response.ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

const eventSchema = z.object({
  event: z.string(),
  step_update: z.object({
    step_type: z.string(), step_index: z.number().optional(), tool_name: z.string().optional(), text_delta: z.string().optional(),
  }).loose().optional(),
  result: z.unknown().optional(),
}).loose()
const failureSchema = z.object({ status: z.literal('ERROR'), errors: z.unknown().optional(), error: z.unknown().optional() })
const textSchema = z.object({ text: z.string() })

/** Per-request NDJSON decoder with terminal output and monotonic provisional text. */
export class AgyStream {
  private pending = ''
  private response = ''
  private step: number | undefined
  private terminal: string | undefined
  private bytes = 0
  /** Answer text already published; the validated result must extend it. */
  text = ''

  /**
   * Accept decoded UTF-8 stdout and emit provisional answer text.
   * @param data - next stdout fragment.
   * @param maxBytes - configured bound on the complete stdout, including metadata.
   * @param emit - callback for decoded answer text only.
   */
  feed(data: string, maxBytes: number, emit: (text: string) => void): void {
    this.bytes += Buffer.byteLength(data)
    if (this.bytes > maxBytes) throw new LlmError('Omar response exceeds maxOutputBytes', 'AGY_INVALID_RESPONSE')
    this.pending += data
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end)
      this.pending = this.pending.slice(end + 1)
      if (line.trim() !== '') this.line(line, emit)
    }
  }

  /**
   * Require exactly one complete terminal result after stdout ends.
   * @returns JSON envelope accepted by the shared response validator.
   */
  finish(): string {
    if (this.pending.trim() !== '') this.line(this.pending, () => {})
    this.pending = ''
    if (this.terminal === undefined) throw new LlmError('Omar stream ended without a result', 'AGY_INVALID_RESPONSE')
    return this.terminal
  }

  private line(line: string, emit: (text: string) => void): void {
    const event = eventSchema.parse(JSON.parse(line) as unknown)
    if (this.terminal !== undefined) throw new LlmError('Omar emitted data after its result', 'AGY_INVALID_RESPONSE')
    if (event.event === 'result') {
      if (event.result === undefined) throw new LlmError('Omar result is missing', 'AGY_INVALID_RESPONSE')
      const failure = failureSchema.safeParse(event.result)
      if (failure.success) throw agyFailure(JSON.stringify(failure.data.errors ?? failure.data.error ?? event.result))
      this.terminal = JSON.stringify(event.result)
    } else if (event.event === 'step_update' && event.step_update !== undefined) {
      const update = event.step_update
      // agy ends every schema answer through its own `finish` tool; any other internal tool is a protocol violation.
      if (update.step_type === 'tool' && update.tool_name !== 'finish') throw new LlmError('Omar used an internal tool', 'AGY_INVALID_RESPONSE')
      if (update.step_type === 'agent_response') {
        // A later model turn restates the answer; parse each turn's deltas on their own.
        if (update.step_index !== undefined && update.step_index !== this.step) {
          this.step = update.step_index
          this.response = ''
        }
        this.delta(update.text_delta ?? '', emit)
      }
    }
    // Other CLI metadata events do not contribute answer text.
  }

  private delta(delta: string, emit: (text: string) => void): void {
    this.response += delta
    let partial: unknown
    try {
      partial = parse(this.response)
    } catch (error: unknown) {
      // CLI schema enforcement applies only to the result; non-schema prose is withheld.
      if (error instanceof PartialJSON || error instanceof MalformedJSON) return
      throw error
    }
    const candidate = textSchema.safeParse(partial)
    if (!candidate.success || !candidate.data.text.startsWith(this.text)) return
    if (/^\s*(?:```|\{)/u.test(candidate.data.text)) return
    let text = candidate.data.text
    // Do not publish a high surrogate before a following delta supplies its pair.
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1)
    const added = text.slice(this.text.length)
    this.text = text
    if (added !== '') emit(added)
  }
}
