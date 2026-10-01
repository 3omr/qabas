/**
 * Browser half: the note panel, and the library's opener for workspace files.
 *
 * Wiring only: what an open note is and how it saves (`service.ts`), where
 * its figures come from (`images.ts`), how markdown is drawn while it is
 * edited (`live-preview.ts`, `theme.ts`), what the panel draws
 * (`NotePanel.tsx`, `Editor.tsx`), and what it says (`locales.ts`).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-library/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh } from './locales.ts'
import { NotePanel, type NotePanelInjected } from './NotePanel.tsx'
import { engineNoteFiles, linkTarget } from './files.ts'
import { NoteService } from './service.ts'

export type { NoteKey } from './locales.ts'
export type { NoteFiles, NoteFileText, NoteOutcome, NotesState, OpenNote, SaveState } from './service.ts'

/** This package's copy namespace. */
const NS = 'note'

/** The note panel's key in the layout's `main` slot. */
const NOTE_PANEL = 'note' as MainPanelId

/** Note panel configuration. */
export interface Config {
  /** Idle milliseconds after an edit before it is saved. */
  autosaveMs?: number
}

/** Validated configuration. */
export const Config: z<Config> = z.object({
  autosaveMs: z.natural().min(200).default(1200),
})

/** Required browser services. */
export const inject = ['slots', 'locale', 'layout', 'library', 'remote', 'remote.transcriberEngine']

/**
 * Register the note panel and make it where the library opens files.
 * @param ctx - client root context.
 * @param config - validated configuration.
 */
export function apply(ctx: ClientContext, config: Config): void {
  const common = ctx.locale.bind('common')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-note: dictionaries')
  const files = engineNoteFiles(ctx.remote.transcriberEngine)
  const notes = new NoteService(ctx, files, config.autosaveMs ?? 1200)
  const open = (path: string): void => {
    void notes.open(path)
    ctx.layout.selectPanel(NOTE_PANEL)
  }
  const injected = (): NotePanelInjected => ({
    notes,
    openLink: (target, from) => { open(linkTarget(target, from)) },
    labels: { code: { copyLabel: common('copy'), copiedLabel: common('copied') }, footnotes: t('reading.footnotes') },
  })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: NOTE_PANEL,
    locale: NS,
    inject: injected,
  }, NotePanel))
  ctx.effect(() => ctx.library.registerOpener(open), 'ui-note: library opener')
}
