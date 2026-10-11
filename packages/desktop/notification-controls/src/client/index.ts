/** The optional Bundle contributes its own configuration action to the marketplace. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-bundle-marketplace/client'
import { NOTIFICATION_CONTROLS_NAMESPACE, type NotificationPreferences } from '../settings.ts'
import { NotificationControls, type NotificationControlsInjected } from './NotificationControls.tsx'
import { en, type NotificationControlsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Saved notification controls and their limitations. */
    'desktop.notificationControls': NotificationControlsKey
  }
}

/** Register only through the existing locale, settings and Slots services. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the plugin-owned editor when the marketplace declares its action slot.
 * @param ctx - Browser plugin context owning the scope and registrations.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('desktop.notificationControls', { en }), 'notificationControls.locale')
  const preference = ctx.settingsScope.bind<NotificationPreferences>({ namespace: NOTIFICATION_CONTROLS_NAMESPACE })
  const injected = (): NotificationControlsInjected => ({
    hooks: { preference },
    save: async (field, enabled, revision) => {
      await preference.mutate([{ op: 'set', path: [field], value: enabled }], revision)
      const snapshot = preference.getSnapshot()
      return snapshot.status === 'ready' && snapshot.mode === 'host' && snapshot.writable && snapshot.value?.[field] === enabled
    },
  })
  ctx.slots.inject('settings.bundleMarketplace.action', () => ctx.slots.register({
    name: 'settings.bundleMarketplace.action', key: '@deepseek-ai/dsh-notification-controls',
    locale: 'desktop.notificationControls', inject: injected,
  }, NotificationControls))
}
