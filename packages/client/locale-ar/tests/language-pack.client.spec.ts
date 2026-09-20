// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply } from '../src/client/index.ts'

describe('Qabas Arabic language pack', () => {
  it('registers Arabic, supplies product copy, and falls back to English', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    locale.register('common', 'en', { fallbackOnly: 'English fallback' })
    ctx.provide('locale', locale)

    const fiber = ctx.plugin({ inject: ['locale'], apply })
    await fiber.await()

    expect(locale.getLocale().locales).toContainEqual({
      id: 'ar', label: 'العربية', fallback: 'en',
    })
    expect(locale.getLocale().active).toBe('ar')
    expect(locale.getLocale().direction).toBe('rtl')
    expect(locale.bind('common')('brand.localBuild')).toBe('قَبَس')
    const common = locale.bind('common' as string)
    expect(common('fallbackOnly')).toBe('English fallback')
    expect(common('notRegistered')).toBe('notRegistered')

    await fiber.dispose()
    expect(locale.getLocale().locales.map(item => item.id)).toEqual(['zh', 'en'])
    expect(locale.getLocale().active).toBe('en')
  })
})
