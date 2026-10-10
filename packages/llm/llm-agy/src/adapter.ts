/** Antigravity as a model; Qabas retains tool execution and session ownership. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, LlmModelInfo } from '@deepseek-ai/dsh-llm'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import { renderPrompt } from './prompt.ts'
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
   * Validate a complete CLI response before yielding text or requested Qabas calls.
   * @param request - logged model request and live cancellation signal.
   * @returns chunks ending in exactly one success, failure or cancellation finish.
   */
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const resolved = this.resolve(request)
    try {
      const output = await this.run([
        '-p', renderPrompt(request), '--output-format', 'json', '--effort', resolved.reasoningEffort,
        '--model', request.model, '--sandbox',
      ], request.signal, true)
      const { answer, usage } = parseResponse(output, request)
      let index = 0
      if (answer.text !== '') {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: answer.text }
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

  private run(args: string[], signal?: AbortSignal, schema = false): Promise<string> {
    const operation = this.execute(args, signal, schema)
    const tracked = operation.finally(() => { this.active.delete(tracked) })
    this.active.add(tracked)
    return tracked
  }

  private async execute(args: string[], signal?: AbortSignal, schema = false): Promise<string> {
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
      if (schema) {
        const schemaFile = join(directory, 'response.json')
        await writeFile(schemaFile, JSON.stringify(responseSchema), { flag: 'wx', mode: 0o600 })
        args = [...args, '--json-schema', schemaFile]
      }
      combined.throwIfAborted()
      const child = this.subprocess.spawn({ argv: [executable, ...args], cwd, signal: combined,
        graceMs: this.config.graceMs, stdio: { stdin: 'ignore',
          stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } } })
      try {
        const outcome = await child.done
        await child.waitForExit()
        combined.throwIfAborted()
        const stdout = child.collected.stdout?.readFrom(0)
        if (stdout?.lossy === true) throw new LlmError('Omar response exceeds maxOutputBytes', 'AGY_INVALID_RESPONSE')
        const output = stdout?.text ?? ''
        if (outcome.exitCode !== 0 && output.trim() === '') throw agyFailure(child.collected.stderr?.readFrom(0).text ?? 'agy process failed')
        if (outcome.exitCode !== 0) {
          // In-band ERROR JSON retains the CLI's actionable diagnostic.
          if (schema) parseResponse(output, { provider: 'agy', model: '', messages: [] })
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
