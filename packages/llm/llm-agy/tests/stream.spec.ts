/** CLI framing, byte bounds and provisional text at the external process input. */
import { describe, expect, it } from 'vitest'
import { AgyStream } from '../src/stream.ts'

const line = (event: unknown) => JSON.stringify(event) + '\n'
const delta = (text: string) => line({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } })
const result = line({ event: 'result', result: { status: 'SUCCESS', structured_output: { text: 'Hello', tool_calls: [] } } })

describe('agy stream decoding', () => {
  it('decodes split JSON escapes and withholds tool arguments and metadata', () => {
    const decoder = new AgyStream()
    const text: string[] = []
    const feed = (data: string) => { decoder.feed(data, 4096, (value) => { text.push(value) }) }
    feed(line({ event: 'init', init: { tools: ['shell'] } }))
    const first = delta('{"text":"شرح \\uD83D')
    feed(first.slice(0, 20)); feed(first.slice(20))
    feed(delta('\\uDE00\\n\\"Hello\\"", "tool_calls":'))
    feed(delta('[]}'))
    feed(result)
    expect(text.join('')).toBe('شرح 😀\n"Hello"')
    expect(JSON.parse(decoder.finish())).toMatchObject({ status: 'SUCCESS' })
  })
  it('withholds non-schema CLI commentary and fenced nested answers until validation', () => {
    const decoder = new AgyStream()
    const text: string[] = []
    decoder.feed(delta('{"text":"```json'), 4096, (value) => { text.push(value) })
    decoder.feed(result, 4096, (value) => { text.push(value) })
    expect(text).toEqual([])
    expect(decoder.finish()).toContain('SUCCESS')
  })
  it.each([
    ['missing result', delta('{"text":"Hello'), false],
    ['malformed NDJSON', 'broken\n', true],
    ['missing result payload', line({ event: 'result' }), true],
    ['duplicate result', result + result, true],
    ['internal agy tool', line({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'view_file' } }), true],
  ])('rejects %s', (_name, input, onFeed) => {
    const decoder = new AgyStream()
    expect(() => { decoder.feed(input, 4096, () => {}); if (!onFeed) decoder.finish() }).toThrow()
  })
  it('applies the configured bound to complete multibyte stdout, including wrappers', () => {
    const input = delta('{"text":"شرح') + result
    const exact = new AgyStream()
    expect(() => { exact.feed(input, Buffer.byteLength(input), () => {}); exact.finish() }).not.toThrow()
    expect(() => { new AgyStream().feed(input, Buffer.byteLength(input) - 1, () => {}) }).toThrow('maxOutputBytes')
  })
  it('accepts the recorded agy sequence: answer turn, restating turn, finish tool, result', () => {
    // Event order recorded from agy 1.3.3 with --output-format stream-json and --json-schema.
    const step = (index: number, update: Record<string, unknown>) => line({ event: 'step_update', step_update: { step_index: index, ...update } })
    const decoder = new AgyStream()
    const text: string[] = []
    for (const input of [
      step(1, { step_type: 'agent_response', state: 'ACTIVE', text_delta: '{"text": "Hello! It is a pleasure' }),
      step(1, { step_type: 'agent_response', state: 'DONE', text_delta: ' to meet you.", "tool_calls": []}\n' }),
      step(2, { step_type: 'user_input', state: 'DONE' }),
      step(3, { step_type: 'agent_response', state: 'DONE', text_delta: '{"text":"Hello! It is a pleasure to meet you.","toolAction":"Completing task","tool_calls":[]}\n' }),
      step(4, { step_type: 'tool', tool_name: 'finish', state: 'DONE' }),
      result,
    ]) decoder.feed(input, 65536, (value) => { text.push(value) })
    expect(text.join('')).toBe('Hello! It is a pleasure to meet you.')
    expect(decoder.finish()).toContain('SUCCESS')
  })
  it('accepts a terminal result without a trailing newline', () => {
    const decoder = new AgyStream()
    decoder.feed(result.trimEnd(), 4096, () => {})
    expect(decoder.finish()).toContain('SUCCESS')
  })
})
