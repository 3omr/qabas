/** Browser half: register the transcriber engine readiness page in Settings. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TranscriberEngineSection, type TranscriberEngineSectionInjected } from './TranscriberEngineSection.tsx'
import { en, zh } from './locales.ts'
import { SetupStep, type SetupStepInjected } from './SetupStep.tsx'

export type { TranscriberEngineLocaleKey } from './locales.ts'
export type { TranscriberEngineSectionInjected, TranscriberEngineSectionProps } from './TranscriberEngineSection.tsx'

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
export const inject = ['slots', 'locale', 'transcriberEngine']

/** Register the readiness page once the Settings section slot is available. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-transcriber-engine: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): TranscriberEngineSectionInjected => ({ engine: ctx.transcriberEngine })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'transcriber-engine',
    order: 20,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, TranscriberEngineSection))
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
