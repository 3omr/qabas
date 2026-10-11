/**
 * `note` namespace dictionaries, and the namespace's declaration. The Egyptian
 * Arabic dictionary lives in the Arabic language pack with the others.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Note panel: tabs, save state, outline and CodeMirror's own strings. */
    note: NoteKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  'panel.label': 'Notes',
  'trail.library': 'Library',
  'panel.empty.title': 'No note is open',
  'panel.empty.body': 'Open a transcript from the library and it shows up here.',
  'tab.close': 'Close {name}',
  'mode.live': 'Edit',
  'mode.read': 'Read',
  'mode.toggle': 'Toggle reading mode',
  'outline.label': 'Outline',
  'outline.toggle': 'Show outline',
  'outline.empty': 'This note has no headings.',
  'save.saved': 'Saved',
  'save.dirty': 'Unsaved',
  'save.saving': 'Saving…',
  'save.failed': 'Could not save: {message}',
  'save.conflict': 'This file was changed somewhere else.',
  'conflict.reload': 'Use the version on disk',
  'conflict.keep': 'Keep my changes',
  'words': '{count} words',
  'reading.footnotes': 'Footnotes',
  loading: 'Opening…',
  failed: 'Could not open: {message}',
  'cm.find': 'Find',
  'cm.replace': 'Replace',
  'cm.next': 'next',
  'cm.previous': 'previous',
  'cm.all': 'all',
  'cm.matchCase': 'match case',
  'cm.regexp': 'regexp',
  'cm.byWord': 'by word',
  'cm.replaceAll': 'replace all',
  'cm.close': 'close',
}

/** Every key the namespace declares. */
export type NoteKey = keyof typeof en
