/**
 * Open notes and what has happened to each: read, edited, saved, or caught
 * between the student's edit and a change on disk.
 *
 * A transcript is also the engine's file: a finalize, a figure extraction or
 * another window can rewrite it while it is open. Every save therefore
 * carries the version the editor last read, and the host refuses a save whose
 * version is stale. The student then chooses — reload theirs away, or keep
 * theirs over the disk's — and nothing is ever overwritten silently.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** A file read for editing. */
export interface NoteFileText {
  readonly absolutePath: string
  readonly version: string
  readonly text: string
}

/** An outcome the panel can draw. */
export type NoteOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly conflict?: boolean; readonly message: string }

/** The file calls the editor makes; the transcriber-engine Remote satisfies them. */
export interface NoteFiles {
  readonly read: (path: string, signal: AbortSignal) => Promise<NoteOutcome<NoteFileText>>
  readonly readBytes: (path: string, relativeTo: string | undefined, signal: AbortSignal) => Promise<NoteOutcome<Uint8Array>>
  readonly write: (
    path: string, text: string, expectedVersion: string, signal: AbortSignal,
  ) => Promise<NoteOutcome<{ readonly version: string }>>
}

/** Where a note stands with respect to the file on disk. */
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed'

/** One open note. */
export interface OpenNote {
  readonly path: string
  readonly status: 'loading' | 'ready' | 'failed'
  /** The editor's text; the document of record while the note is open. */
  readonly text: string
  /** The disk version that text was last reconciled with. */
  readonly version: string
  readonly save: SaveState
  readonly message?: string
}

/** The panel's state: open notes in tab order, and the active one. */
export interface NotesState {
  readonly notes: readonly OpenNote[]
  readonly active?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Open workspace markdown files and their saving. */
    notes: NoteService
  }
}

/** The file's name without its folders. */
export function baseName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path
}

/** Owns the open notes. */
export class NoteService extends Service {
  readonly state: SnapshotStore<NotesState>
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - client root context.
   * @param files - file access.
   * @param autosaveMs - idle time after an edit before it is saved.
   */
  constructor(ctx: Context, readonly files: NoteFiles, private readonly autosaveMs: number) {
    super(ctx, 'notes')
    this.state = createSnapshotStore<NotesState>({ notes: [] })
    ctx.effect(() => () => {
      this.lifetime.abort()
      for (const timer of this.timers.values()) clearTimeout(timer)
    }, 'ui-note: pending saves')
  }

  /**
   * Open a note, or bring it forward when it is already open.
   * @param path - absolute workspace path.
   */
  async open(path: string): Promise<void> {
    const existing = this.note(path)
    this.patch({ active: path })
    if (existing !== undefined && existing.status !== 'failed') return
    if (existing === undefined) {
      this.setNotes([...this.state.getSnapshot().notes, { path, status: 'loading', text: '', version: '', save: 'saved' }])
    }
    await this.load(path)
  }

  /**
   * Close a note; an unsaved edit is saved first.
   * @param path - the note.
   */
  async close(path: string): Promise<void> {
    if (this.note(path)?.save === 'dirty') await this.flush(path)
    const notes = this.state.getSnapshot().notes
    const index = notes.findIndex(note => note.path === path)
    const remaining = notes.filter(note => note.path !== path)
    const active = this.state.getSnapshot().active === path
      ? remaining[Math.min(index, remaining.length - 1)]?.path
      : this.state.getSnapshot().active
    this.state.set({ notes: remaining, ...active === undefined ? {} : { active } })
  }

  /**
   * Make an open note the visible one.
   * @param path - the note.
   */
  activate(path: string): void {
    if (this.note(path) !== undefined) this.patch({ active: path })
  }

  /**
   * Record an edit and schedule its save.
   * @param path - the note.
   * @param text - the whole new text.
   */
  edit(path: string, text: string): void {
    const note = this.note(path)
    if (note === undefined || note.status !== 'ready' || note.text === text) return
    this.update(path, { text, save: note.save === 'conflict' ? 'conflict' : 'dirty' })
    if (note.save === 'conflict') return
    const pending = this.timers.get(path)
    if (pending !== undefined) clearTimeout(pending)
    this.timers.set(path, setTimeout(() => { void this.flush(path) }, this.autosaveMs))
  }

  /**
   * Save now.
   * @param path - the note.
   */
  async flush(path: string): Promise<void> {
    const pending = this.timers.get(path)
    if (pending !== undefined) clearTimeout(pending)
    this.timers.delete(path)
    const note = this.note(path)
    if (note === undefined || note.save !== 'dirty') return
    this.update(path, { save: 'saving' })
    const result = await this.files.write(path, note.text, note.version, this.lifetime.signal)
    const current = this.note(path)
    if (current === undefined) return
    if (result.ok) {
      // An edit typed while the save was in flight stays dirty and saves next.
      this.update(path, { version: result.value.version, save: current.text === note.text ? 'saved' : 'dirty' })
      if (current.text !== note.text) this.timers.set(path, setTimeout(() => { void this.flush(path) }, this.autosaveMs))
      return
    }
    this.update(path, { save: result.conflict === true ? 'conflict' : 'failed', message: result.message })
  }

  /**
   * Resolve a conflict by taking the disk's version and dropping the edit.
   * @param path - the note.
   */
  async reload(path: string): Promise<void> {
    await this.load(path)
  }

  /**
   * Resolve a conflict by writing the editor's text over the disk's.
   * @param path - the note.
   */
  async keepMine(path: string): Promise<void> {
    const note = this.note(path)
    if (note === undefined) return
    const disk = await this.files.read(path, this.lifetime.signal)
    if (!disk.ok) {
      this.update(path, { save: 'failed', message: disk.message })
      return
    }
    this.update(path, { version: disk.value.version, save: 'dirty' })
    await this.flush(path)
  }

  /** The open note at a path. */
  note(path: string): OpenNote | undefined {
    return this.state.getSnapshot().notes.find(note => note.path === path)
  }

  private async load(path: string): Promise<void> {
    const result = await this.files.read(path, this.lifetime.signal)
    if (this.note(path) === undefined) return
    if (!result.ok) {
      this.update(path, { status: 'failed', message: result.message })
      return
    }
    this.update(path, {
      status: 'ready',
      text: result.value.text,
      version: result.value.version,
      save: 'saved',
    })
  }

  private update(path: string, patch: Partial<OpenNote>): void {
    this.setNotes(this.state.getSnapshot().notes.map((note) => {
      if (note.path !== path) return note
      const next: OpenNote = { ...note, ...patch }
      if (patch.message === undefined && patch.save !== undefined && patch.save !== 'failed' && patch.save !== 'conflict') {
        const { message: _drop, ...rest } = next
        return rest
      }
      return next
    }))
  }

  private setNotes(notes: readonly OpenNote[]): void {
    this.state.set({ ...this.state.getSnapshot(), notes })
  }

  private patch(partial: Partial<NotesState>): void {
    this.state.set({ ...this.state.getSnapshot(), ...partial })
  }
}
