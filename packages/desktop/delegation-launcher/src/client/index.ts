/** Guided human delegation; all execution remains in existing Host services. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-bundle-marketplace/client'
import delegationRemote from '@deepseek-ai/dsh-delegation-launcher/remote'
import { DELEGATION_COMMAND } from '../protocol.ts'
import { DelegationLauncher, type DelegationInjected } from './DelegationLauncher.tsx'
import { MarketplaceAction } from './MarketplaceAction.tsx'
import { createDelegationStore } from './store.ts'
import { en, type DelegationKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Guided delegation copy. */
    'desktop.delegationLauncher': DelegationKey
  }
}

/** Only renderer, connection and existing session capabilities are consumed. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'connection']

/** @param ctx - Browser context owning the optional Bundle. @returns After its Remote face is mounted. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => ctx.remote.$mount(delegationRemote), 'delegationLauncher.remote')
  ctx.effect(() => ctx.locale.register('desktop.delegationLauncher', { en }), 'delegationLauncher.locale')
  const store = createDelegationStore()
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.inject(['remote.delegationLauncher', 'remote.commands'], (scope) => {
    const injected = (): DelegationInjected => ({
      hooks: { connectionGeneration: connection.generation },
      readJob: async (sessionId, id, generation) => {
        if (scope.sessions.list.getSnapshot().current !== sessionId || connection.generation.getSnapshot()?.id !== generation) {
          return { kind: 'unavailable' }
        }
        const result = await scope.remote.delegationLauncher.readJob(sessionId, id)
        return result.ok ? result.value : { kind: 'unavailable' }
      },
      cancelJob: async (sessionId, id, generation) => {
        if (scope.sessions.list.getSnapshot().current !== sessionId || connection.generation.getSnapshot()?.id !== generation) {
          return 'unconfirmed'
        }
        const result = await scope.remote.delegationLauncher.cancelJob(sessionId, id)
        return result.ok ? result.value : 'unconfirmed'
      },
      providers: async () => {
        const result = await scope.remote.delegationLauncher.providers()
        if (!result.ok) throw new Error('Delegation providers unavailable')
        return result.value
      },
      submit: async (sessionId, provider, task) => {
        const binding = scope.sessions.binding(sessionId)
        if (binding === undefined || scope.sessions.list.getSnapshot().current !== sessionId) return null
        const result = await scope.remote.commands.execute(sessionId, `/${DELEGATION_COMMAND} ${JSON.stringify({ provider, task })}`, [])
        if (!result.ok || result.value === undefined) return null
        const outcome = result.value.result
        return { kind: outcome.kind, ...outcome.text === undefined ? {} : { text: outcome.text } }
      },
    })
    scope.slots.inject('sidebar.footer.action', function* () {
      yield scope.slots.register({
        name: 'sidebar.footer.action', id: 'delegation-launcher', order: 55, locale: 'desktop.delegationLauncher', store,
        inject: injected,
      }, DelegationLauncher)
      yield scope.slots.inject('settings.bundleMarketplace.action', () => scope.slots.register({
        name: 'settings.bundleMarketplace.action', key: '@deepseek-ai/dsh-delegation-launcher',
        locale: 'desktop.delegationLauncher', store,
      }, MarketplaceAction))
    })
  })
}
