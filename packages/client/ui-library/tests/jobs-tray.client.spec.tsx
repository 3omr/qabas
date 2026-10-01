// @vitest-environment jsdom
/**
 * The jobs tray: hidden with no jobs, one pill otherwise, and a waiting job's
 * question answered from the tray without opening its conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { LibraryJob, LibraryJobs } from '../src/client/jobs.ts'
import { JobsTray, stepLine } from '../src/client/JobsTray.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

function fakeJobs(list: readonly LibraryJob[]) {
  const spies = { answer: vi.fn(async () => {}), open: vi.fn() }
  const jobs = {
    jobs: createSnapshotStore<readonly LibraryJob[]>(list),
    ...spies,
    cancel: vi.fn(async () => {}),
    dismiss: vi.fn(),
  } as unknown as LibraryJobs
  return { jobs, ...spies }
}

const waiting: LibraryJob = {
  id: 'j1',
  sessionId: 's1',
  kind: 'transcribe',
  module: 'ophthalmology',
  moduleName: 'Ophthalmology',
  lecture: 'Conjunctiva',
  status: 'waiting',
  startedAt: 1,
  question: {
    key: 'q',
    questions: [{ id: 'save', question: 'Save the draft?', options: [{ label: 'Yes' }, { label: 'No' }] }],
  },
}

afterEach(() => { cleanup() })

describe('JobsTray', () => {
  it('draws nothing without jobs', () => {
    const { container } = render(<JobsTray jobs={fakeJobs([]).jobs} reveal={vi.fn()} t={t} />)
    expect(container.innerHTML).toBe('')
  })

  it('answers a waiting job from the tray', () => {
    const { jobs, answer: answered, open } = fakeJobs([waiting])
    render(<JobsTray jobs={jobs} reveal={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: en['job.pill.waiting'] }))
    const answer = screen.getByRole('button', { name: en['job.answer'] })
    expect((answer as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Yes'))
    fireEvent.click(answer)
    expect(answered).toHaveBeenCalledWith('j1', { answers: [{ id: 'save', selected: ['Yes'] }] })
    expect(open).not.toHaveBeenCalled()
  })

  it('puts the panel away on Escape and on a click elsewhere', () => {
    render(<JobsTray jobs={fakeJobs([waiting]).jobs} reveal={vi.fn()} t={t} />)
    const pill = screen.getByRole('button', { name: en['job.pill.waiting'] })
    fireEvent.click(pill)
    expect(screen.queryByRole('region', { name: en['job.tray'] })).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: en['job.tray'] })).toBeNull()
    fireEvent.click(pill)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('region', { name: en['job.tray'] })).toBeNull()
  })

  it('says which part a step is on', () => {
    expect(stepLine({ tool: 'stage_draft_part', part: 2, parts: 5 }, t)).toBe('Writing the guide (part 2 of 5)')
    expect(stepLine({ tool: 'unknown_tool' }, t)).toBe(en['job.step.working'])
  })
})
