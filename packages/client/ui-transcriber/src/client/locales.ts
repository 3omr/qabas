/**
 * `transcriber` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the panel could not read, one code each,
 * because a workspace that is gone and a transport that dropped suggest a
 * different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'transcriber'>` or `PropsLocale<'transcriber'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Transcriber panel name, guide entry, section headings, and failure lines. */
    transcriber: TranscriberKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  'type.label': 'Lectures',
  'guide.title': 'Medical lectures',
  'guide.description': 'See which lectures in each module are transcribed and which are still waiting',
  loading: 'Reading…',
  refresh: 'Reload',
  'section.transcribed': 'Transcribed',
  'section.failed': 'Failed',
  'section.pending': 'Waiting',
  'lecture.parts': '{count} recordings',
  'module.lectureCount': '{done}/{total} transcribed',
  'run.progress': ' {done}/{total}',
  'run.running': 'Transcribing: {phase}',
  'run.failed': 'Transcription failed: {phase}',
  'run.completed': 'Completed',
  'run.preparing': 'Preparing',
  'run.resultFailed': 'The run reported failure',
  'empty.modules': 'No modules in this workspace yet. Ask the chat to create one.',
  'empty.lectures': 'No recordings in this module yet. Put them in its Lecture folder.',
  'drop.lecture.title': 'Drop recordings or slides here',
  'drop.lecture.description': 'Audio, video, slides, or documents',
  'drop.questions.title': 'Drop exam material here',
  'drop.questions.description': 'PDF, Word, text, or PowerPoint',
  'drop.importing': 'Filing files…',
  'drop.filed': 'Filed {count} files',
  'drop.rejected': 'Rejected {count} files',
  'drop.failed': 'Filing failed: {message}',
  'drop.reason.sourceNotAbsolute': 'The path is not absolute',
  'drop.reason.unsupportedExtension': 'The file format is not supported',
  'drop.reason.sourceNotFound': 'The file was not found',
  'drop.reason.sourceNotFile': 'The path is not a file',
  'drop.reason.sourceUnreadable': 'The file could not be read',
  'drop.reason.nameCollision': 'A file with this name already exists',
  'drop.reason.copyFailed': 'The file could not be copied',
  'notebook.pending': 'Waiting for NotebookLM; some requests are not shown yet.',
  'notebook.failed': 'Could not read NotebookLM: {message}. Showing files on disk.',
  'notebook.unavailable': 'NotebookLM listing is unavailable; showing files on disk.',
  noWorkspace: 'This session has no workspace directory.',
  'error.notFound': 'The workspace is gone. It may have been moved or deleted.',
  'error.unavailable': 'Read failed: {message}',
  'firstRun.title': 'Finish your first transcription',
  'firstRun.description': 'Set up the study space in order until the first transcript is saved.',
  'firstRun.skip': 'Look around first',
  'firstRun.reopen': 'Open the start guide',
  'firstRun.refresh': 'Refresh status',
  'firstRun.loading': 'Updating settings and study-space status…',
  'firstRun.completed': 'Setup is complete, and the first transcript is already there.',
  'firstRun.status.done': 'Done',
  'firstRun.status.next': 'Next',
  'firstRun.status.waiting': 'Waiting',
  'firstRun.status.unknown': 'Unknown',
  'firstRun.step.workspace': 'Choose a workspace folder',
  'firstRun.step.provider': 'Sign in to a model provider',
  'firstRun.step.readiness': 'Check the transcription tools',
  'firstRun.step.notebook': 'Connect NotebookLM',
  'firstRun.step.module': 'Create a module',
  'firstRun.step.files': 'Add lecture files',
  'firstRun.step.sync': 'Sync the sources',
  'firstRun.step.transcript': 'Transcribe a lecture',
  'firstRun.current.workspace': 'Use the folder button below to choose a workspace.',
  'firstRun.current.sync': 'Ask the chat to sync the sources, then send the request. The sync record is the evidence.',
  'firstRun.current.transcript': 'Prepare a transcription request in the chat, then send it.',
  'firstRun.action.openModels': 'Open provider settings',
  'firstRun.action.openReadiness': 'Open readiness check',
  'firstRun.action.openNotebook': 'Open NotebookLM check',
  'firstRun.action.createModule': 'Prepare the module request',
  'firstRun.action.openLectures': 'Open the lecture panel',
  'firstRun.action.prepareSync': 'Prepare the sync request',
  'firstRun.action.prepareTranscript': 'Prepare the transcription request',
  'firstRun.draft.createModule': 'Create a module named “{module}” and prepare it for lecture sources.',
  'firstRun.draft.sync': 'Sync the sources for “{module}” with NotebookLM.',
  'firstRun.draft.transcript': 'Transcribe “{lecture}” from the “{module}” module.',
  'firstRun.moduleName': 'Module name',
  'firstRun.moduleNamePlaceholder': 'For example: Paediatrics',
}

/** Transcriber dictionary key union. */
export type TranscriberKey = keyof typeof en
