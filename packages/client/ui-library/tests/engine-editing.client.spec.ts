/** Lecture manager outcomes over engine Remote responses. */

import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote, RemoteResult, TranscriberUploadRecordingsResult } from '@deepseek-ai/dsh-api-remotes/client'
import { editingAdapter, engineEditing } from '../src/client/engine-editing.ts'

const ok = <T>(value: T) => ({ ok: true as const, value })
const definition = { id: 'shock', title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'], created: 'today', updated: 'today' }
const uploadFile = { name: 'Shock.m4a', path: 'Lecture/Shock.m4a', size_bytes: 4, size_mb: 0, ready: true, source_id: 'source' }
function remote() {
  return {
    listModuleFiles: vi.fn(async () => ok({ module: 'toxo', warning: 'offline', files: [
      { path: 'Lecture/Shock.m4a', name: 'Shock.m4a', size_bytes: 4, kind: 'recording' as const,
        lectures: [{ id: 'shock', title: 'Shock', origin: 'manual' as const }, { id: 'shared', title: 'Shared', origin: 'manual' as const }], in_notebook: null },
      { path: 'Questions/Exam.pdf', name: 'Exam.pdf', size_bytes: 10, kind: 'question' as const, lectures: [], in_notebook: true },
    ] })),
    defineLecture: vi.fn(async () => ok(definition)),
    deleteLecture: vi.fn(async () => ok({ deleted: 'shock' })),
    importFile: vi.fn(async () => ok({ path: 'Lecture/Converted.m4a', kind: 'recording' as const, size_bytes: 4 })),
    renameFile: vi.fn(async () => ok({ path: 'Lecture/New.m4a' })),
    removeFile: vi.fn(async () => ok({ trash_path: '.transcriber-cache/trash/Shock.m4a' })),
    uploadRecordings: vi.fn<() => Promise<RemoteResult<TranscriberUploadRecordingsResult>>>(async () => ok({ module: 'toxo', notebook: { id: 'nb', title: 'Toxo' }, status: 'ready', next: 'Retry', files: [
      { ...uploadFile, status: 'uploaded' },
      { ...uploadFile, name: 'Old.m4a', status: 'already-uploaded' },
    ] })),
  }
}

describe('engine editing adapter', () => {
  it('maps module-relative inventory, first ownership, sizes, and notebook certainty', async () => {
    const editing = editingAdapter(remote())
    expect(await editing.listFiles('toxo')).toEqual(ok([
      { path: 'Lecture/Shock.m4a', name: 'Shock.m4a', size: 4, kind: 'recording', lecture: 'Shock', inNotebook: false },
      { path: 'Questions/Exam.pdf', name: 'Exam.pdf', size: 10, kind: 'question', inNotebook: true },
    ]))
  })

  it('forwards definitions and selected file edits, reporting only completed uploads', async () => {
    const engine = remote()
    const editing = editingAdapter(engine)
    const lecture = { id: 'shock', title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'] }
    expect(await editing.define('toxo', lecture)).toEqual(ok({ id: 'shock' }))
    expect(engine.defineLecture).toHaveBeenCalledWith({ module: 'toxo', ...lecture })
    expect(await editing.undefine('toxo', 'shock')).toEqual(ok(null))
    expect(engine.deleteLecture).toHaveBeenCalledWith({ module: 'toxo', id: 'shock' })
    expect(await editing.renameFile('toxo', 'Lecture/Shock.m4a', 'New.m4a')).toEqual(ok(null))
    expect(engine.renameFile).toHaveBeenCalledWith({ module: 'toxo', path: 'Lecture/Shock.m4a', new_name: 'New.m4a' })
    expect(await editing.trashFile('toxo', 'Lecture/Shock.m4a')).toEqual(ok(null))
    expect(engine.removeFile).toHaveBeenCalledWith({ module: 'toxo', path: 'Lecture/Shock.m4a' })
    expect(await editing.upload('toxo', ['Lecture/Shock.m4a', 'Lecture/Old.m4a'])).toEqual(ok({ uploaded: ['Shock.m4a'], already: ['Old.m4a'] }))
  })

  it('sends original browser bytes and displays the engine-converted file name', async () => {
    const engine = remote()
    const file = new File([new Uint8Array([0, 255, 1, 128])], 'Original.amr')
    expect(await editingAdapter(engine).importFile('toxo', file, 'recording')).toEqual(ok({
      path: 'Lecture/Converted.m4a', name: 'Converted.m4a', size: 4, kind: 'recording', inNotebook: false,
    }))
    expect(engine.importFile).toHaveBeenCalledWith({ module: 'toxo', name: 'Original.amr', kind: 'recording', bytes: 'AP8BgA==' })
  })

  it('counts a recording NotebookLM is still processing as uploaded', async () => {
    const engine = remote()
    engine.uploadRecordings.mockResolvedValueOnce(ok({ module: 'toxo', notebook: { id: 'nb', title: 'Toxo' }, status: 'processing', next: 'Retry',
      files: [{ ...uploadFile, ready: false, status: 'processing' }] }))
    expect(await editingAdapter(engine).upload('toxo', ['Lecture/Shock.m4a'])).toEqual(ok({ uploaded: ['Shock.m4a'], already: [] }))
  })

  it('turns transport rejections and typed engine refusals into page errors', async () => {
    const engine = remote()
    engine.listModuleFiles.mockRejectedValueOnce(new Error('Connection lost'))
    expect(await editingAdapter(engine).listFiles('toxo')).toEqual({ ok: false, message: 'Connection lost' })
    const rejected = { ...engine, deleteLecture: async () => ({ ok: false as const, error: new RemoteError('transcriber-engine/edit-rejected', 'Unknown lecture',
      { tool: 'delete_lecture', detail: 'Unknown lecture' }) }) }
    expect(await editingAdapter(rejected).undefine('toxo', 'missing')).toEqual({ ok: false, message: 'Unknown lecture' })
  })

  it('requires the entire editing API before providing the manager', () => {
    expect(engineEditing(remote() as unknown as ClientRemote['transcriberEngine'])).toBeDefined()
    expect(engineEditing({ ...remote(), removeFile: undefined } as unknown as ClientRemote['transcriberEngine'])).toBeUndefined()
  })
})
