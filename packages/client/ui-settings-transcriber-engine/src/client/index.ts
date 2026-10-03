/**
 * Browser half: the Accounts and tools page in Settings (NotebookLM, agy, the
 * Gemini key and the tools on this machine) and the same checks as a
 * first-run step.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AccountsSection, type AccountsSectionInjected } from './AccountsSection.tsx'
import { geminiKeyOf } from './gemini-key.ts'
export { GEMINI_KEY_REF } from './gemini-key.ts'
import { en, zh } from './locales.ts'
import { SetupStep, type SetupStepInjected } from './SetupStep.tsx'

export type { TranscriberEngineLocaleKey } from './locales.ts'
export type { AccountsSectionInjected, AccountsSectionProps, GeminiKey, KeyState, KeyCheck } from './AccountsSection.tsx'
export type { TranscriberEngineInjected } from './standing.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.transcriberEngine'

/**
 * This step's place among every registered first-run step, read from the
 * ledger at render: the steps belong to several plugins, and their order
 * fields are the one fact they share.
 * @param ctx - client root context.
 * @param id - the step id.
 * @returns index and total, or undefined before the step is registered.
 */
function onboardingProgress(ctx: ClientContext, id: string): SetupProgress | undefined {
  const ids = ctx.slots.entries('settings.onboarding')
    .map(entry => ({ id: entry.options.id, order: entry.options.order ?? 0 }))
    .sort((left, right) => left.order - right.order)
    .map(entry => entry.id)
  const index = ids.indexOf(id)
  return index === -1 ? undefined : { index, total: ids.length }
}

/** Services required by the page registration. */
export const inject = ['slots', 'locale', 'transcriberEngine', 'remote', 'remote.credentials', 'remote.settings', 'remote.llm', 'remote.session']

/** Register the readiness page once the Settings section slot is available. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-transcriber-engine: dictionaries')
  const t = ctx.locale.bind(NS)
  const geminiKey = geminiKeyOf(ctx.remote.credentials, changed => ctx.remote.$on('credentials/reference-updated', changed), ctx.remote)
  const injected = (): AccountsSectionInjected => ({ engine: ctx.transcriberEngine, geminiKey })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'transcriber-engine',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, AccountsSection))
  // The same page is step three of first-run setup, so a student installs the
  // tools and connects NotebookLM before the library ever needs them.
  const setupInjected = (): SetupStepInjected => ({
    geminiKey,
    engine: ctx.transcriberEngine,
    progress: onboardingProgress(ctx, 'transcriber-engine'),
  })
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'transcriber-engine',
    order: 20,
    locale: NS,
    inject: setupInjected,
  }, SetupStep))
}
