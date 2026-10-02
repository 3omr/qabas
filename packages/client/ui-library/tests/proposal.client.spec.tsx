// @vitest-environment jsdom
/**
 * The proposed organization: unchanged lectures start unticked, titles can be
 * edited, and only the ticked lectures are saved, keeping their ids.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { OrganizationProposal } from '../src/client/editing.ts'
import { en } from '../src/client/locales.ts'
import { ProposalReview } from '../src/client/views/Proposal.tsx'

const t = makeTranslate(en)

const PROPOSAL: OrganizationProposal = {
  source: 'agy',
  lectures: [
    { title: 'Shock', recordings: ['Shock boys part 1.m4a', 'Shock girls part 1.m4a'], materials: ['Shock.pptx'], existingId: 'shock', change: 'changed' },
    { title: 'Wound healing', recordings: ['Wound healing boys.m4a'], materials: [], change: 'same' },
    { title: 'Keloid', recordings: ['Keloid.m4a'], materials: ['Hypertrophic scar and Keloid.pptx'], change: 'new' },
  ],
  unassigned: { recordings: [], materials: ['Old notes.pdf'] },
  notes: [],
}

afterEach(() => { cleanup() })

describe('ProposalReview', () => {
  it('saves only the ticked lectures, with edited titles and existing ids', () => {
    const save = vi.fn()
    render(<ProposalReview state={{ status: 'ready', value: PROPOSAL }} saving={false} error={undefined} again={vi.fn()} save={save} close={vi.fn()} t={t} />)
    expect((screen.getByLabelText(en['propose.include'].replace('{title}', 'Wound healing'))).checked).toBe(false)
    expect(screen.getByText(/Old notes\.pdf/u)).toBeTruthy()
    const titles = screen.getAllByLabelText(en['manage.editor.title'])
    fireEvent.change(titles[2] as HTMLElement, { target: { value: ' Hypertrophic scar & Keloid ' } })
    fireEvent.click(screen.getByRole('button', { name: en['propose.save'].replace('{count}', '2') }))
    expect(save).toHaveBeenCalledWith([
      { id: 'shock', title: 'Shock', recordings: ['Shock boys part 1.m4a', 'Shock girls part 1.m4a'], materials: ['Shock.pptx'] },
      { title: 'Hypertrophic scar & Keloid', recordings: ['Keloid.m4a'], materials: ['Hypertrophic scar and Keloid.pptx'] },
    ])
  })

  it('says it is waiting, and offers to ask again after a failure', () => {
    const again = vi.fn()
    const { rerender } = render(<ProposalReview state={{ status: 'loading' }} saving={false} error={undefined} again={again} save={vi.fn()} close={vi.fn()} t={t} />)
    expect(screen.getByRole('status').textContent).toContain('agy')
    rerender(<ProposalReview state={{ status: 'failed', message: 'agy timed out' }} saving={false} error={undefined} again={again} save={vi.fn()} close={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['propose.again'] }))
    expect(again).toHaveBeenCalled()
  })
})
