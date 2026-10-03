/** Which lecture actions apply to which lecture state. */
import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { actionRules } from '../src/client/chat-actions.ts'
import { en } from '../src/client/locales.ts'
import type { LibraryLecture } from '../src/client/model.ts'

const t = makeTranslate(en)
const module = { id: 'surgery', displayName: 'Surgery', notebooks: [], root: '/w' }

function applying(lecture: Partial<LibraryLecture>): string[] {
  const target = { module, lecture: { title: 'Shock', parts: 4, sources: [], inNotebookOnly: false, state: 'pending' as const, ...lecture } }
  return actionRules(t).filter(rule => rule.scope === 'lecture' && rule.appliesTo(target)).map(rule => rule.id)
}

describe('lecture actions', () => {
  it('offers transcribing again for any started lecture, and finishing a pending redo draft', () => {
    expect(applying({ state: 'pending' })).toEqual(['transcribe'])
    expect(applying({ state: 'verbatim' })).toEqual(['transcribe', 'redo'])
    expect(applying({ state: 'draft' })).toEqual(['redo', 'continue'])
    expect(applying({ state: 'final' })).toEqual(['redo'])
    expect(applying({ state: 'final', draft: '/w/Shock.md.draft.md' })).toEqual(['redo', 'continue'])
    expect(applying({ state: 'final', parts: 0 })).toEqual([])
  })
})
