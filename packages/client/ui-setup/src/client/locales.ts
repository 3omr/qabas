/**
 * `setup` namespace dictionaries, and the namespace's declaration. The
 * Egyptian Arabic dictionary lives in the Arabic language pack.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** First-run setup's last step: the library. */
    setup: SetupKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  'library.label': 'Library',
  'library.eyebrow': 'Your library',
  'library.title': 'You’re all set',
  'library.lead.found': 'Found {count} modules in your library folder. Start your first transcription from the library.',
  'library.lead.empty': 'This folder has no modules yet. Choose another folder, or open the library and add a module with its recordings, slides and past papers.',
  'library.folder': 'Library folder',
  'library.lead.reading': 'Reading your study workspace…',
  'library.open': 'Open the library',
}

/** Every key the namespace declares. */
export type SetupKey = keyof typeof en
