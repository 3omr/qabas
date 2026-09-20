/**
 * Qabas occupants for the generic browser-brand slots.
 *
 * The fork is a product, not a build profile of the harness, so this
 * registers unconditionally where `ui-brand-official` gates itself behind
 * `DSH_CLIENT_BUILD_PROFILE`. There is no build of this app that should show
 * someone else's brand.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { QabasBrandMark, QabasBrandName, QabasHeroMark } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar and blank-session brand slots as one declaration-aware
 * registration set. The hero mark is included because the slot's own fallback
 * is the harness's animated fish, which is the first thing a new user sees.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, QabasBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, QabasBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, QabasHeroMark)
      })))
}
