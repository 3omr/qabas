/** Antigravity as a model; Qabas retains tool execution and session ownership. */
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { renderPrompt } from './prompt.ts'
import { AgyStream } from './stream.ts'
import { agyFailure, parseResponse, responseSchema } from './response.ts'

/** Model-only CLI adapter backed exclusively by the shared subprocess owner. */
export class AgyAdapter extends LlmAdapter {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<string>>()
  constructor(private readonly subprocess: SubprocessRuntime, readonly config: Config) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'Omar' } }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text' as const],
      reasoning: { efforts: [{ id: ReasoningEffortId(this.config.effort), name: this.config.effort }],
        defaultEffort: ReasoningEffortId(this.config.effort) } })
  }

  /**
   * Read the CLI catalog in an isolated directory.
   * @param provider - registered agy route.
   * @param signal - cancellation during executable lookup or catalog collection.
   * @returns models parsed from tab-separated ids and labels, preferred model first.
   */
  override async listModels(provider: string, signal?: AbortSignal): Promise<readonly LlmModelInfo[]> {
    const output = await this.run(['models'], signal)
    const models = output.trim().split(/\r?\n/u).map((line) => {
      const [id, label] = line.split('\t')
      if (id === undefined || id.trim() === '' || label === undefined || label.trim() === '') {
        throw new LlmError('Omar: agy models must contain tab-separated id and label', 'AGY_INVALID_RESPONSE')
      }
      return { provider, id: id.trim(), name: label.trim(), inputModalities: ['text' as const] }
    })
    return models.sort((left, right) => Number(right.id === this.config.defaultModel) - Number(left.id === this.config.defaultModel))
  }

  /**
   * Stream provisional answer text; validate the result before publishing Qabas calls.
   * @param request - logged model request and live cancellation signal.
   * @returns chunks ending in exactly one success, failure or cancellation finish.
   */
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const resolved = this.resolve(request)
    const cancellation = new AbortController()
    const signal = AbortSignal.any([cancellation.signal, ...request.signal === undefined ? [] : [request.signal]])
    const deltas = new PassThrough()
    deltas.setEncoding('utf8')
    const decoder = new AgyStream()
    const operation = this.run([
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--effort', resolved.reasoningEffort,
      '--model', request.model, '--sandbox', '--disable-slash-commands',
    ], signal, renderPrompt(request), (data) => {
      decoder.feed(data, this.config.maxOutputBytes, (text) => { deltas.write(text) })
    })
    // Drain queued text even on failure; the loop persists a failed provisional stream as an attempt.
    void operation.then(() => { deltas.end() }, () => { deltas.end() })
    try {
      let opened = false
      for await (const data of deltas) {
        if (!opened) { yield { type: 'block-start', index: 0, blockType: 'text' }; opened = true }
        yield { type: 'text-delta', index: 0, text: String(data) }
      }
      await operation
      const { answer, usage } = parseResponse(decoder.finish(), request)
      if (!answer.text.startsWith(decoder.text)) throw new LlmError('Omar streamed text differs from its result', 'AGY_INVALID_RESPONSE')
      let index = 0
      if (answer.text !== '') {
        if (!opened) yield { type: 'block-start', index, blockType: 'text' }
        const remaining = answer.text.slice(decoder.text.length)
        if (remaining !== '') yield { type: 'text-delta', index, text: remaining }
        yield { type: 'block-end', index: index++, block: { type: 'text', text: answer.text } }
      }
      for (const call of answer.tool_calls) {
        const id = ToolCallId(randomUUID())
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments_json }
        yield { type: 'block-end', index: index++, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments_json } }
      }
      if (index === 0) throw new LlmError('Omar returned no text or tool calls', 'EMPTY_RESPONSE')
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: answer.tool_calls.length > 0 ? 'tool-calls' : 'stop' } }
    } catch (error: unknown) {
      const cancelled = request.signal?.aborted === true || this.lifetime.signal.aborted
      const failure = { code: cancelled ? 'ABORTED' : error instanceof LlmError ? error.code : 'AGY_INVALID_RESPONSE',
        message: error instanceof Error ? error.message : String(error) }
      yield { type: 'finish', reason: { kind: cancelled ? 'aborted' : 'error', failure } }
    } finally {
      cancellation.abort()
      deltas.destroy()
      await Promise.allSettled([operation])
    }
  }

  /**
   * Stop new calls, cancel active process trees and await their cleanup.
   * @returns fulfillment after every owned request reaches quiescence.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Omar adapter disposed'))
    await Promise.allSettled([...this.active])
  }

  private resolve(request: GenerateOptions): GenerateOptions & { reasoningEffort: ReasoningEffortId } {
    return { ...request, reasoningEffort: request.reasoningEffort ?? ReasoningEffortId(this.config.effort) }
  }

  private run(args: string[], signal?: AbortSignal, prompt?: string, onData?: (data: string) => void): Promise<string> {
    const operation = this.execute(args, signal, prompt, onData)
    const tracked = operation.finally(() => { this.active.delete(tracked) })
    this.active.add(tracked)
    return tracked
  }

  private async execute(args: string[], signal?: AbortSignal, prompt?: string, onData?: (data: string) => void): Promise<string> {
    const deadline = new AbortController()
    const timer = setTimeout(() => { deadline.abort(new Error('Omar request timed out')) }, this.config.timeoutMs)
    const combined = AbortSignal.any([this.lifetime.signal, deadline.signal, ...signal === undefined ? [] : [signal]])
    let directory: string | undefined
    try {
      let executable: string
      try {
        executable = await this.subprocess.resolveExecutable(this.config.executable, undefined, combined)
      } catch (error: unknown) {
        combined.throwIfAborted()
        throw new LlmError('Omar is not installed; install Antigravity and sign in with Google', 'AGY_NOT_INSTALLED', { cause: error })
      }
      directory = await mkdtemp(join(tmpdir(), 'qabas-agy-'))
      await chmod(directory, 0o700)
      const cwd = join(directory, 'work')
      await mkdir(cwd, { mode: 0o700 })
      if (prompt !== undefined) {
        const schemaFile = join(directory, 'response.json')
        await writeFile(schemaFile, JSON.stringify(responseSchema), { flag: 'wx', mode: 0o600 })
        args = [...args, '--json-schema', schemaFile]
      }
      combined.throwIfAborted()
      const child = this.subprocess.spawn({ argv: [executable, ...args], cwd, signal: combined,
        graceMs: this.config.graceMs, stdio: { stdin: prompt === undefined ? 'ignore'
          : { data: JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n' },
        stdout: onData === undefined ? { maxBytes: this.config.maxOutputBytes } : 'pipe', stderr: { maxBytes: this.config.maxOutputBytes } } })
      // Observe spawn/provider rejection while consuming stdout, before awaiting the outcome.
      void child.done.catch(() => {})
      try {
        if (child.stdout !== undefined && onData !== undefined) {
          child.stdout.setEncoding('utf8')
          for await (const data of child.stdout) onData(String(data))
        }
        const outcome = await child.done
        await child.waitForExit()
        combined.throwIfAborted()
        const stdout = child.collected.stdout?.readFrom(0)
        if (stdout?.lossy === true) throw new LlmError('Omar response exceeds maxOutputBytes', 'AGY_INVALID_RESPONSE')
        const output = stdout?.text ?? ''
        if (outcome.exitCode !== 0 && onData !== undefined) {
          throw agyFailure(child.collected.stderr?.readFrom(0).text ?? 'agy process failed')
        }
        if (outcome.exitCode !== 0 && output.trim() === '') throw agyFailure(child.collected.stderr?.readFrom(0).text ?? 'agy process failed')
        if (outcome.exitCode !== 0) {
          throw agyFailure(output)
        }
        return output
      } finally {
        child.terminate()
        await child.waitForExit()
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      if (deadline.signal.aborted) throw new LlmError('Omar exceeded the configured request timeout', 'TIMEOUT')
      throw error
    } finally {
      clearTimeout(timer)
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  }
}
