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
import { failureLine, JobsTray, progressLine, stepLine, stopLine } from '../src/client/JobsTray.tsx'
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

describe('progressLine', () => {
  const job = (progress?: { done: number; total?: number }) => ({
    id: 'j', kind: 'transcribe', status: 'running', step: { tool: 'write_parts_with_agy' }, ...progress === undefined ? {} : { progress },
  }) as never

  it('names the part being written, then the check, and falls back to the step', () => {
    expect(progressLine(job({ done: 3, total: 5 }), t)).toBe(en['job.progress.part'].replace('{part}', '4').replace('{total}', '5'))
    expect(progressLine(job({ done: 0, total: 5 }), t)).toBe(en['job.progress.part'].replace('{part}', '1').replace('{total}', '5'))
    expect(progressLine(job({ done: 5, total: 5 }), t)).toBe(en['job.progress.checking'])
    expect(progressLine(job(), t)).toBe(stepLine({ tool: 'write_parts_with_agy' }, t))
  })
})

describe('failureLine', () => {
  it('says when a spent daily quota renews, and names other failures plainly', () => {
    const line = failureLine('Daily quota exhausted for model "gemini-flash-latest"', t)
    expect(line).not.toContain('{time}')
    expect(line).toMatch(/\d/u)
    expect(failureLine('This model is currently experiencing high demand.', t)).toBe(en['job.error.busy'])
  })
})

describe('stopLine', () => {
  it('names the four stops left to the student in their language', () => {
    expect(stopLine({ kind: 'network' }, t)).toBe(en['job.stop.network'])
    expect(stopLine({ kind: 'auth', service: 'NotebookLM' }, t)).toBe(en['job.stop.auth'].replace('{service}', 'NotebookLM'))
    expect(stopLine({ kind: 'missing-recording' }, t)).toBe(en['job.stop.recording'])
    expect(stopLine({ kind: 'quota' }, t)).toBe(en['job.stop.quotaUnknown'])
    expect(stopLine({ kind: 'quota', resetAt: '2026-10-05T07:00:00Z' }, t)).not.toContain('{time}')
  })
})

describe('jobFailureKind', () => {
  it('names the failures tonight\'s runs met', async () => {
    const { jobFailureKind } = await import('../src/client/job-failure.ts')
    expect(jobFailureKind('Daily quota exhausted for model "gemini-3.8-flash"')).toBe('daily-quota')
    expect(jobFailureKind('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}')).toBe('busy')
    expect(jobFailureKind('Function call is missing a thought_signature in functionCall parts')).toBe('signature')
    expect(jobFailureKind('models/gemini-2.5-flash is no longer available to new users')).toBe('model-unavailable')
    expect(jobFailureKind('code 429 RESOURCE_EXHAUSTED GenerateRequestsPerMinutePerProjectPerModel-FreeTier')).toBe('rate-limit')
    expect(jobFailureKind('Incomplete JSON segment at the end')).toBe('cut-off')
    expect(jobFailureKind('something else')).toBe('unknown')
  })
})
