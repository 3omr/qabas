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
import { AccountsSection, type AccountsSectionInjected, type GeminiKey } from './AccountsSection.tsx'
import { en, zh } from './locales.ts'
import { SetupStep, type SetupStepInjected } from './SetupStep.tsx'

export type { TranscriberEngineLocaleKey } from './locales.ts'
export type { AccountsSectionInjected, AccountsSectionProps, GeminiKey, KeyState } from './AccountsSection.tsx'
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

/** The credential pi-ai reads Google's key from. */
export const GEMINI_KEY_REF = 'GEMINI_API_KEY'

/**
 * The Gemini key's calls over the credentials Remote. The value is written
 * and never read back: the page only learns whether one is stored.
 * @param ctx - client root context.
 * @returns the key's calls.
 */
function geminiKeyOf(ctx: ClientContext): GeminiKey {
  return {
    describe: async () => {
      const response = await ctx.remote.credentials.describe([GEMINI_KEY_REF])
      const info = response.ok ? response.value[GEMINI_KEY_REF] : undefined
      return info === undefined ? undefined : { configured: info.configured, writable: info.writable }
    },
    save: async (value) => {
      const response = await ctx.remote.credentials.set(GEMINI_KEY_REF, value)
      return response.ok ? undefined : response.error.message
    },
    remove: async () => {
      const response = await ctx.remote.credentials.unset(GEMINI_KEY_REF)
      return response.ok ? undefined : response.error.message
    },
    watch: changed => ctx.remote.$on('credentials/reference-updated', (ref) => {
      if (ref === GEMINI_KEY_REF) changed()
    }),
  }
}

/** Services required by the page registration. */
export const inject = ['slots', 'locale', 'transcriberEngine', 'remote', 'remote.credentials']

/** Register the readiness page once the Settings section slot is available. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-transcriber-engine: dictionaries')
  const t = ctx.locale.bind(NS)
  const geminiKey = geminiKeyOf(ctx)
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
