/**
 * What the library knows about a study workspace, independent of how it was read.
 *
 * The engine is the authority on what a lecture is and how far along it is;
 * this is the shape the library draws from, so a view never has to know
 * whether it came from an engine that reports `state` or an older one that
 * reports only `transcribed`.
 */

/**
 * How far a lecture has come: nothing yet, the doctor's words fetched, a
 * draft written from them, the finished transcript.
 */
export type LectureState = 'pending' | 'verbatim' | 'draft' | 'final'

/** Every state, in the order a lecture moves through them. */
export const LECTURE_STATES: readonly LectureState[] = ['pending', 'verbatim', 'draft', 'final']

/** One module as the library lists it. */
export interface LibraryModule {
  /** Folder name under `modules/`, and the id every engine tool takes. */
  readonly id: string
  /** The module's own name from `module.json`. */
  readonly displayName: string
  /** NotebookLM notebooks configured for the module; empty when none is linked. */
  readonly notebooks: readonly string[]
  /** Absolute module folder. */
  readonly root: string
}

/** One lecture unit: a recording (or several parts of one), or a transcript whose recording is gone. */
export interface LibraryLecture {
  /** The unit title as the engine groups it; also what a transcription run is asked for. */
  readonly title: string
  /** Recording parts; zero when only the finished transcript remains. */
  readonly parts: number
  /** Recording file names, in part order. */
  readonly sources: readonly string[]
  /** The recording exists only in the module's NotebookLM notebook. */
  readonly inNotebookOnly: boolean
  /** Progress. */
  readonly state: LectureState
  /** Absolute path of the finished transcript, when there is one. */
  readonly transcript?: string
  /** The finished transcript's own title, when it names the lecture differently ("Introduction to Endocrinology" for "1st lecture"). */
  readonly transcriptTitle?: string
  /** Absolute path of the saved draft, when there is one. */
  readonly draft?: string
  /** Absolute path of the doctor's verbatim words, when fetched. */
  readonly verbatim?: string
  /** Each recording's verbatim words, when the lecture has several recordings. */
  readonly verbatims?: readonly string[]
  /** Who decided this is one lecture: the student (manual) or the file names (auto). */
  readonly origin?: 'manual' | 'auto'
  /** A manual definition's stable id. */
  readonly id?: string
  /** The slides and books the lecture is explained with, when the engine says. */
  readonly materials?: readonly string[]
}

/** A module's slides, books and papers: what a lecture is explained with, never transcribed. */
export interface LibraryMaterial {
  /** File name. */
  readonly name: string
  /** Path under the module. */
  readonly path: string
}

/** One module's lectures and materials. */
export interface ModuleContents {
  readonly lectures: readonly LibraryLecture[]
  readonly materials: readonly LibraryMaterial[]
  /** The engine could not reach the notebook; the list is local files only. */
  readonly warning?: string
}

/** One lecture entry as the engine's `list_lectures` returns it. */
export interface EngineLectureEntry {
  readonly title: string
  readonly parts: number
  readonly recording_sources: readonly string[]
  readonly transcribed: boolean
  readonly in_notebook_only?: boolean
  readonly state?: LectureState
  readonly transcript?: string | null
  readonly transcript_title?: string | null
  readonly draft?: string | null
  readonly verbatim?: string | null
  readonly verbatims?: readonly string[]
  readonly origin?: 'manual' | 'auto'
  readonly id?: string
  readonly materials?: readonly string[]
}

/**
 * Read one engine entry into the library's shape.
 *
 * Older engines report only `transcribed`; that is `final` or `pending`,
 * since they have no way to say a draft or the verbatim exists.
 * @param entry - one element of `list_lectures`' `lectures`.
 * @returns the library lecture.
 */
export function lectureFromEngine(entry: EngineLectureEntry): LibraryLecture {
  const state = entry.state ?? (entry.transcribed ? 'final' : 'pending')
  return {
    title: entry.title,
    parts: entry.parts,
    sources: entry.recording_sources,
    inNotebookOnly: entry.in_notebook_only === true,
    state,
    ...entry.transcript == null ? {} : { transcript: entry.transcript },
    ...entry.transcript_title == null || entry.transcript_title === entry.title ? {} : { transcriptTitle: entry.transcript_title },
    ...entry.draft == null ? {} : { draft: entry.draft },
    ...entry.verbatim == null ? {} : { verbatim: entry.verbatim },
    ...entry.verbatims === undefined || entry.verbatims.length < 2 ? {} : { verbatims: entry.verbatims },
    ...entry.origin === undefined ? {} : { origin: entry.origin },
    ...entry.id === undefined ? {} : { id: entry.id },
    ...entry.materials === undefined ? {} : { materials: entry.materials },
  }
}

/** How many lectures are in each state. */
export type StateCounts = Readonly<Record<LectureState, number>>

/**
 * Count a module's lectures per state.
 * @param lectures - the module's lectures.
 * @returns a count for every state, zero included.
 */
export function countStates(lectures: readonly LibraryLecture[]): StateCounts {
  const counts: Record<LectureState, number> = { pending: 0, verbatim: 0, draft: 0, final: 0 }
  for (const lecture of lectures) counts[lecture.state] += 1
  return counts
}

/**
 * A lecture still needs a transcription run: it has a recording and no
 * finished transcript. A unit with no parts is a transcript whose audio is
 * gone; there is nothing to run the pipeline over.
 * @param lecture - the lecture.
 * @returns whether "transcribe" applies.
 */
export function canTranscribe(lecture: LibraryLecture): boolean {
  return lecture.parts > 0 && lecture.state !== 'final'
}

/** Emoji and pictographs a title carries as decoration, not as words. */
const DECORATION = /[\p{So}\p{Sk}︎️‍⃣]/gu

/**
 * The title a student reads: the unit title without the emoji a recording or
 * a transcript carries, which the library already shows as a state.
 * @param title - unit title.
 * @returns the title without decoration, or the title itself when nothing else is left.
 */
export function displayTitle(title: string): string {
  const plain = title.replace(DECORATION, '').replace(/\s+/gu, ' ').trim()
  return plain === '' ? title : plain
}

/**
 * The name a student knows a lecture by: a finished transcript's own title
 * when it has one, otherwise the unit title; decoration stripped either way.
 * @param lecture - the lecture.
 * @returns the heading text.
 */
export function lectureHeading(lecture: LibraryLecture): string {
  return displayTitle(lecture.transcriptTitle ?? lecture.title)
}
