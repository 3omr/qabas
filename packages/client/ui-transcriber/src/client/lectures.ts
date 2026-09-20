/**
 * What counts as a lecture, and which lectures are done.
 *
 * This is a deliberate port of the rule in
 * `skills/universal-transcriber/scripts/mcp_server.py`, not an independent
 * design: the panel and the engine must agree on what a lecture is, or the
 * panel offers a unit the engine will not run. The port exists because the
 * panel redraws from the workspace listing directly, with no Python in the
 * loop — a sidebar that could only refresh by starting a subprocess would be
 * a sidebar that mostly shows stale state.
 *
 * `tests/fixtures/lecture-grouping.json` is shared with the Python suite, so
 * the two implementations are checked against one set of cases and a change
 * to either side that the other does not follow fails both.
 */

/**
 * Audio and video the pipeline can transcribe.
 *
 * Slides and papers live in the same folder and must never be offered as a
 * lecture to transcribe.
 */
export const RECORDING_EXTENSIONS: ReadonlySet<string> = new Set([
  '.m4a', '.mp3', '.wav', '.aac', '.ogg', '.mp4', '.mkv', '.webm', '.avi', '.mov',
])

/**
 * `Transcripts/` holds finished transcripts plus `Index.md`, which lists them.
 * The index is a deliverable, not a transcript, and must not mark a lecture done.
 */
const NON_TRANSCRIPT_STEMS: ReadonlySet<string> = new Set(['index'])

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
 * Return a filename's lowercase final extension.
 * @param name - filename or path basename.
 * @returns the lowercase extension, including its dot, or an empty string.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Split a recording stem into its lecture title and part number.
 * @param stem - the filename without its extension.
 * @returns the title, and the part number when the stem carries one.
 */
export function partSplit(stem: string): { base: string; part: number | undefined } {
  const match = PART_SUFFIX.exec(stem)
  if (match === null) return { base: stem, part: undefined }
  const base = stem.slice(0, match.index).replace(TRIM_EDGES, '')
  // The whole stem was a number. There is no title to group under.
  if (base.length === 0) return { base: stem, part: undefined }
  return { base, part: Number(match[1]) }
}

/**
 * Group a module's recordings into lecture units.
 *
 * A lecture split across files is one lecture and one run — the skill is
 * explicit that "Part 1" and "Part 2" are a single unit. Listing them
 * separately would invite two runs over halves of one lecture.
 *
 * Grouping applies only when two or more files actually share a base, which is
 * what keeps a lone "food poisoning (1).mp3" from being silently retitled:
 * with nothing to group with, its own stem stays the title.
 * @param files - the module's recording files, in listing order.
 * @returns one unit per lecture, in first-seen order, each not yet classified.
 */
export function groupRecordings(files: readonly RecordingFile[]): Omit<LectureUnit, 'transcribed'>[] {
  const groups = new Map<string, { part: number | undefined; file: RecordingFile }[]>()
  for (const file of files) {
    const { base, part } = partSplit(stemOf(file.name))
    const key = base.toLowerCase()
    const members = groups.get(key)
    if (members === undefined) groups.set(key, [{ part, file }])
    else members.push({ part, file })
  }

  return [...groups.values()].map((members) => {
    // A group exists only because its first member was pushed into it, so the
    // destructure is total; it is written this way so the compiler can see that
    // rather than being told with an assertion.
    const [first, ...rest] = members
    if (first === undefined) throw new Error('ui-transcriber: empty recording group')
    if (rest.length === 0) {
      return { title: stemOf(first.file.name), sources: [first.file] }
    }
    const ordered = [...members].sort((left, right) => {
      // A file with no part marker sorts after every numbered one; two of them
      // fall back to filename order, as does a tie on the same part number.
      if ((left.part === undefined) !== (right.part === undefined)) return left.part === undefined ? 1 : -1
      if (left.part !== undefined && right.part !== undefined && left.part !== right.part) {
        return left.part - right.part
      }
      return left.file.name < right.file.name ? -1 : left.file.name > right.file.name ? 1 : 0
    })
    const [lead] = ordered
    if (lead === undefined) throw new Error('ui-transcriber: empty recording group')
    return {
      title: partSplit(stemOf(lead.file.name)).base,
      sources: ordered.map(member => member.file),
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
 * Match a decorated transcript or run title to the lecture title it names.
 * @param candidate - transcript or run title, which may carry decoration.
 * @param lectureTitle - title derived from the recording names.
 * @returns whether the candidate contains the lecture title.
 */
export function titleContainsLecture(candidate: string, lectureTitle: string): boolean {
  return candidate.toLowerCase().includes(lectureTitle.toLowerCase())
}

/**
 * The module's lectures, each marked with whether it is already transcribed.
 *
 * The match is a containment rather than an equality because a finished
 * transcript carries decoration the recording does not: `مراجعه اشعه 🩻.md` is
 * the transcript of `مراجعه اشعه.m4a`.
 * @param files - every recording file under `Lecture/`, recursively.
 * @param transcripts - basenames of the files directly under `Transcripts/`.
 * @returns the lecture units, classified.
 */
export function lecturesOf(
  files: readonly RecordingFile[],
  transcripts: readonly string[],
): LectureUnit[] {
  const done = transcriptStems(transcripts)
  return groupRecordings(files).map(unit => ({
    ...unit,
    transcribed: done.some(stem => titleContainsLecture(stem, unit.title)),
  }))
}
