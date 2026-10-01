/**
 * The note service against scripted files: opening, editing, autosaving, and
 * what happens when the disk changed underneath — the case a transcript that
 * is also the engine's file has to survive without losing either side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { baseName, NoteService, type NoteFiles, type NoteOutcome } from '../src/client/service.ts'

const PATH = '/w/modules/ophtha/Transcripts/Orbit 👁️.md'

interface Disk {
  text: string
  version: number
}

function files(disk: Disk, overrides: Partial<NoteFiles> = {}): NoteFiles {
  return {
    read: vi.fn(async (path: string) => ({
      ok: true,
      value: { absolutePath: path, version: String(disk.version), text: disk.text },
    }) as const),
    readBytes: vi.fn(async () => ({ ok: false, message: 'none' }) as const),
    write: vi.fn(async (_path: string, text: string, expected: string): Promise<NoteOutcome<{ version: string }>> => {
      if (expected !== String(disk.version)) return { ok: false, conflict: true, message: 'changed on disk' }
      disk.text = text
      disk.version += 1
      return { ok: true, value: { version: String(disk.version) } }
    }),
    ...overrides,
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('NoteService', () => {
  it('opens a note once and brings it forward when opened again', async () => {
    const disk = { text: '# Orbit', version: 1 }
    const source = files(disk)
    const notes = new NoteService(new Context(), source, 500)
    await notes.open(PATH)
    await notes.open('/w/b.md')
    await notes.open(PATH)
    expect(source.read).toHaveBeenCalledTimes(2)
    expect(notes.state.getSnapshot().active).toBe(PATH)
    expect(notes.note(PATH)).toMatchObject({ status: 'ready', text: '# Orbit', version: '1', save: 'saved' })
  })

  it('saves an edit after the idle delay, with the version it was read at', async () => {
    const disk = { text: 'a', version: 1 }
    const source = files(disk)
    const notes = new NoteService(new Context(), source, 500)
    await notes.open(PATH)
    notes.edit(PATH, 'ab')
    notes.edit(PATH, 'abc')
    expect(notes.note(PATH)?.save).toBe('dirty')
    await vi.advanceTimersByTimeAsync(500)
    expect(source.write).toHaveBeenCalledTimes(1)
    expect(source.write).toHaveBeenCalledWith(PATH, 'abc', '1', expect.anything())
    expect(notes.note(PATH)).toMatchObject({ save: 'saved', version: '2' })
    expect(disk.text).toBe('abc')
  })

  it('ignores an edit that changes nothing, or arrives for a note that is not ready', async () => {
    const source = files({ text: 'a', version: 1 })
    const notes = new NoteService(new Context(), source, 500)
    notes.edit(PATH, 'x')
    await notes.open(PATH)
    notes.edit(PATH, 'a')
    expect(notes.note(PATH)?.save).toBe('saved')
    await notes.flush(PATH)
    expect(source.write).not.toHaveBeenCalled()
  })

  it('keeps an edit typed during a save dirty, and saves it next', async () => {
    const disk = { text: 'a', version: 1 }
    let release: () => void = () => undefined
    const base = files(disk)
    const source = files(disk, {
      write: vi.fn((path: string, text: string, expected: string) => new Promise<NoteOutcome<{ version: string }>>((resolve) => {
        release = () => { void base.write(path, text, expected, new AbortController().signal).then(resolve) }
      })),
    })
    const notes = new NoteService(new Context(), source, 500)
    await notes.open(PATH)
    notes.edit(PATH, 'ab')
    const saving = notes.flush(PATH)
    expect(notes.note(PATH)?.save).toBe('saving')
    notes.edit(PATH, 'abc')
    release()
    await saving
    expect(notes.note(PATH)?.save).toBe('dirty')
    await vi.advanceTimersByTimeAsync(500)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(disk.text).toBe('abc')
  })

  it('stops at a conflict, and lets the student keep theirs or take the disk\'s', async () => {
    const disk = { text: 'a', version: 1 }
    const notes = new NoteService(new Context(), files(disk), 500)
    await notes.open(PATH)
    disk.text = 'engine'
    disk.version = 7
    notes.edit(PATH, 'mine')
    await notes.flush(PATH)
    expect(notes.note(PATH)).toMatchObject({ save: 'conflict', message: 'changed on disk' })
    // Further typing is kept but not saved over the disk while in conflict.
    notes.edit(PATH, 'mine!')
    expect(notes.note(PATH)?.save).toBe('conflict')
    await notes.keepMine(PATH)
    expect(disk.text).toBe('mine!')
    expect(notes.note(PATH)?.save).toBe('saved')
    expect(notes.note(PATH)?.message).toBeUndefined()

    disk.text = 'engine again'
    disk.version = 20
    notes.edit(PATH, 'mine again')
    await notes.flush(PATH)
    await notes.reload(PATH)
    expect(notes.note(PATH)).toMatchObject({ text: 'engine again', save: 'saved', version: '20' })
  })

  it('reports a save or a read that failed', async () => {
    const disk = { text: 'a', version: 1 }
    const notes = new NoteService(new Context(), files(disk, {
      write: async () => ({ ok: false, message: 'read-only' }),
    }), 500)
    await notes.open(PATH)
    notes.edit(PATH, 'b')
    await notes.flush(PATH)
    expect(notes.note(PATH)).toMatchObject({ save: 'failed', message: 'read-only' })

    const unreadable = new NoteService(new Context(), files(disk, {
      read: async () => ({ ok: false, message: 'gone' }),
    }), 500)
    await unreadable.open(PATH)
    expect(unreadable.note(PATH)).toMatchObject({ status: 'failed', message: 'gone' })
    await unreadable.keepMine(PATH)
    expect(unreadable.note(PATH)).toMatchObject({ save: 'failed', message: 'gone' })
    await unreadable.keepMine('/w/never-opened.md')
  })

  it('saves before closing, and moves to the neighbouring tab', async () => {
    const disk = { text: 'a', version: 1 }
    const notes = new NoteService(new Context(), files(disk), 500)
    await notes.open('/w/one.md')
    await notes.open(PATH)
    await notes.open('/w/three.md')
    notes.activate(PATH)
    notes.edit(PATH, 'closing edit')
    await notes.close(PATH)
    expect(disk.text).toBe('closing edit')
    expect(notes.state.getSnapshot().active).toBe('/w/three.md')
    notes.activate('/w/missing.md')
    expect(notes.state.getSnapshot().active).toBe('/w/three.md')
    await notes.close('/w/one.md')
    await notes.close('/w/three.md')
    expect(notes.state.getSnapshot()).toEqual({ notes: [] })
  })

  it('drops a read for a note closed while it loaded, and saves nothing after disposal', async () => {
    let release: () => void = () => undefined
    const disk = { text: 'a', version: 1 }
    const notes = new NoteService(new Context(), files(disk, {
      read: (path: string) => new Promise((resolve) => {
        release = () => { resolve({ ok: true, value: { absolutePath: path, version: '1', text: 'a' } }) }
      }),
    }), 500)
    const opening = notes.open(PATH)
    await notes.close(PATH)
    release()
    await opening
    expect(notes.note(PATH)).toBeUndefined()
    await notes.flush(PATH)
  })

  it('cancels pending saves when its context goes away', async () => {
    const disk = { text: 'a', version: 1 }
    const source = files(disk)
    const root = new Context()
    let notes: NoteService | undefined
    const fork = root.plugin({ apply(ctx: Context) { notes = new NoteService(ctx, source, 500) } })
    await vi.waitFor(() => { expect(notes).toBeDefined() })
    if (notes === undefined) return
    await notes.open(PATH)
    notes.edit(PATH, 'never saved')
    await fork.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(source.write).not.toHaveBeenCalled()
  })

  it('names a file by its last path segment', () => {
    expect(baseName(PATH)).toBe('Orbit 👁️.md')
    expect(baseName('C:\\w\\a.md')).toBe('a.md')
  })
})
