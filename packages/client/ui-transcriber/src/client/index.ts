/**
 * Browser half: register `transcriber` as a right-Sidebar tab type.
 *
 * The public two-stage path, unmodified: the type into `ctx.sidebarRightTabs`,
 * the body into the keyed `sidebar.right.pane.tab` seat and the chip title
 * into the keyed `sidebar.right.pane.tab.title` seat, both under the type's
 * `id`. Nothing upstream is patched to make room for this package, and the
 * navigation controller it binds to is `ctx.sidebarRight`, the service face,
 * rather than the docking kit, whose exports are documented as free to change
 * in any release.
 *
 * The file split is this package's layering: what a lecture IS
 * (`lectures.ts`), how the workspace is read (`workspace.ts`), what the type
 * IS (`definition.tsx`), what it keeps (`store.ts`), how it reads
 * (`face.ts`), what it draws (`TranscriberBody.tsx`, `TranscriberTitle.tsx`),
 * what it says (`locales.ts`), and this module, which only wires them
 * together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { TRANSCRIBER_ID, transcriberDefinition } from './definition.tsx'
import { transcriberFace } from './face.ts'
import { en, zh } from './locales.ts'
import { createTranscriberStore } from './store.ts'
import { TranscriberBody } from './TranscriberBody.tsx'
import { TranscriberTitle } from './TranscriberTitle.tsx'
import { createReadModules } from './workspace.ts'

export type { TranscriberKey } from './locales.ts'
export type { PanelState, TranscriberState, TranscriberTabState } from './store.ts'
export type { TranscriberInjected } from './face.ts'
export type { LectureUnit, RecordingFile } from './lectures.ts'
export type { RunPhaseState, TranscriberRun, TranscriberRunPhase, TranscriberRunStatus } from './runs.ts'
export type { ModuleView, NotebookStatus, ReadModules, ReadModulesOptions, TranscriberRemote } from './workspace.ts'
export type { TranscriberBodyProps } from './TranscriberBody.tsx'

/** This package's copy namespace. */
const NS = 'transcriber'

/**
 * Required browser services: the tab registry, the keyed seat, the Remote
 * carrier and its namespace, and copy.
 */
export const inject = [
  'slots', 'locale', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles', 'remote.transcriberEngine',
]

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry, the slots, and the Remote face.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(transcriberDefinition(t)), 'ui-transcriber: transcriber type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-transcriber: dictionaries')

  const store = createTranscriberStore()
  const inject = transcriberFace(createReadModules(ctx.remote))
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TRANSCRIBER_ID, locale: NS, store, inject },
    TranscriberBody,
  )), 'ui-transcriber: transcriber tab body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TRANSCRIBER_ID },
    TranscriberTitle,
  )), 'ui-transcriber: transcriber tab title')
}
