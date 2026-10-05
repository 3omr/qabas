/**
 * Qabas occupants for the generic browser-brand slots.
 *
 * The fork is a product, not a build profile of the harness, so this
 * registers unconditionally where `ui-brand-official` gates itself behind
 * `DSH_CLIENT_BUILD_PROFILE`. There is no build of this app that should show
 * someone else's brand.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { qabasBrandOwners } from './Brand.tsx'
import { en, zh } from './locales.ts'
import { QABAS_PALETTE } from './palette.ts'


/** Token-layer identity: the layer names its origin when themes are inspected. */
const PALETTE_SOURCE = '@deepseek-ai/dsh-client-ui-brand-qabas'

/** Locale namespace that names the drawn marks. */
const NS = 'brand'

/** Required services: the UI slot registry, the theme it recolours and the locale that names it. */
export const inject = ['slots', 'theme', 'locale']

/**
 * Fill the sidebar and blank-session brand slots as one declaration-aware
 * registration set. The hero mark is included because the slot's own fallback
 * is the harness's animated fish, which is the first thing a new user sees.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  // A layer over the base themes rather than a theme of its own: the light /
  // dark / system preference keeps working, and each scheme gets its paper.
  ctx.effect(() => ctx.theme.overrideTokens(PALETTE_SOURCE, QABAS_PALETTE), 'ui-brand-qabas: palette')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-brand-qabas: dictionaries')
  const t = ctx.locale.bind(NS)
  const owners = qabasBrandOwners(() => t('name'))
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, owners.mark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, owners.name)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, owners.hero)
      })))
  // The wordmark heads the first-run welcome too.
  ctx.slots.inject('settings.onboarding.mark', () => ctx.slots.register({ name: 'settings.onboarding.mark' }, owners.hero))
}
