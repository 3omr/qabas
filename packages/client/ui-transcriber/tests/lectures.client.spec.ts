/**
 * The grouping rule against the case file the engine's own suite reads.
 *
 * The vendored copy is what lets this suite run in a checkout that has no
 * engine beside it; the drift check below is what stops the copy from
 * quietly becoming a second opinion.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RECORDING_EXTENSIONS, extensionOf, lecturesOf, partSplit } from '../src/client/lectures.ts'

const CASES_PATH = join(import.meta.dirname, 'fixtures/lecture-grouping-cases.json')

interface Case {
  readonly name: string
  readonly files: readonly string[]
  readonly transcripts: readonly string[]
  readonly lectures: readonly { title: string; sources: string[]; transcribed: boolean }[]
}

const cases: Case[] = (JSON.parse(readFileSync(CASES_PATH, 'utf8')) as { cases: Case[] }).cases

describe('the shared lecture-grouping cases', () => {
  it('is actually populated, so a silent zero-case run cannot pass forever', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10)
  })

  it.each(cases.map(one => [one.name, one] as const))('%s', (_name, one) => {
    const recordings = one.files
      .filter(name => RECORDING_EXTENSIONS.has(extensionOf(name)))
      .map(name => ({ name, path: `Lecture/${name}` }))
    expect(lecturesOf(recordings, one.transcripts).map(lecture => ({
      title: lecture.title,
      sources: lecture.sources.map(source => source.name),
      transcribed: lecture.transcribed,
    }))).toEqual(one.lectures)
  })

  // Runs only where the engine is checked out beside the app, which is where
  // an edit to one side and not the other actually happens.
  const skillRoot = process.env.TRANSCRIBER_SKILL_ROOT
  const drift = skillRoot === undefined ? it.skip : it
  drift('matches the engine\'s copy byte for byte', () => {
    const origin = join(skillRoot!, 'references/lecture-grouping-cases.json')
    expect(readFileSync(CASES_PATH, 'utf8')).toEqual(readFileSync(origin, 'utf8'))
  })
})

describe('partSplit', () => {
  it('leaves a stem with no trailing number alone', () => {
    expect(partSplit('Corrosives')).toEqual({ base: 'Corrosives', part: undefined })
  })

  it('refuses to split a stem that is nothing but a number', () => {
    // There would be no title left to group the file under.
    expect(partSplit('2')).toEqual({ base: '2', part: undefined })
  })

  it('reads a three-digit run as no part at all rather than its last two digits', () => {
    expect(partSplit('Lecture 100')).toEqual({ base: 'Lecture 100', part: undefined })
  })
})
