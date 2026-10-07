/** Translate session-free engine edits into the lecture manager's outcomes. */

import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { EditOutcome, LectureEditing, LibrarySetup } from './editing.ts'

type EditingRemote = Pick<ClientRemote['transcriberEngine'],
  'listModuleFiles' | 'defineLecture' | 'deleteLecture' | 'importFile' | 'renameFile' | 'removeFile' | 'uploadRecordings'>
  & Partial<Pick<ClientRemote['transcriberEngine'], 'proposeOrganization' | 'applyOrganization' | 'buildExamIndex' | 'prepareExamFile' | 'setGeneralMaterials' | 'hideLecture' | 'restoreRecordings' | 'removeTranscript' | 'listTrash' | 'restoreTrash'>>

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
  const prepareExamFile = remote.prepareExamFile?.bind(remote)
  const buildExamIndex = remote.buildExamIndex?.bind(remote)
  const removeTranscript = remote.removeTranscript?.bind(remote)
  const listTrash = remote.listTrash?.bind(remote)
  const restoreTrash = remote.restoreTrash?.bind(remote)
  const hideLecture = remote.hideLecture?.bind(remote)
  const restoreRecordings = remote.restoreRecordings?.bind(remote)
  const setGeneralMaterials = remote.setGeneralMaterials?.bind(remote)
  return {
    ...removeTranscript === undefined ? {} : {
      removeTranscript: (module: string, lecture: string, kinds: Parameters<NonNullable<LectureEditing['removeTranscript']>>[2]) =>
        attempted(async () => outcome(
          await removeTranscript({ module, lecture, kinds }),
          answer => ({ id: answer.id, paths: answer.paths }),
        )),
    },
    ...listTrash === undefined ? {} : {
      listTrash: (module: string) => attempted(async () => outcome(await listTrash({ module }), answer => answer.map(entry => ({
        id: entry.id, removedAt: entry.removed_at, kind: entry.kind, label: entry.label, paths: entry.paths,
      })))),
    },
    ...restoreTrash === undefined ? {} : {
      restoreTrash: (module: string, id: string) =>
        attempted(async () => outcome(await restoreTrash({ module, id }), answer => ({ id: answer.id, paths: answer.paths }))),
    },
    ...hideLecture === undefined ? {} : {
      hideLecture: (module: string, title: string) =>
        attempted(async () => outcome(await hideLecture({ module, title }), answer => answer.recordings)),
    },
    ...restoreRecordings === undefined ? {} : {
      restoreRecordings: (module: string, recordings: readonly string[]) =>
        attempted(async () => outcome(await restoreRecordings({ module, recordings }), answer => answer.recordings)),
    },
    ...proposeOrganization === undefined ? {} : {
      propose: (module: string, refresh: boolean) => attempted(async () => outcome(
        await proposeOrganization({ module, refresh }), answer => ({ source: answer.source,
          lectures: answer.lectures.map(({ existing_id: existingId, ...lecture }) => ({ ...lecture,
            ...existingId === undefined ? {} : { existingId } })), unassigned: answer.unassigned, notes: answer.notes,
          ...answer.general === undefined ? {} : { general: answer.general } }))),
    },
    ...applyOrganization === undefined ? {} : {
      applyProposal: (module: string, lectures: Parameters<NonNullable<LectureEditing['applyProposal']>>[1], replaceExisting: boolean,
        general?: readonly string[]) =>
        attempted(async () => outcome(
          await applyOrganization({ module, lectures, replaceExisting, ...general === undefined ? {} : { general } }), () => null)),
    },
    ...setGeneralMaterials === undefined ? {} : {
      setGeneral: (module: string, materials: readonly string[]) =>
        attempted(async () => outcome(await setGeneralMaterials({ module, materials }), () => null)),
    },
    ...prepareExamFile === undefined ? {} : {
      prepareExamFile: (module: string, path: string, signal?: AbortSignal) => attempted(async () => {
        const response = await prepareExamFile({ module, path }, signal)
        if (!response.ok) return { ok: false, message: response.error.message }
        return response.value.status === 'ready'
          ? { ok: true, value: null }
          : { ok: false, message: response.value.message ?? '' }
      }),
    },
    ...buildExamIndex === undefined ? {} : {
      buildQuestionIndex: (module: string, signal?: AbortSignal) => attempted(async () => outcome(
        await (signal === undefined ? buildExamIndex({ module }) : buildExamIndex({ module }, signal)), () => {
          notifications.questionIndexBuilt?.(module)
          return null
        })),
    },
    listFiles: module => attempted(async () => {
      const refresh = notebookChanged.delete(module)
      return outcome(await remote.listModuleFiles({ module, ...refresh ? { refresh: true } : {} }), answer => answer.files.map(file => ({
        path: file.path, name: file.name, size: file.size_bytes, kind: file.kind,
        inNotebook: file.in_notebook === true,
        ...file.indexed === undefined ? {} : { indexed: file.indexed },
        ...file.question_count === undefined ? {} : { questionCount: file.question_count },
        ...file.sha256 === undefined ? {} : { sha256: file.sha256 },
        ...file.preparation === undefined ? {} : { preparation: file.preparation },
        ...file.preparation_error === undefined ? {} : { preparationError: file.preparation_error },
        ...file.hidden === true ? { hidden: true } : {},
        ...file.general === true ? { general: true } : {},
        ...file.lectures[0] === undefined ? {} : { lecture: file.lectures[0].title },
      })))
    }),
    define: (module, lecture) => attempted(async () => {
      // Choosing a recording the student hid (× on a lecture) takes it back out
      // of the trash; the engine refuses hidden recordings, so restore first.
      // Restoring a name that is not hidden changes nothing.
      if (restoreRecordings !== undefined && lecture.recordings.length > 0) {
        const restored = await restoreRecordings({ module, recordings: lecture.recordings })
        if (!restored.ok) return { ok: false, message: restored.error.message }
      }
      return outcome(await remote.defineLecture({ module, ...lecture }), answer => ({ id: answer.id }))
    }),
    undefine: (module, id) => attempted(async () => outcome(await remote.deleteLecture({ module, id }), () => null)),
    importFile: (module, file, kind, options) => attempted(async () => outcome(await remote.importFile({
      module, name: options?.name ?? file.name, kind, ...options?.replace === undefined ? {} : { replace: options.replace },
      bytes: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    }, options?.signal), answer => ({ path: answer.path, name: answer.path.split('/').at(-1) ?? file.name,
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

type SetupRemote = Pick<ClientRemote['transcriberEngine'], 'workspace' | 'createModule'>
  & Partial<Pick<ClientRemote['transcriberEngine'], 'removeModule' | 'restoreModule' | 'listRemovedModules'>>

/**
 * Supply fixed-library setup and optional reversible module operations.
 * @param remote - mounted transcriber engine namespace.
 * @returns the setup calls, or undefined on an older Host.
 */
export function engineSetup(remote: Partial<SetupRemote>): LibrarySetup | undefined {
  const { workspace, createModule } = remote
  if (workspace === undefined || createModule === undefined) return undefined
  const removeModule = remote.removeModule?.bind(remote)
  const restoreModule = remote.restoreModule?.bind(remote)
  const listRemovedModules = remote.listRemovedModules?.bind(remote)
  return {
    workspace: () => attempted(async () => outcome(await workspace.call(remote), answer => answer)),
    ...removeModule === undefined ? {} : {
      removeModule: (module: string) => attempted(async () => outcome(await removeModule({ module }), answer => ({
        module: answer.module, trashId: answer.trash_id, notebookUntouched: answer.notebook_untouched,
      }))),
    },
    ...restoreModule === undefined ? {} : {
      restoreModule: (trashId: string) => attempted(async () => outcome(await restoreModule({ trashId }), answer => ({
        module: answer.module, notebookUntouched: answer.notebook_untouched,
      }))),
    },
    ...listRemovedModules === undefined ? {} : {
      listRemovedModules: () => attempted(async () => outcome(await listRemovedModules(), answer => answer.map(entry => ({
        module: entry.module, trashId: entry.trash_id, displayName: entry.display_name, removedAt: entry.removed_at,
      })))),
    },
    createModule: (id, displayName) => attempted(async () => outcome(
      await createModule.call(remote, { module: id, displayName }), answer => answer)),
  }
}
