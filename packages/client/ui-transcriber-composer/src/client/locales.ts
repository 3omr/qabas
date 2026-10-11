/** Egyptian Arabic lecture-choice copy is supplied by the Qabas language pack. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Lecture-choice strip copy. */
    transcriberComposer: TranscriberComposerKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  'provider.omar': 'Omar',
  'provider.gemini': 'Gemini',
  title: 'Lecture helper',
  'module.label': 'Module',
  'module.placeholder': 'Choose a module',
  'lecture.label': 'Lecture',
  'lecture.placeholder': 'Choose a lecture',
  'status.transcribed': 'Transcribed',
  'status.waiting': 'Waiting',
  'status.notebookOnly': 'NotebookLM only',
  'action.label': 'Prepare a request',
  'action.transcribe': 'Transcribe lecture',
  'action.review': 'Review transcript',
  'action.audit': 'Audit module sources',
  'action.readiness': 'Check module readiness',
  'action.findUntranscribed': 'Find untranscribed lectures',
  'action.prepareQuestions': 'Prepare question file',
  'source.label': 'Lecture files',
  loading: 'Checking modules and lectures…',
  'empty.modules': 'No modules in the study space yet. Ask the chat to create one.',
  'empty.lectures': 'This module has no recordings yet. Put them in its Lecture folder.',
  'error.read': 'Could not read the study space: {message}',
  'notebook.pending': 'Waiting for NotebookLM; some requests are not shown yet.',
  'notebook.failed': 'Could not read NotebookLM: {message}. Showing files on disk.',
  'notebook.unavailable': 'NotebookLM listing is unavailable; showing files on disk.',
  'actions.none': 'There is no request for the current selection.',
  'strip.aria': 'Lecture helper',
  'actions.aria': 'Lecture requests',
}

/** The strip's key union. */
export type TranscriberComposerKey = keyof typeof en
