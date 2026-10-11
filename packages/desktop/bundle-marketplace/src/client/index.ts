/** Optional marketplace tab and its package-owned generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsPluginsTabOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import marketplaceRemote from '@deepseek-ai/dsh-bundle-marketplace/remote'
import { MarketplaceTab, type MarketplaceInjected } from './MarketplaceTab.tsx'
import { en, type MarketplaceLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Active Bundle actions keyed by npm package name; registrants own behavior and localized copy. */
    'settings.bundleMarketplace.action': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginsTabOwnerProps }
  }
  interface LocaleNamespaceMap {
    /** Reviewed Bundle marketplace copy. */
    'settings.bundleMarketplace': MarketplaceLocaleKey
  }
}

/** Browser services; the generated namespace is mounted by this package, not the base Web assembly. */
export const inject = ['remote', 'slots', 'locale', 'connection']

/** Mount the generated Remote namespace and contribute one localized Settings tab. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.effect(() => ctx.remote.$mount(marketplaceRemote), 'bundleMarketplace.remote')
  ctx.effect(() => ctx.locale.register('settings.bundleMarketplace', { en }), 'bundleMarketplace.locale')
  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind('settings.bundleMarketplace')
  ctx.inject(['remote.bundleMarketplace'], (marketCtx) => {
    const injected: MarketplaceInjected = {
      catalogLanguage: () => ctx.locale.getLocale().active === 'ar' ? 'ar' : 'en',
      openLocalAgents: async () => {
        const result = await marketCtx.remote.bundleMarketplace.openLocalAgents()
        return result.ok ? result.value : 'unconfirmed'
      },
      snapshot: async () => {
        const result = await marketCtx.remote.bundleMarketplace.snapshot()
        if (!result.ok) throw new Error('Marketplace snapshot is unavailable')
        return result.value
      },
      history: async () => {
        const result = await marketCtx.remote.bundleMarketplace.history()
        if (!result.ok) throw new Error('Marketplace history is unavailable')
        return result.value
      },
      refreshCatalog: async () => {
        const result = await marketCtx.remote.bundleMarketplace.refreshCatalog()
        return result.ok ? result.value : 'unconfirmed'
      },
      install: async (id, profile, version, reviewToken) => {
        const result = await marketCtx.remote.bundleMarketplace.queueActivation(id, profile, version, reviewToken)
        return result.ok ? result.value : 'unconfirmed'
      },
      cancel: async (profile) => {
        const result = await marketCtx.remote.bundleMarketplace.cancel(profile)
        return result.ok ? result.value : 'unconfirmed'
      },
      remove: async (profile, packageName, version) => {
        const result = await marketCtx.remote.bundleMarketplace.queueRemoval(profile, packageName, version)
        return result.ok ? result.value : 'unconfirmed'
      },
      hooks: { connectionGeneration: connection.generation },
    }
    marketCtx.slots.inject('settings.plugins.tab', () => marketCtx.slots.register({
      name: 'settings.plugins.tab', id: 'marketplace', order: 5, label: () => t('tab'),
      locale: 'settings.bundleMarketplace', inject: () => injected,
      children: { 'settings.bundleMarketplace.action': { kind: 'keyed', scope: 'root' } },
    }, MarketplaceTab))
  })
}
