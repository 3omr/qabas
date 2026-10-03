/**
 * Browser half: the last step of Qabas's first-run setup.
 *
 * The settings coordinator walks `settings.onboarding` entries in order:
 * the welcome and the AI account (ui-settings-models), the transcription
 * tools (ui-settings-transcriber-engine), and this step, which lands the
 * student in the library. Every step draws in the same setup frame and reads
 * its position from the ledger, so steps from four packages read as one flow.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-library/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { en, zh } from './locales.ts'
import { LibraryStep, type LibraryInjected } from './steps.tsx'

export type { SetupKey } from './locales.ts'
export type { LibraryInjected, LibraryStepProps } from './steps.tsx'

/** This package's copy namespace. */
const NS = 'setup'

/** The step's id; it orders last. */
const STEP_ID = 'qabas-library'

/** The library's key in the layout's main slot (ui-library registers it). */
const LIBRARY_PANEL = 'library' as MainPanelId

/** Required browser services. */
export const inject = ['slots', 'locale', 'layout', 'library']

/**
 * This step's place among every registered first-run step.
 * @param ctx - client root context.
 * @returns index and total, or undefined before the step is registered.
 */
function progressOf(ctx: ClientContext): SetupProgress | undefined {
  const ids = ctx.slots.entries('settings.onboarding')
    .map(entry => ({ id: entry.options.id, order: entry.options.order ?? 0 }))
    .sort((left, right) => left.order - right.order)
    .map(entry => entry.id)
  const index = ids.indexOf(STEP_ID)
  return index === -1 ? undefined : { index, total: ids.length }
}

/**
 * Register the library step.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-setup: dictionaries')
  let cached: { path?: string; modules?: number } = {}
  const found: ObservableSnapshot<{ readonly path?: string; readonly modules?: number }> = {
    getSnapshot: () => {
      const state = ctx.library.state.getSnapshot()
      const modules = state.modules.status === 'ready' ? state.modules.value.length : undefined
      if (cached.path !== state.workspace || cached.modules !== modules) {
        cached = {
          ...state.workspace === undefined ? {} : { path: state.workspace },
          ...modules === undefined ? {} : { modules },
        }
      }
      return cached
    },
    subscribe: listener => ctx.library.state.subscribe(listener),
  }
  const injected = (): LibraryInjected => ({
    progress: progressOf(ctx),
    workspace: found,
    openLibrary: () => { ctx.layout.selectPanel(LIBRARY_PANEL) },
  })
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: STEP_ID,
    order: 30,
    locale: NS,
    inject: injected,
  }, LibraryStep))
}
