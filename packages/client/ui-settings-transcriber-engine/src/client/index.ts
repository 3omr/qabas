/** Browser half: register the transcriber engine readiness page in Settings. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { TranscriberEngineSection, type TranscriberEngineSectionInjected } from './TranscriberEngineSection.tsx'
import { en, zh } from './locales.ts'

export type { TranscriberEngineLocaleKey } from './locales.ts'
export type { TranscriberEngineSectionInjected, TranscriberEngineSectionProps } from './TranscriberEngineSection.tsx'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.transcriberEngine'

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
}
