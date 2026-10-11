/** Prebuilt external client fixture in the documented lazy-factory format. */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-desktop-plugin-fixture',
  factory: (require) => {
    const React = require('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const ns = 'desktop-plugin-fixture'
        ctx.effect(() => ctx.locale.register(ns, {
          en: { ready: 'External plugin ready' },
        }))
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: ns, locale: ns,
        }, ({ t }) => React.createElement('span', { 'data-testid': ns }, t('ready'))))
      },
    }
  },
})
