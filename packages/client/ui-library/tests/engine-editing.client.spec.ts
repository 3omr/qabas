/** Lecture manager outcomes over engine Remote responses. */

import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote, RemoteResult, TranscriberUploadRecordingsResult } from '@deepseek-ai/dsh-api-remotes/client'
import { editingAdapter, engineEditing, engineSetup } from '../src/client/engine-editing.ts'

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
  it('offers optional hide and restore calls and retains the hidden inventory flag', async () => {
    const base = remote()
    expect('hideLecture' in editingAdapter(base)).toBe(false)
    expect('restoreRecordings' in editingAdapter(base)).toBe(false)
    const engine = { ...base,
      listModuleFiles: vi.fn(async () => ok({ module: 'toxo', files: [{ path: 'Lecture/Shock.m4a', name: 'Shock.m4a', kind: 'recording' as const,
        size_bytes: 4, lectures: [], in_notebook: false, hidden: true }] })),
      hideLecture: vi.fn(async () => ok({ module: 'toxo', recordings: ['Shock.m4a'] })),
      restoreRecordings: vi.fn(async () => ok({ module: 'toxo', recordings: ['Shock.m4a'] })),
    }
    const editing = editingAdapter(engine)
    expect(await editing.hideLecture?.('toxo', 'Shock')).toEqual(ok(['Shock.m4a']))
    expect(engine.hideLecture).toHaveBeenCalledWith({ module: 'toxo', title: 'Shock' })
    expect(await editing.restoreRecordings?.('toxo', ['Shock.m4a'])).toEqual(ok(['Shock.m4a']))
    expect(engine.restoreRecordings).toHaveBeenCalledWith({ module: 'toxo', recordings: ['Shock.m4a'] })
    expect(await editing.listFiles('toxo')).toEqual(ok([{ path: 'Lecture/Shock.m4a', name: 'Shock.m4a', kind: 'recording', size: 4, hidden: true, inNotebook: false }]))
    engine.hideLecture.mockRejectedValueOnce(new Error('restore_recordings required'))
    expect(await editing.hideLecture?.('toxo', 'Shock')).toEqual({ ok: false, message: 'restore_recordings required' })
  })

  it('takes a lecture\'s recordings out of the trash before defining it', async () => {
    const lecture = { title: 'Shock', recordings: ['Shock.m4a'], materials: [] }
    const engine = { ...remote(), restoreRecordings: vi.fn(async () => ok({ module: 'toxo', recordings: ['Shock.m4a'] })) }
    expect(await editingAdapter(engine).define('toxo', lecture)).toEqual(ok({ id: 'shock' }))
    expect(engine.restoreRecordings).toHaveBeenCalledWith({ module: 'toxo', recordings: ['Shock.m4a'] })
    expect(engine.restoreRecordings.mock.invocationCallOrder[0]).toBeLessThan(engine.defineLecture.mock.invocationCallOrder[0] ?? 0)
  })

  it('maps transcript trash and module archives, retaining refusal messages and optional availability', async () => {
    const paths = ['Transcripts/Shock.md', 'Transcripts/Figures/Shock']
    const change = { module: 'toxo', id: 'entry', paths }
    const engine = { ...remote(),
      removeTranscript: vi.fn(async () => ok(change)),
      listTrash: vi.fn(async () => ok([{ id: 'entry', removed_at: '2030-01-01T00:00:00Z', kind: 'transcript' as const, label: 'Shock', paths }])),
      restoreTrash: vi.fn(async () => ok(change)),
      workspace: vi.fn(async () => ok({ path: '/home/student/Qabas Library', source: 'default' as const, exists: true, modules: 1 })),
      createModule: vi.fn(async () => ok('created')),
      removeModule: vi.fn(async () => ok({ module: 'toxo', trash_id: 'toxo--archive', notebook_untouched: true })),
      restoreModule: vi.fn(async () => ok({ module: 'toxo', notebook_untouched: true })),
      listRemovedModules: vi.fn(async () => ok([{ module: 'toxo', trash_id: 'toxo--archive', display_name: 'Toxo', removed_at: '2030-01-01T00:00:00Z' }])),
    }
    const editing = editingAdapter(engine)
    const setup = engineSetup(engine)
    expect(await editing.removeTranscript?.('toxo', 'Shock', ['final', 'draft'])).toEqual(ok({ id: 'entry', paths }))
    expect(engine.removeTranscript).toHaveBeenCalledWith({ module: 'toxo', lecture: 'Shock', kinds: ['final', 'draft'] })
    expect(await editing.listTrash?.('toxo')).toEqual(ok([{ id: 'entry', removedAt: '2030-01-01T00:00:00Z', kind: 'transcript', label: 'Shock', paths }]))
    expect(await editing.restoreTrash?.('toxo', 'entry')).toEqual(ok({ id: 'entry', paths }))
    expect(engine.restoreTrash).toHaveBeenCalledWith({ module: 'toxo', id: 'entry' })
    expect(await setup?.removeModule?.('toxo')).toEqual(ok({ module: 'toxo', trashId: 'toxo--archive', notebookUntouched: true }))
    expect(engine.removeModule).toHaveBeenCalledWith({ module: 'toxo' })
    expect(await setup?.restoreModule?.('toxo--archive')).toEqual(ok({ module: 'toxo', notebookUntouched: true }))
    expect(engine.restoreModule).toHaveBeenCalledWith({ trashId: 'toxo--archive' })
    expect(await setup?.listRemovedModules?.()).toEqual(ok([{ module: 'toxo', trashId: 'toxo--archive', displayName: 'Toxo', removedAt: '2030-01-01T00:00:00Z' }]))
    for (const name of ['removeTranscript', 'listTrash', 'restoreTrash'] as const) expect(editingAdapter(remote())[name]).toBeUndefined()
    expect(engineSetup({ workspace: engine.workspace, createModule: engine.createModule })?.removeModule).toBeUndefined()
    engine.restoreTrash.mockRejectedValueOnce(new Error('Destination already occupied: Transcripts/Shock.md'))
    expect(await editing.restoreTrash?.('toxo', 'entry')).toEqual({ ok: false, message: 'Destination already occupied: Transcripts/Shock.md' })
    engine.removeModule.mockRejectedValueOnce(new Error('Module is busy with a running job'))
    expect(await setup?.removeModule?.('toxo')).toEqual({ ok: false, message: 'Module is busy with a running job' })
  })

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
    expect(engine.importFile).toHaveBeenCalledWith({ module: 'toxo', name: 'Original.amr', kind: 'recording', bytes: 'AP8BgA==' }, undefined)
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

  it('maps optional proposals, saves reviewed ids, and builds the question index', async () => {
    const engine = { ...remote(),
      proposeOrganization: vi.fn(async () => ok({ source: 'automatic' as const, lectures: [
        { title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'], existing_id: 'shock', change: 'changed' as const },
        { title: 'New', recordings: ['New.mp3'], materials: [], change: 'new' as const },
      ], unassigned: { recordings: ['Spare.mp3'], materials: ['Book.pdf'] }, notes: ['agy unavailable'] })),
      applyOrganization: vi.fn(async () => ok({ module: 'toxo', lectures: [definition] })),
      buildExamIndex: vi.fn(async () => ok({ output: '12 questions' })),
    }
    const questionIndexBuilt = vi.fn()
    const editing = editingAdapter(engine, { questionIndexBuilt })
    expect(await editing.propose?.('toxo', true)).toEqual(ok({ source: 'automatic', lectures: [
      { title: 'Shock', recordings: ['Shock.m4a'], materials: ['Shock.pdf'], existingId: 'shock', change: 'changed' },
      { title: 'New', recordings: ['New.mp3'], materials: [], change: 'new' },
    ], unassigned: { recordings: ['Spare.mp3'], materials: ['Book.pdf'] }, notes: ['agy unavailable'] }))
    expect(engine.proposeOrganization).toHaveBeenCalledWith({ module: 'toxo', refresh: true })
    expect(await editing.applyProposal?.('toxo', [definition], false)).toEqual(ok(null))
    expect(engine.applyOrganization).toHaveBeenCalledWith({ module: 'toxo', lectures: [definition], replaceExisting: false })
    expect(await editing.buildQuestionIndex?.('toxo')).toEqual(ok(null))
    expect(questionIndexBuilt).toHaveBeenCalledWith('toxo')
    expect('propose' in editingAdapter(remote())).toBe(false)
    expect('applyProposal' in editingAdapter(remote())).toBe(false)
    expect('buildQuestionIndex' in editingAdapter(remote())).toBe(false)
  })

  it('refreshes file presence only for the module whose recordings were uploaded', async () => {
    const engine = remote()
    const notebookChanged = vi.fn()
    const editing = editingAdapter(engine, { notebookChanged })
    await editing.upload('toxo', ['Lecture/Shock.m4a'])
    expect(notebookChanged).toHaveBeenCalledWith('toxo')
    await editing.listFiles('other')
    expect(engine.listModuleFiles).toHaveBeenLastCalledWith({ module: 'other' })
    await editing.listFiles('toxo')
    expect(engine.listModuleFiles).toHaveBeenLastCalledWith({ module: 'toxo', refresh: true })
  })

  it('requires the entire editing API before providing the manager', () => {
    expect(engineEditing(remote() as unknown as ClientRemote['transcriberEngine'])).toBeDefined()
    expect(engineEditing({ ...remote(), removeFile: undefined } as unknown as ClientRemote['transcriberEngine'])).toBeUndefined()
  })

  it('marks module-wide sources and sets them through the engine', async () => {
    const engine = {
      ...remote(),
      listModuleFiles: vi.fn(async () => ok({ module: 'toxo', files: [
        { path: 'Lecture/Book.pdf', name: 'Book.pdf', size_bytes: 9, kind: 'material' as const, lectures: [], in_notebook: true, general: true },
      ] })),
      setGeneralMaterials: vi.fn(async () => ok({ module: 'toxo', general_materials: ['Book.pdf'] })),
      applyOrganization: vi.fn(async () => ok({ module: 'toxo', lectures: [] })),
      proposeOrganization: vi.fn(async () => ok({ source: 'agy' as const, lectures: [], unassigned: { recordings: [], materials: [] }, notes: [], general: ['Book.pdf'] })),
    }
    const editing = editingAdapter(engine)
    expect(await editing.listFiles('toxo')).toEqual(ok([{ path: 'Lecture/Book.pdf', name: 'Book.pdf', size: 9, kind: 'material', inNotebook: true, general: true }]))
    expect(await editing.setGeneral?.('toxo', ['Book.pdf'])).toEqual(ok(null))
    expect(engine.setGeneralMaterials).toHaveBeenCalledWith({ module: 'toxo', materials: ['Book.pdf'] })
    expect((await editing.propose?.('toxo', false)) as unknown).toMatchObject({ ok: true, value: { general: ['Book.pdf'] } })
    await editing.applyProposal?.('toxo', [], false, ['Book.pdf'])
    expect(engine.applyOrganization).toHaveBeenLastCalledWith({ module: 'toxo', lectures: [], replaceExisting: false, general: ['Book.pdf'] })
    await editing.applyProposal?.('toxo', [], false)
    expect(engine.applyOrganization).toHaveBeenLastCalledWith({ module: 'toxo', lectures: [], replaceExisting: false })
  })
})
