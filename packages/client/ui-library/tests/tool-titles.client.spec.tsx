// @vitest-environment jsdom
/** Production regression: MCP Tool rows use study steps rather than raw names and arguments. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { ToolTitles } from '../../ui-tool/src/client/titles.ts'
import { GenericToolCard } from '../../ui-tool/src/client/tool/toolviews/GenericToolCard.tsx'
import { dictionaries } from '../../locale-ar/src/client/locales.ts'
import { en, zh } from '../src/client/locales.ts'
import { registerTranscriberTitles, transcriberSummary } from '../src/client/tool-titles.ts'

const roots: Context[] = []
afterEach(async () => {
  cleanup()
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

function owner(argsRaw: string): ToolCallOwnerProps {
  return {
    callId: 'part-2', toolName: 'mcp__transcriber__stage_draft_part',
    block: { callId: 'part-2', name: 'mcp__transcriber__stage_draft_part', argsRaw, time: 0, turn: 1, step: 1, subCalls: [] },
    openFile: vi.fn(), loadImage: async () => '',
  }
}

describe('transcriber Tool titles', () => {
  it('registers all sixteen tools with active-language sentences and preserves row details', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const titles = new ToolTitles(ctx)
    let language: 'ar' | 'en' | 'zh' = 'ar'
    const copy = { ar: dictionaries.library, en, zh }
    const fiber = ctx.plugin({
      inject: ['toolTitles'],
      apply(scope: Context): void {
        registerTranscriberTitles(scope, (key, params) => makeTranslate(copy[language] ?? {})(key, params))
      },
    })
    await fiber.await()
    expect(Object.keys(titles.contributions.getSnapshot())).toHaveLength(16)
    const t = makeTranslate(dictionaries.conversation ?? {}, dictionaries.common ?? {})
    const call = owner('{"part":2,"parts":5,"content":"draft body"}')
    const view = render(<GenericToolCard {...call} titles={titles.contributions.getSnapshot()} t={t} />)
    expect(view.getByText('بيكتب الشرح')).toBeTruthy()
    expect(view.getByText('(جزء 2 من 5)')).toBeTruthy()
    expect(view.queryByText(/draft body/)).toBeNull()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByText('بيكتب الشرح'))
    expect(view.getByText(/draft body/)).toBeTruthy()
    language = 'en'
    view.rerender(<GenericToolCard {...call} titles={titles.contributions.getSnapshot()} t={t} />)
    expect(view.getByText('Writing the guide')).toBeTruthy()
    language = 'zh'
    view.rerender(<GenericToolCard {...call} titles={titles.contributions.getSnapshot()} t={t} />)
    expect(view.getByText('正在撰写讲解')).toBeTruthy()
    const begin = titles.contributions.getSnapshot().mcp__transcriber__begin_lecture
    expect(begin?.({ lecture: 'Hypothyroidism 2' })).toEqual({ title: zh['job.step.prepare'], summary: 'Hypothyroidism 2' })
    view.rerender(<GenericToolCard {...owner('{"part":')} titles={titles.contributions.getSnapshot()} t={t} />)
    expect(view.getByText('استدعاء أداة')).toBeTruthy()
    await fiber.dispose()
    expect(titles.contributions.getSnapshot()).toEqual({})
  })

  it.each([
    [{ part: 2, parts: 5, lecture: 'Hypothyroidism 2' }, '(part 2 of 5)'],
    [{ part: 0, parts: 5, lecture: 'Hypothyroidism 2' }, 'Hypothyroidism 2'],
    [{ part: 6, parts: 5 }, ''],
    [{ part: 1.5, parts: 5 }, ''],
    [{ part: '2', parts: 5 }, ''],
    [{ part: 2 }, ''],
    [{ lecture: { title: 'untrusted' }, manifest_path: '/private/manifest.json' }, ''],
    [{}, ''],
  ])('shows only supported lecture/part arguments: %j', (args, summary) => {
    expect(transcriberSummary(args, makeTranslate(en))).toBe(summary)
  })
})
