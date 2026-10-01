/** Transcriber labels contributed through the generic Tool title service. */
import type { Context } from '@deepseek-ai/cordis'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolTitle } from '@deepseek-ai/dsh-client-ui-tool/client'
import { STEP_KEYS } from './tool-steps.ts'

function positiveInteger(argument: unknown): argument is number {
  return typeof argument === 'number' && Number.isSafeInteger(argument) && argument > 0
}

/**
 * Derive only student-facing arguments, excluding manifest paths and draft content.
 * @param args - Parsed open-root MCP arguments.
 * @param t - Active library translator.
 * @returns Lecture title or a valid part ordinal; otherwise no summary.
 */
export function transcriberSummary(args: Readonly<Record<string, unknown>>, t: TranslateNS<'library'>): string {
  if (positiveInteger(args.part) && positiveInteger(args.parts) && args.part <= args.parts) {
    return t('job.step.part', { part: String(args.part), parts: String(args.parts) })
  }
  return typeof args.lecture === 'string' ? args.lecture.trim() : ''
}

/**
 * Mount every known transcriber title for this dependency lifetime.
 * @param ctx - Context with the generic toolTitles service injected.
 * @param t - Active library translator, evaluated when the row renders.
 */
export function registerTranscriberTitles(ctx: Context, t: TranslateNS<'library'>): void {
  for (const [tool, key] of Object.entries(STEP_KEYS)) {
    ctx.effect(() => ctx.toolTitles.register(`mcp__transcriber__${tool}`, (args): ToolTitle => ({
      title: t(key),
      summary: transcriberSummary(args, t),
    })), `ui-library: ${tool} title`)
  }
}
