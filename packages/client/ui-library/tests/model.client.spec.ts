/**
 * What a lecture is to the library: an engine entry read into one of four
 * states, counted per module, and titled for a student to read.
 */
import { describe, expect, it } from 'vitest'
import {
  canTranscribe, countStates, displayTitle, lectureFromEngine, type LibraryLecture,
} from '../src/client/model.ts'

const entry = {
  title: 'Glaucoma🔵',
  parts: 1,
  recording_sources: ['Glaucoma🔵.m4a'],
  transcribed: false,
}

describe('lectureFromEngine', () => {
  it('retains the manual id and selected materials when editing a lecture', () => {
    expect(lectureFromEngine({ ...entry, id: 'glaucoma', origin: 'manual', materials: ['Slides.pdf', 'Book.pdf'] }))
      .toMatchObject({ id: 'glaucoma', origin: 'manual', materials: ['Slides.pdf', 'Book.pdf'] })
  })

  it('takes the engine\'s state and paths when it reports them', () => {
    expect(lectureFromEngine({
      ...entry,
      in_notebook_only: true,
      state: 'draft',
      transcript: null,
      draft: '/w/modules/ophtha/Transcripts/Glaucoma 👁️.md.draft.md',
      verbatim: '/w/modules/ophtha/Verbatim/Glaucoma🔵.verbatim.md',
    })).toEqual({
      title: 'Glaucoma🔵',
      parts: 1,
      sources: ['Glaucoma🔵.m4a'],
      inNotebookOnly: true,
      state: 'draft',
      draft: '/w/modules/ophtha/Transcripts/Glaucoma 👁️.md.draft.md',
      verbatim: '/w/modules/ophtha/Verbatim/Glaucoma🔵.verbatim.md',
    })
  })

  it('reads an older engine\'s transcribed flag as finished or not started', () => {
    expect(lectureFromEngine({ ...entry, transcribed: true }).state).toBe('final')
    expect(lectureFromEngine(entry).state).toBe('pending')
    expect(lectureFromEngine(entry).inNotebookOnly).toBe(false)
  })
})

describe('countStates', () => {
  it('counts every state, including the empty ones', () => {
    const lectures = (['final', 'final', 'draft'] as const).map(state => ({ ...lectureFromEngine(entry), state }))
    expect(countStates(lectures)).toEqual({ pending: 0, verbatim: 0, draft: 1, final: 2 })
  })
})

describe('canTranscribe', () => {
  const lecture = (overrides: Partial<LibraryLecture>): LibraryLecture => ({ ...lectureFromEngine(entry), ...overrides })

  it('offers a run for a recording that is not finished', () => {
    expect(canTranscribe(lecture({ state: 'pending' }))).toBe(true)
    expect(canTranscribe(lecture({ state: 'verbatim' }))).toBe(true)
  })

  it('offers none once finished, or when the recording is gone', () => {
    expect(canTranscribe(lecture({ state: 'final' }))).toBe(false)
    expect(canTranscribe(lecture({ parts: 0, state: 'pending' }))).toBe(false)
  })
})

describe('displayTitle', () => {
  it('drops the emoji a recording or transcript carries', () => {
    expect(displayTitle('Glaucoma🔵')).toBe('Glaucoma')
    expect(displayTitle('Uveal tract 👁️')).toBe('Uveal tract')
    expect(displayTitle('مراجعه اشعه 🩻')).toBe('مراجعه اشعه')
  })

  it('keeps a title that is nothing but decoration', () => {
    expect(displayTitle('🩻')).toBe('🩻')
  })
})

describe('lectureHeading', () => {
  it('names a finished lecture by its transcript, and keeps the unit title otherwise', async () => {
    const { lectureFromEngine, lectureHeading } = await import('../src/client/model.ts')
    const base = { title: '1st lecture', parts: 2, recording_sources: ['a.mp3', 'b.mp3'], transcribed: true }
    expect(lectureHeading(lectureFromEngine({ ...base, transcript_title: 'Introduction to Endocrinology 🧬' }))).toBe('Introduction to Endocrinology')
    expect(lectureHeading(lectureFromEngine(base))).toBe('1st lecture')
    expect(lectureFromEngine({ ...base, transcript_title: '1st lecture' }).transcriptTitle).toBeUndefined()
  })
})
