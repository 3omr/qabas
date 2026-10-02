/** Tool JSON and recursive public tool nodes can contain incomplete or unrelated calls. */
import { describe, expect, it } from 'vitest'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { EMPTY_CHAT_SNAPSHOT, isRunningTool } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { jobProgress } from '../src/client/job-progress.ts'

function running(name: string, time = 1, argsRaw = '{}', subCalls: readonly ToolCallBlock[] = []): ToolCallBlock {
  return { name, argsRaw, time, callId: `${name}-${time}`, turn: 1, step: 1, subCalls }
}
function snapshot(calls: readonly ToolCallBlock[]): ChatSnapshot {
  return { ...EMPTY_CHAT_SNAPSHOT, legacy: {
    ...EMPTY_CHAT_SNAPSHOT.legacy,
    nodes: calls.filter(call => 'kind' in call),
    runningCalls: calls.filter(isRunningTool),
  } }
}

describe('jobProgress', () => {
  it.each([
    ['{', { tool: 'read_draft' }],
    ['null', { tool: 'read_draft' }],
    ['{"part":-1}', { tool: 'read_draft' }],
    ['{"part":1.5}', { tool: 'read_draft' }],
    ['{}', { tool: 'read_draft' }],
    ['{"part":2}', { tool: 'read_draft', part: 2 }],
    ['{"parts":5}', { tool: 'read_draft', parts: 5 }],
  ])('reads draft arguments %s', (args, expected) => {
    expect(jobProgress(snapshot([running('mcp__transcriber__read_draft', 1, args)])).call?.step).toEqual(expected)
  })

  it.each([
    ['{"uploaded":["Orbit.mp3"]}', false, true],
    ['{"uploaded":[]}', false, undefined],
    ['{"uploaded":[1]}', false, undefined],
    ['not JSON', false, undefined],
    ['{"uploaded":["Orbit.mp3"]}', true, undefined],
  ])('reports confirmed uploads from begin_lecture result %s', (text, isError, uploaded) => {
    const call = { kind: 'tool-result' as const, seq: 1, time: 1, callId: 'begin', callTime: 1,
      call: { name: 'mcp__transcriber__begin_lecture', argsRaw: '{}' }, isError,
      content: [{ type: 'text' as const, text }], subCalls: [] }
    expect(jobProgress(snapshot([call])).call?.step.uploaded).toBe(uploaded)
  })

  it('finds the latest nested call and ignores unrelated or unpaired results', () => {
    const finalize = { kind: 'tool-result' as const, seq: 5, time: 8, callId: 'finalize',
      call: { name: 'mcp__transcriber__finalize', argsRaw: '{}' }, callTime: null,
      isError: false, content: [], subCalls: [],
    }
    const dispatch = running('code_dispatch', 1, '{}', [
      running('mcp__transcriber__read_draft', 2), finalize,
    ])
    const orphan = { ...finalize, call: null, time: 9 }
    const progress = jobProgress(snapshot([orphan, dispatch, running('mcp__transcriber__read_draft', 3)]))
    expect(progress.call?.step).toEqual({ tool: 'finalize' })
    expect(progress.call?.successful).toBe(true)
    expect(jobProgress(snapshot([dispatch, running('mcp__transcriber__audit', 10)])).call?.step.tool).toBe('audit')
    expect(jobProgress(snapshot([running('other', 20, '{}', [running('other-child')])])).call).toBeUndefined()
    expect(jobProgress(snapshot([running('mcp__transcriber__audit', 10, '{}', [running('mcp__transcriber__read_draft', 2)])])).call?.step.tool).toBe('audit')
    expect(jobProgress(undefined)).toEqual({ call: undefined, summary: undefined, reason: undefined })
  })
})
