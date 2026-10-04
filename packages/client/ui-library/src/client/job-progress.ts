/** Interpret the public Chat target's tool and turn observations for library jobs. */
import { z } from 'zod'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { JobStep } from './jobs.ts'

const PREFIX = 'mcp__transcriber__'
const DraftArguments = z.object({
  part: z.number().int().positive().optional(),
  parts: z.number().int().positive().optional(),
})

function stepOf(tool: string, argsRaw: string): JobStep {
  if (tool !== 'read_draft' && tool !== 'stage_draft_part') return { tool }
  let args: unknown
  try {
    args = JSON.parse(argsRaw)
  } catch {
    // Streaming tool arguments can be incomplete JSON until the call starts.
    return { tool }
  }
  const parsed = DraftArguments.safeParse(args)
  if (!parsed.success) return { tool }
  return {
    tool,
    ...parsed.data.part === undefined ? {} : { part: parsed.data.part },
    ...parsed.data.parts === undefined ? {} : { parts: parsed.data.parts },
  }
}

/** Latest transcriber call, including calls nested under code dispatch. */
interface TranscriberCall {
  readonly step: JobStep
  readonly successful: boolean
  readonly time: number
  readonly progress: ToolCallBlock['progress']
}

function uploadedRecordings(call: ToolCallBlock): boolean {
  if (!('kind' in call) || call.isError || call.call?.name !== `${PREFIX}begin_lecture`) return false
  const text = call.content.filter(block => block.type === 'text').map(block => block.text).join('')
  try {
    const parsed = z.object({ uploaded: z.array(z.string()).min(1) }).safeParse(JSON.parse(text))
    return parsed.success
  } catch {
    // Generic tool content may be plain text; only engine JSON declares completed uploads.
    return false
  }
}

function latestCall(calls: readonly ToolCallBlock[]): TranscriberCall | undefined {
  let latest: TranscriberCall | undefined
  for (const call of calls) {
    const head = 'kind' in call ? call.call : call
    if (head?.name.startsWith(PREFIX)) {
      const candidate = {
        step: { ...stepOf(head.name.slice(PREFIX.length), head.argsRaw), ...uploadedRecordings(call) ? { uploaded: true } : {} },
        successful: 'kind' in call && !call.isError,
        time: 'kind' in call ? call.callTime ?? call.time : call.time,
        progress: 'kind' in call ? undefined : call.progress,
      }
      if (latest === undefined || candidate.time >= latest.time) latest = candidate
    }
    const child = latestCall(call.subCalls)
    if (child !== undefined && (latest === undefined || child.time >= latest.time)) latest = child
  }
  return latest
}

function finalized(calls: readonly ToolCallBlock[]): boolean {
  return calls.some(call => ('kind' in call && !call.isError && call.call?.name === `${PREFIX}finalize`)
    || finalized(call.subCalls))
}

function sourceWarnings(calls: readonly ToolCallBlock[]): readonly string[] {
  const warnings = new Set<string>()
  for (const call of calls) {
    if ('kind' in call && !call.isError && call.call?.name.startsWith(PREFIX)) {
      for (const block of call.content) {
        if (block.type !== 'text') continue
        for (const match of block.text.matchAll(/^\[SOURCE-WARNING\] (.+)$/gm)) warnings.add(match[0].slice('[SOURCE-WARNING] '.length))
      }
    }
    for (const warning of sourceWarnings(call.subCalls)) warnings.add(warning)
  }
  return [...warnings]
}

/**
 * Read job progress without reaching into the Session or Chat implementations.
 * @param chat - active public Chat target, absent until its builder registers.
 * @returns latest tool, source warnings, assistant text, and recorded turn ending.
 */
export function jobProgress(chat: ChatSnapshot | undefined): {
  readonly finalized: boolean
  readonly warnings: readonly string[]
  readonly call: TranscriberCall | undefined
  readonly summary: string | undefined
  readonly reason: TurnEndReason | undefined
} {
  const nodes = chat?.legacy.nodes ?? []
  const calls: ToolCallBlock[] = nodes.filter(node => node.kind === 'tool-result')
  calls.push(...chat?.legacy.runningCalls ?? [])
  const assistant = nodes.findLast(node => node.kind === 'assistant')
  const turn = chat?.timeline.turnOrder.at(-1)
  const reason = turn === undefined ? undefined : chat?.timeline.turns.get(turn)?.end?.data.reason
  return {
    finalized: finalized(calls),
    warnings: sourceWarnings(calls),
    call: latestCall(calls),
    summary: assistant?.blocks.filter(block => block.kind === 'text').map(block => block.text).join(''),
    reason,
  }
}
