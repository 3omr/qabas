/**
 * Shared lecture classification for the transcriber panel and composer.
 *
 * This is a deliberate port of the rule in
 * `engine/scripts/mcp_server.py`, not an independent
 * design: browser surfaces and the engine must agree on what a lecture is, or
 * a surface offers a unit the engine will not run. The port exists because
 * browser surfaces redraw from the workspace listing directly, with no Python
 * in the loop.
 *
 * `engine/references/lecture-grouping-cases.json` is shared with
 * the Python suite, so both browser consumers are checked against one set of
 * cases.
 */

/** The panel's compatibility exports for the shared transcriber format facts. */
export { RECORDING_EXTENSIONS, extensionOf } from '@deepseek-ai/dsh-util-transcriber-formats'

import { extensionOf } from '@deepseek-ai/dsh-util-transcriber-formats'

/**
 * `Transcripts/` holds finished transcripts plus `Index.md`, which lists them.
 * The index is a deliverable, not a transcript, and must not mark a lecture done.
 */
const NON_TRANSCRIPT_STEMS: ReadonlySet<string> = new Set(['index'])

/** The symbols the shared rule ignores so presentation emoji do not split a match. */
const MATCH_SYMBOLS = /\p{So}|\p{Sk}|[\uFE0E\uFE0F\u200D\u20E3]/gu

/** One leading lecture ordinal, including its optional spoken label. */
const ORDINAL_PREFIX
  = /^(?:(?:lec|lecture|محاضرة)(?=\s|\p{Nd})\s*)?\p{Nd}{1,3}(?:[-._):]|\s+)(?=\s*\S)/u

/** Separators that become one comparison-space after title cleanup. */
const MATCH_SEPARATORS = /[\s._\-–—]+/gu

/**
 * Apply locale-independent Unicode case folding without a browser data file.
 * JavaScript has no casefold primitive; folding each code point through its
 * upper/lower mappings covers multi-character folds such as `ß` and `ς`, while
 * preserving dotless `ı`, which Unicode casefold keeps distinct from `i`.
 */
function caseFold(title: string): string {
  return title
    .replace(/[\s\S]/gu, character => character === 'ı' ? character : character.toUpperCase().toLowerCase())
    .replace(/ß/gu, 'ss')
}

/**
 * A trailing part marker: "Corrosives Part 2", "Corrosives (2)", "Corrosives 2",
 * "Corrosives جزء 2".
 *
 * The `(?<!\d)` is load-bearing. Without it, `\d{1,2}` anchored at the end
 * happily matches the last two digits of a longer run, so "Revision 2024"
 * splits into "Revision 20" part 24 — and "Revision 2024" beside
 * "Revision 2025" merges into one fake lecture titled "Revision 20".
 */
const PART_SUFFIX
  = /[\s._\-–—]*[([]?\s*(?:part|pt|ch|chapter|جزء|الجزء)?\s*\.?\s*(?<!\d)(\d{1,2})\s*[)\]]?$/i

/** The characters a stripped title may not begin or end with. */
const TRIM_EDGES = /^[\s.\-_–—]+|[\s.\-_–—]+$/gu

/** One recording file, as the panel receives it from the directory listing. */
export interface RecordingFile {
  /** Basename including the extension. */
  readonly name: string
  /** Path relative to the module root, `/`-joined. */
  readonly path: string
}

/** One lecture: a title, and the one or more files it is recorded across. */
export interface LectureUnit {
  /** Student-facing title, carrying no chunk number. */
  readonly title: string
  /** The unit's files, in part order. */
  readonly sources: readonly RecordingFile[]
  /** A transcript for this title already exists under `Transcripts/`. */
  readonly transcribed: boolean
  /** Every recording source is in NotebookLM and no local copy remains. */
  readonly inNotebookOnly: boolean
}

/**
 * Return the basename without the final extension.
 * @param name - filename or path basename.
 * @returns the name without its final extension.
 */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * Split a recording stem into its lecture title and part number.
 * @param stem - the filename without its extension.
 * @returns the title, and the part number when the stem carries one.
 */
export function partSplit(stem: string): { base: string; part: number | undefined } {
  stem = stem.replace(/((?:part|pt|ch|chapter|جزء|الجزء)\s*\.?\s*\d{1,2})(?:\s*[-–—:]\s*.+)$/i, '$1')
  const match = PART_SUFFIX.exec(stem)
  if (match === null) return { base: stem, part: undefined }
  const base = stem.slice(0, match.index).replace(TRIM_EDGES, '')
  // The whole stem was a number. There is no title to group under.
  if (base.length === 0) return { base: stem, part: undefined }
  return { base, part: Number(match[1]) }
}

const COHORT_SUFFIX = /\s+(boys|girls|بنين|بنات)$/i
const COHORT_ORDER = { boys: 0, girls: 1, unknown: 2 } as const

function recordingIdentity(stem: string): { base: string; cohort: keyof typeof COHORT_ORDER; part: number | undefined } {
  const { base, part } = partSplit(stem)
  const match = COHORT_SUFFIX.exec(base)
  if (match === null) return { base, cohort: 'unknown', part }
  const label = match[0].trim().toLowerCase()
  return { base: base.slice(0, match.index).trim(), cohort: label === 'boys' || label === 'بنين' ? 'boys' : 'girls', part }
}

/**
 * Group cohort recordings and their numbered parts into one lecture.
 * Boys precede girls, followed by recordings without a cohort; each cohort's
 * numbered parts precede unnumbered files. A lone uncohorted part keeps its title.
 * @param files - the module's recording files, in listing order.
 * @returns one unit per lecture, in first-seen order, each not yet classified.
 */
export function groupRecordings(
  files: readonly RecordingFile[],
): Omit<LectureUnit, 'transcribed' | 'inNotebookOnly'>[] {
  const groups = new Map<string, { cohort: keyof typeof COHORT_ORDER; part: number | undefined; file: RecordingFile }[]>()
  for (const file of files) {
    const { base, cohort, part } = recordingIdentity(stemOf(file.name))
    const key = caseFold(base)
    const members = groups.get(key)
    if (members === undefined) groups.set(key, [{ cohort, part, file }])
    else members.push({ cohort, part, file })
  }

  return [...groups.values()].map((members) => {
    members.sort((a, b) => COHORT_ORDER[a.cohort] - COHORT_ORDER[b.cohort]
      || (a.part ?? Infinity) - (b.part ?? Infinity)
      || (a.file.name < b.file.name ? -1 : a.file.name > b.file.name ? 1 : 0))
    const [first] = members
    /* v8 ignore next -- each group is created with its first member. */
    if (first === undefined) throw new Error('transcriber-workspace: empty recording group')
    const stem = stemOf(first.file.name)
    return {
      title: members.length > 1 || first.cohort !== 'unknown' ? recordingIdentity(stem).base : stem,
      sources: members.map(member => member.file),
    }
  })
}

/**
 * The transcript stems that mark a lecture done, from a `Transcripts/` listing.
 * @param names - basenames of the files directly under `Transcripts/`.
 * @returns the lowercased stems of the Markdown files that are transcripts.
 */
export function transcriptStems(names: readonly string[]): string[] {
  return names
    .filter(name => extensionOf(name) === '.md')
    .map(name => stemOf(name).toLowerCase())
    .filter(stem => !NON_TRANSCRIPT_STEMS.has(stem))
}

/**
 * Normalize a lecture or transcript title for matching.
 * @param title - title or transcript stem to normalize.
 * @returns the normalized title key.
 */
function matchKey(title: string): string {
  return caseFold(title.normalize('NFKC'))
    .replace(MATCH_SYMBOLS, '')
    .replace(ORDINAL_PREFIX, '')
    .replace(MATCH_SEPARATORS, ' ')
    .trim()
}

/**
 * Match a decorated transcript or run title to the lecture title it names.
 * @param candidate - transcript or run title, which may carry decoration.
 * @param lectureTitle - title derived from the recording names.
 * @returns whether the candidate names the lecture after title normalization.
 */
export function titleContainsLecture(candidate: string, lectureTitle: string): boolean {
  const candidateKey = matchKey(candidate)
  const lectureKey = matchKey(lectureTitle)
  return lectureKey.length > 0 && (
    candidateKey === lectureKey
    || candidateKey.startsWith(`${lectureKey} `)
    || lectureKey.length >= 6 && candidateKey.startsWith(lectureKey)
  )
}

/**
 * Finished transcripts whose recording is no longer under `Lecture/`.
 *
 * A recording is often deleted once its transcript exists — the audio is large
 * and the transcript is the deliverable. Listing only what can still be
 * transcribed then hides the finished work: a module whose recordings are all
 * gone answers "no lectures" while its transcripts sit right there, which is
 * the opposite of what the panel is for.
 *
 * They come back with no `sources`, which is also what keeps them from being
 * offered as something to transcribe: there is no audio to run a pipeline over.
 * @param names - basenames of the files directly under `Transcripts/`.
 * @param unclaimed - lowercased transcript stems no lecture title matched.
 * @returns one finished unit per unclaimed transcript, in listing order.
 */
function orphanTranscripts(
  names: readonly string[],
  unclaimed: ReadonlySet<string>,
): LectureUnit[] {
  return names
    .filter(name => unclaimed.has(stemOf(name).toLowerCase()))
    .map(name => ({ title: stemOf(name), sources: [], transcribed: true, inNotebookOnly: false }))
}

/**
 * The module's lectures, each marked with whether it is already transcribed.
 *
 * The match uses normalized keys because a finished transcript can carry
 * decoration the recording does not: `مراجعه اشعه 🩻.md` is the transcript of
 * `مراجعه اشعه.m4a`. Exact keys, space-delimited prefixes, and the guarded
 * long-key prefix are all claims, so a transcript that a recording already
 * accounts for is not listed a second time on its own.
 * @param files - every recording file under `Lecture/`, recursively.
 * @param transcripts - basenames of the files directly under `Transcripts/`.
 * @returns the lecture units, classified, finished-without-audio ones last.
 */
export function lecturesOf(
  files: readonly RecordingFile[],
  transcripts: readonly string[],
): LectureUnit[] {
  const done = transcriptStems(transcripts)
  const claimed = new Set<string>()
  const lectures: LectureUnit[] = []
  for (const unit of groupRecordings(files)) {
    const matched = done.filter(stem => titleContainsLecture(stem, unit.title))
    for (const stem of matched) claimed.add(stem)
    lectures.push({ ...unit, transcribed: matched.length > 0, inNotebookOnly: false })
  }
  const unclaimed = new Set(done.filter(stem => !claimed.has(stem)))
  return [...lectures, ...orphanTranscripts(transcripts, unclaimed)]
}
