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
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-library/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh } from './locales.ts'
import { NotePanel, type NotePanelInjected } from './NotePanel.tsx'
import { NoteService, type NoteFiles, type NoteOutcome } from './service.ts'

export type { NoteKey } from './locales.ts'
export type { NoteFiles, NoteFileText, NoteOutcome, NotesState, OpenNote, SaveState } from './service.ts'
export { NoteService } from './service.ts'

/** This package's copy namespace. */
const NS = 'note'

/** The note panel's key in the layout's `main` slot. */
export const NOTE_PANEL = 'note' as MainPanelId

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

/** The engine's session-free file calls, as this package uses them. */
type EngineFiles = Pick<ClientRemote['transcriberEngine'], 'readFile' | 'readFileBytes' | 'writeFile'>

/**
 * The engine sends file bytes as base64 over the JSON carrier.
 * @param base64 - the encoded bytes.
 * @returns the raw bytes.
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function outcome<T, U>(answer: RemoteResult<T>, map: (value: T) => U): NoteOutcome<U> {
  if (answer.ok) return { ok: true, value: map(answer.value) }
  return { ok: false, conflict: /conflict/iu.test(answer.error.code), message: answer.error.message }
}

/**
 * Adapt the engine's file calls to the editor's.
 * @param engine - the transcriber-engine Remote.
 * @returns the editor's file access.
 */
export function engineNoteFiles(engine: EngineFiles): NoteFiles {
  const guard = async <T>(call: () => Promise<NoteOutcome<T>>): Promise<NoteOutcome<T>> => {
    try {
      return await call()
    } catch (error: unknown) {
      // The Remote face folds carrier failures into its error branch; only an
      // assembly fault rejects, and the panel reports it the same way.
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    read: (path, signal) => guard(async () => outcome(await engine.readFile({ path }, signal), value => value)),
    readBytes: (path, relativeTo, signal) => guard(async () => outcome(
      await engine.readFileBytes({ path, ...relativeTo === undefined ? {} : { relativeTo } }, signal),
      value => decodeBase64(value.bytes),
    )),
    write: (path, text, expectedVersion, signal) => guard(async () => outcome(
      await engine.writeFile({ path, text, expectedVersion }, signal),
      value => ({ version: value.version }),
    )),
  }
}

/**
 * Where a link written in a note points: a relative `.md` path, or a
 * `[[wikilink]]` naming a note beside this one.
 * @param target - the link as written.
 * @param from - the note it was written in.
 * @returns the absolute path to open.
 */
export function linkTarget(target: string, from: string): string {
  const withoutAnchor = target.split('#')[0] ?? target
  const file = /\.[A-Za-z0-9]+$/u.test(withoutAnchor) ? withoutAnchor : `${withoutAnchor}.md`
  if (file.startsWith('/')) return file
  const folder = from.slice(0, Math.max(from.lastIndexOf('/'), 0))
  const parts = `${folder}/${file}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return `/${resolved.join('/')}`
}

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
