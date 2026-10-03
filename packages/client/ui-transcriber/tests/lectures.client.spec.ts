/** The grouping rule against the case file shared with the Python engine. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RECORDING_EXTENSIONS, extensionOf, groupRecordings, lecturesOf, partSplit, stemOf,
  titleContainsLecture,
} from '../src/client/lectures.ts'

const CASES_PATH = join(import.meta.dirname, '../../../../engine/references/lecture-grouping-cases.json')

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


})

describe('partSplit', () => {
  it('keeps names without an extension stem intact', () => {
    expect(stemOf('Lecture')).toBe('Lecture')
    expect(stemOf('.hidden')).toBe('.hidden')
  })

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

  it('orders mixed, numbered, and tied parts without changing their grouping', () => {
    const files = [
      { name: 'Topic.mp3', path: 'Lecture/Topic.mp3' },
      { name: 'Topic (2).mp3', path: 'Lecture/Topic (2).mp3' },
      { name: 'Topic (1).m4a', path: 'Lecture/Topic (1).m4a' },
      { name: 'Topic (1).mp3', path: 'Lecture/Topic (1).mp3' },
      { name: 'Topic (1).mp3', path: 'Lecture/Topic (1).mp3-copy' },
    ]

    expect(groupRecordings(files)).toEqual([{
      title: 'Topic',
      sources: [
        files[2], files[3], files[4], files[1], files[0],
      ],
    }])
    expect(groupRecordings([
      files[2]!, files[0]!,
    ])[0]?.sources).toEqual([files[2], files[0]])
    expect(groupRecordings([
      files[3]!, files[3]!,
    ])[0]?.sources).toEqual([files[3], files[3]])
    expect(groupRecordings([
      files[3]!, files[2]!,
    ])[0]?.sources).toEqual([files[2], files[3]])
  })
})

describe('titleContainsLecture', () => {
  it.each([
    ['Lec 4 - CORNEA', 'cornea', true],
    ['محاضرة 3 - القلب', 'القلب', true],
    ['Alpha Notes', 'Alpha', true],
    ['STRASSE', 'Straße', true],
    ['Eyelid 👁️', 'Eye', false],
    ['I', 'ı', false],
    ['anything', '👁️', false],
  ] as const)('%s / %s → %s', (candidate, lecture, expected) => {
    expect(titleContainsLecture(candidate, lecture)).toBe(expected)
  })
})
