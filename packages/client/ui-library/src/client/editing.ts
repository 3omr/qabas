import type {
  TranscriberExamQuestionLocator as ApiExamQuestionLocator,
  TranscriberExamQuestionLocatorPart as ApiExamQuestionLocatorPart,
} from '@deepseek-ai/dsh-api-transcriber-engine/types'

/**
 * The student's hand on the library: define what a lecture is (its title, its
 * recordings in part order, its slides and books), manage the module's files,
 * and send recordings to NotebookLM. The engine guesses lectures from file
 * names; a definition made here always wins over the guess.
 *
 * The library only describes the calls it needs; whoever provides the engine
 * connection supplies them. Without them the library stays read-only.
 */

/** What a module file is to the engine. */
export type ModuleFileKind = 'recording' | 'material' | 'question'

/** One file under a module's Lecture/ or Questions/ folder. */
export interface ModuleFile {
  /** Original exam bytes, used to skip an identical upload. */
  readonly sha256?: string
  /** Whether this file belongs to the current completed exam index. */
  readonly indexed?: boolean
  /** Number of questions parsed from this indexed file. */
  readonly questionCount?: number
  /** Number of extracted questions that need a human source check. */
  readonly questionReviewCount?: number
  /** Persisted exam text readiness, refreshed from the original bytes. */
  readonly preparation?: 'pending' | 'ready' | 'failed'
  /** Diagnostic from the last exam reading attempt. */
  readonly preparationError?: string
  /** Retained for restore; hidden recordings are not unassigned lecture sources. */
  readonly hidden?: boolean
  /** Path relative to the module, e.g. `Lecture/Shock boys part 1.m4a`. */
  readonly path: string
  /** File name. */
  readonly name: string
  readonly kind: ModuleFileKind
  /** Size in bytes; absent for a recording that exists only in NotebookLM. */
  readonly size?: number
  /** Title of the lecture that uses it, when one does. */
  readonly lecture?: string
  /** The module's NotebookLM notebook already holds it. */
  readonly inNotebook: boolean
  /** A book or reference for the whole module rather than one lecture. */
  readonly general?: boolean
}

/** One source position returned for an extracted exam question. */
export type ExamQuestionLocatorPart = ApiExamQuestionLocatorPart

/** One or more source positions returned for an extracted exam question. */
export type ExamQuestionLocator = ApiExamQuestionLocator

/** One occurrence from an original exam file. */
export interface ExamQuestion {
  readonly id: string
  readonly number: number | null
  readonly kind: 'mcq' | 'written'
  readonly stem: string
  readonly options: Readonly<Record<string, string>>
  readonly answer: string | null
  readonly sourceAnswer: string | null
  readonly explanation: string
  readonly section: string
  readonly year: number | null
  readonly topic: string | null
  readonly locator: ExamQuestionLocator | null
  readonly needsReview: boolean
  readonly reviewReason: string | null
}

/** A page of extracted questions for one original exam file. */
export interface ExamQuestionsPage {
  readonly path: string
  readonly sha256: string
  readonly query: string
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly questions: readonly ExamQuestion[]
  readonly nextOffset: number | null
}

/** A lecture as the student defines it. */
export interface LectureDefinition {
  /** Present when editing an existing definition. */
  readonly id?: string
  readonly title: string
  /** Recording file names, in part order. */
  readonly recordings: readonly string[]
  /** Slides, books and notes explained in this lecture. */
  readonly materials: readonly string[]
}

/** A call's answer, reduced to what the page says. */
export type EditOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/** One lecture in an organization the engine proposes. */
export interface ProposedLecture {
  readonly title: string
  /** Recording file names, in part order. */
  readonly recordings: readonly string[]
  readonly materials: readonly string[]
  /** The student's definition this one would replace, when there is one. */
  readonly existingId?: string
  /** How it differs from what the module has now. */
  readonly change: 'new' | 'same' | 'changed'
}

/** How the engine (agy, or the file names when agy is not there) would organize a module. */
export interface OrganizationProposal {
  /** Who proposed it: agy read the files, or the engine grouped them by name. */
  readonly source: 'agy' | 'automatic'
  readonly lectures: readonly ProposedLecture[]
  /** Books and references proposed for the whole module. */
  readonly general?: readonly string[]
  /** Files the proposal leaves out of every lecture. */
  readonly unassigned: { readonly recordings: readonly string[]; readonly materials: readonly string[] }
  /** Why something was dropped or why agy was not used. */
  readonly notes: readonly string[]
}

/** Transcript output stages selectable for a reversible removal. */
export type TranscriptKind = 'final' | 'draft' | 'verbatim'

/** One module trash entry; paths remain relative to the module. */
export interface TrashEntry {
  readonly id: string
  readonly removedAt: string
  readonly kind: 'file' | 'transcript' | 'lecture'
  readonly label: string
  readonly paths: readonly string[]
}

/** Paths removed or restored under one trash identity. */
export interface TrashChange { readonly id: string; readonly paths: readonly string[] }

/** A whole module retained in the library's module trash. */
export interface RemovedModule {
  readonly trashId: string
  readonly module: string
  readonly displayName: string
  readonly removedAt: string
}

/** Whole-module removal retains its NotebookLM notebook and sources. */
export interface ModuleRemoval { readonly module: string; readonly trashId: string; readonly notebookUntouched: boolean }

/** Restored module and the unchanged NotebookLM state. */
export interface ModuleRestoration { readonly module: string; readonly notebookUntouched: boolean }

/** The calls the lecture manager makes. */
export interface LectureEditing {
  /**
   * Remove selected transcript stages to one reversible entry, refusing an active module.
   * @param module - owning module id.
   * @param title - lecture title or manual id.
   * @param kinds - non-empty selection of output stages.
   * @returns trash identity and module-relative paths, or an edit refusal.
   */
  removeTranscript?(module: string, title: string, kinds: readonly TranscriptKind[]): Promise<EditOutcome<TrashChange>>
  /**
   * List file, transcript and hidden-lecture entries, newest first.
   * @param module - owning module id.
   * @returns entries or an edit refusal.
   */
  listTrash?(module: string): Promise<EditOutcome<readonly TrashEntry[]>>
  /**
   * Restore an entry without overwriting any occupied destination.
   * @param module - owning module id.
   * @param id - trash entry identity.
   * @returns restored paths or an edit refusal.
   */
  restoreTrash?(module: string, id: string): Promise<EditOutcome<TrashChange>>
  listFiles(module: string): Promise<EditOutcome<readonly ModuleFile[]>>
  /** Create a lecture, or replace the definition with the same id. */
  define(module: string, lecture: LectureDefinition): Promise<EditOutcome<{ readonly id: string }>>
  /** Forget a definition; its files stay. */
  undefine(module: string, id: string): Promise<EditOutcome<null>>
  /**
   * Hide a lecture and its recordings without changing files, sources or transcripts.
   * @param module - owning module id.
   * @param title - lecture title, or manual id for an ambiguous title.
   * @returns hidden recording names or an edit refusal.
   */
  hideLecture?: (module: string, title: string) => Promise<EditOutcome<readonly string[]>>
  /**
   * Restore selected recording names without recreating their manual definition.
   * @param module - owning module id.
   * @param names - safe paths relative to Lecture/.
   * @returns names actually restored or an edit refusal.
   */
  restoreRecordings?(module: string, names: readonly string[]): Promise<EditOutcome<readonly string[]>>
  /** Copy a file the student picked into the module. */
  importFile(
    module: string, file: File, kind: ModuleFileKind,
    options?: { readonly name?: string; readonly replace?: boolean; readonly signal?: AbortSignal },
  ): Promise<EditOutcome<ModuleFile>>
  renameFile(module: string, path: string, name: string): Promise<EditOutcome<null>>
  /** Move a file to the module's trash; nothing is deleted for good. */
  trashFile(module: string, path: string): Promise<EditOutcome<null>>
  /** Ask for an organization of the whole module; `refresh` asks again instead of reusing the last one. */
  propose?(module: string, refresh: boolean): Promise<EditOutcome<OrganizationProposal>>
  /** Save the chosen lectures as definitions in one step. */
  applyProposal?(
    module: string, lectures: readonly LectureDefinition[], replaceExisting: boolean, general?: readonly string[],
  ): Promise<EditOutcome<null>>
  /** Make these the module's general sources (books, references); a lecture that had one gives it up. */
  setGeneral?(module: string, materials: readonly string[]): Promise<EditOutcome<null>>
  /**
   * Read one original paper into text using conversion or OCR when needed.
   * @param module - owning module id.
   * @param path - original file under Questions/.
   * @param signal - request cancellation.
   * @returns readiness or the diagnostic retained for retry.
   */
  prepareExamFile?(module: string, path: string, signal?: AbortSignal): Promise<EditOutcome<null>>
  /**
   * Prepare the papers and build their local index; OCR can use agy image reading.
   * @param module - owning module id.
   * @param signal - caller cancellation.
   * @returns completion or an engine refusal.
   */
  buildQuestionIndex?(module: string, signal?: AbortSignal): Promise<EditOutcome<null>>
  /**
   * Read one page of extracted source questions.
   * @param module - owning module id.
   * @param path - original file under Questions/.
   * @param offset - zero-based result offset.
   * @param limit - maximum questions to return.
   * @param query - optional text filter.
   * @param signal - request cancellation.
   * @returns question page or an edit refusal.
   */
  listExamQuestions?(
    module: string, path: string, offset: number, limit: number, query: string, signal?: AbortSignal,
  ): Promise<EditOutcome<ExamQuestionsPage>>
  /** Upload recordings to the module's NotebookLM notebook. */
  upload(module: string, files: readonly string[]): Promise<EditOutcome<{
    readonly uploaded: readonly string[]
    readonly already: readonly string[]
  }>>
}

/** Where the library lives on this machine. */
export interface WorkspaceInfo {
  /** Absolute folder holding `modules/`. */
  readonly path: string
  /** Developer override or the operating-system user's Qabas Library. */
  readonly source: 'env' | 'default'
  readonly exists: boolean
  /** Module folders under it. */
  readonly modules: number
}

/** The calls that set up a library: its folder, and its modules. */
export interface LibrarySetup {
  /**
   * Remove an idle module, retaining its notebook and sources.
   * @param module - existing module id.
   * @returns removal identity and NotebookLM guarantee, or an edit refusal.
   */
  removeModule?: (module: string) => Promise<EditOutcome<ModuleRemoval>>
  /**
   * Restore a whole module without replacing an occupied module id.
   * @param trashId - removed module identity.
   * @returns restored module or an edit refusal.
   */
  restoreModule?: (trashId: string) => Promise<EditOutcome<ModuleRestoration>>
  /**
   * List removed modules, newest first.
   * @returns removed modules or an edit refusal.
   */
  listRemovedModules?: () => Promise<EditOutcome<readonly RemovedModule[]>>
  workspace(): Promise<EditOutcome<WorkspaceInfo>>
  /** Create a module's folders and its NotebookLM notebook. */
  createModule: (id: string, displayName: string) => Promise<EditOutcome<string>>
}

/**
 * A folder name for a module, from the name the student typed: lowercase
 * Latin letters, digits and hyphens, which is what the engine accepts. An
 * Arabic name has no such letters; the student then types one.
 * @param name - the module's display name.
 * @returns the slug, possibly empty.
 */
export function moduleSlug(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
}

/** Audio and video a student gets from a recorder, Telegram or WhatsApp. */
const RECORDING = /\.(?:mp3|m4a|wav|aac|ogg|oga|opus|amr|webm|mp4|mkv|mov|flac)$/iu

/**
 * The kind a picked file is filed as, from its name.
 * @param name - file name.
 * @returns recording for audio and video, material otherwise.
 */
export function kindOfName(name: string): ModuleFileKind {
  return RECORDING.test(name) ? 'recording' : 'material'
}

/**
 * Check a definition before it is sent.
 * @param lecture - the draft definition.
 * @returns a reason it cannot be saved, or undefined.
 */
export function definitionProblem(lecture: LectureDefinition): 'title' | 'recordings' | undefined {
  if (lecture.title.trim() === '') return 'title'
  if (lecture.recordings.length === 0) return 'recordings'
  return undefined
}

/**
 * Move one entry of an ordered list.
 * @param list - current order.
 * @param index - entry to move.
 * @param by - -1 earlier, +1 later.
 * @returns the new order (the same list when the move falls off an end).
 */
export function moved<T>(list: readonly T[], index: number, by: -1 | 1): readonly T[] {
  const to = index + by
  if (to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item as T)
  return next
}

/**
 * A size a student reads.
 * @param bytes - size in bytes.
 * @returns e.g. "14.6 MB".
 */
export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The definition a lecture already has, or would get if pinned now.
 * @param lecture - a lecture as the library lists it.
 * @param lecture.id - its definition's id, when the student made one.
 * @param lecture.title - its title.
 * @param lecture.sources - its recordings in part order.
 * @param lecture.materials - its slides and books.
 * @returns the definition to edit.
 */
export function definitionOf(lecture: {
  readonly id?: string
  readonly title: string
  readonly sources: readonly string[]
  readonly materials?: readonly string[]
}): LectureDefinition {
  return {
    ...lecture.id === undefined ? {} : { id: lecture.id },
    title: lecture.title,
    recordings: lecture.sources,
    materials: lecture.materials ?? [],
  }
}

/**
 * Add a file to a lecture: a recording becomes its last part, a material joins its slides and books.
 * @param lecture - the definition.
 * @param file - the file dropped on it.
 * @param file.name - the file's name.
 * @param file.kind - what the file is.
 * @returns the new definition (the same one when the file is already there or cannot belong to a lecture).
 */
export function withFile(lecture: LectureDefinition, file: { readonly name: string; readonly kind: ModuleFileKind }): LectureDefinition {
  if (file.kind === 'recording') {
    return lecture.recordings.includes(file.name) ? lecture : { ...lecture, recordings: [...lecture.recordings, file.name] }
  }
  if (file.kind === 'material') {
    return lecture.materials.includes(file.name) ? lecture : { ...lecture, materials: [...lecture.materials, file.name] }
  }
  return lecture
}

/**
 * Take a file out of a lecture.
 * @param lecture - the definition.
 * @param name - the file's name.
 * @returns the new definition.
 */
export function withoutFile(lecture: LectureDefinition, name: string): LectureDefinition {
  return {
    ...lecture,
    recordings: lecture.recordings.filter(item => item !== name),
    materials: lecture.materials.filter(item => item !== name),
  }
}
