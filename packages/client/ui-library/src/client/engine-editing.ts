/** Translate session-free engine edits into the lecture manager's outcomes. */

import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { EditOutcome, LectureEditing } from './editing.ts'

type EditingRemote = Pick<ClientRemote['transcriberEngine'],
  'listModuleFiles' | 'defineLecture' | 'deleteLecture' | 'importFile' | 'renameFile' | 'removeFile' | 'uploadRecordings'>
  & Partial<Pick<ClientRemote['transcriberEngine'], 'proposeOrganization' | 'applyOrganization' | 'buildExamIndex'>>

interface EditingNotifications {
  readonly notebookChanged?: (module: string) => void
  readonly questionIndexBuilt?: (module: string) => void
}

function outcome<T, U>(response: RemoteResult<T>, map: (answer: T) => U): EditOutcome<U> {
  return response.ok ? { ok: true, value: map(response.value) } : { ok: false, message: response.error.message }
}

async function attempted<T>(run: () => Promise<EditOutcome<T>>): Promise<EditOutcome<T>> {
  try { return await run() } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Supply editing only when the mounted Remote includes the complete registry API.
 * @param remote - mounted transcriber engine namespace.
 * @param notifications - library invalidations after engine writes.
 * @returns the adapter, or undefined when this Host cannot manage lectures.
 */
export function engineEditing(remote: ClientRemote['transcriberEngine'], notifications: EditingNotifications = {}): LectureEditing | undefined {
  const methods = ['listModuleFiles', 'defineLecture', 'deleteLecture', 'importFile', 'renameFile', 'removeFile', 'uploadRecordings'] as const
  if (!methods.every(method => typeof remote[method] === 'function')) return undefined
  return editingAdapter(remote, notifications)
}

/**
 * Adapt engine results; thrown transport and file-read failures become page errors.
 * @param remote - complete session-free registry Remote.
 * @param notifications - library invalidations after engine writes.
 * @returns the library-owned editing callbacks.
 */
export function editingAdapter(remote: EditingRemote, notifications: EditingNotifications = {}): LectureEditing {
  const notebookChanged = new Set<string>()
  const proposeOrganization = remote.proposeOrganization?.bind(remote)
  const applyOrganization = remote.applyOrganization?.bind(remote)
  const buildExamIndex = remote.buildExamIndex?.bind(remote)
  return {
    ...proposeOrganization === undefined ? {} : {
      propose: (module: string, refresh: boolean) => attempted(async () => outcome(
        await proposeOrganization({ module, refresh }), answer => ({ source: answer.source,
          lectures: answer.lectures.map(({ existing_id: existingId, ...lecture }) => ({ ...lecture,
            ...existingId === undefined ? {} : { existingId } })), unassigned: answer.unassigned, notes: answer.notes }))),
    },
    ...applyOrganization === undefined ? {} : {
      applyProposal: (module: string, lectures: Parameters<NonNullable<LectureEditing['applyProposal']>>[1], replaceExisting: boolean) =>
        attempted(async () => outcome(await applyOrganization({ module, lectures, replaceExisting }), () => null)),
    },
    ...buildExamIndex === undefined ? {} : {
      buildQuestionIndex: (module: string) => attempted(async () => outcome(await buildExamIndex({ module }), () => {
        notifications.questionIndexBuilt?.(module)
        return null
      })),
    },
    listFiles: module => attempted(async () => {
      const refresh = notebookChanged.delete(module)
      return outcome(await remote.listModuleFiles({ module, ...refresh ? { refresh: true } : {} }), answer => answer.files.map(file => ({
        path: file.path, name: file.name, size: file.size_bytes, kind: file.kind,
        inNotebook: file.in_notebook === true,
        ...file.lectures[0] === undefined ? {} : { lecture: file.lectures[0].title },
      })))
    }),
    define: (module, lecture) => attempted(async () => outcome(
      await remote.defineLecture({ module, ...lecture }), answer => ({ id: answer.id }))),
    undefine: (module, id) => attempted(async () => outcome(await remote.deleteLecture({ module, id }), () => null)),
    importFile: (module, file, kind) => attempted(async () => outcome(await remote.importFile({
      module, name: file.name, kind, bytes: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    }), answer => ({ path: answer.path, name: answer.path.split('/').at(-1) ?? file.name,
      kind: answer.kind, size: answer.size_bytes, inNotebook: false }))),
    renameFile: (module, path, name) => attempted(async () => outcome(
      await remote.renameFile({ module, path, new_name: name }), () => null)),
    trashFile: (module, path) => attempted(async () => outcome(await remote.removeFile({ module, path }), () => null)),
    upload: (module, files) => attempted(async () => {
      const response = await remote.uploadRecordings({ module, files })
      if (!response.ok) return { ok: false, message: response.error.message }
      notebookChanged.add(module)
      notifications.notebookChanged?.(module)
      // NotebookLM still processing a fresh upload is a success; only a file that did not get there fails.
      const failed = response.value.files.filter(file => file.status === 'not-ready' || file.error !== undefined)
      if (failed.length > 0) {
        return { ok: false, message: failed.map(file => file.error ?? file.message ?? response.value.next).join('\n') || response.value.next }
      }
      return { ok: true, value: {
        uploaded: response.value.files.filter(file => file.status === 'uploaded' || file.status === 'processing').map(file => file.name),
        already: response.value.files.filter(file => file.status === 'already-uploaded').map(file => file.name),
      } }
    }),
  }
}
