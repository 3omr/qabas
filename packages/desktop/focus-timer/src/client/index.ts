/** Optional sidebar contribution; importing this module starts no clock or request. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-bundle-marketplace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { FOCUS_TIMER_NAMESPACE, type FocusTimerSettings } from '../settings.ts'
import { FocusTimer, type FocusTimerInjected } from './FocusTimer.tsx'
import { MarketplaceAction } from './MarketplaceAction.tsx'
import { createFocusTimerStore } from './store.ts'
import { en, type FocusTimerKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Local-only focus timer labels. */
    'desktop.focusTimer': FocusTimerKey
  }
}

/** Services required only while the browser contribution is mounted. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register one timer and an optional marketplace launcher sharing only its panel visibility. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('desktop.focusTimer', { en }), 'focusTimer.locale')
  const store = createFocusTimerStore()
  const preference = ctx.settingsScope.bind<FocusTimerSettings>({ namespace: FOCUS_TIMER_NAMESPACE })
  const injected = (): FocusTimerInjected => ({
    hooks: { preference },
    savePreference: async (minutes, revision) => {
      await preference.mutate([minutes === null ? { op: 'unset', path: ['minutes'] } : { op: 'set', path: ['minutes'], value: minutes }], revision)
      const snapshot = preference.getSnapshot()
      return snapshot.status === 'ready' && snapshot.mode === 'host' && snapshot.writable
        && (snapshot.value?.minutes ?? null) === minutes
    },
  })
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({
      name: 'sidebar.footer.action', id: 'focus-timer', order: 50, locale: 'desktop.focusTimer', store,
      inject: injected,
    }, FocusTimer)
    yield ctx.slots.inject('settings.bundleMarketplace.action', () => ctx.slots.register({
      name: 'settings.bundleMarketplace.action', key: '@deepseek-ai/dsh-focus-timer', locale: 'desktop.focusTimer', store,
    }, MarketplaceAction))
  })
}
