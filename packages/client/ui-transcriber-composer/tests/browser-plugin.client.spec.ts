import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, vi } from 'vitest'
import { ARABIC_LOCALE, conversationArabic, en, zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'
import { TranscriberComposer } from '../src/client/TranscriberComposer.tsx'

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const registered: unknown[] = []
  const locale = {
    addLanguage: vi.fn(() => () => undefined),
    register: vi.fn(() => () => undefined),
    setLocale: vi.fn(),
  }
  const workspaceFiles = { list: vi.fn(), read: vi.fn() }
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { workspaceFiles } as never)
  ctx.provide('remote.workspaceFiles', workspaceFiles as never)
  ctx.slots.register({
    name: 'root',
    children: { 'conversation.input.dock': { kind: 'list', scope: 'session' } },
  } as never, (() => null) as never)
  const originalRegister = ctx.slots.register.bind(ctx.slots)
  const register = vi.spyOn(ctx.slots, 'register').mockImplementation(((options: unknown, component: unknown) => {
    registered.push({ options, component })
    return originalRegister(options as never, component as never)
  }) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, locale, registered, register }
}

describe('ui-transcriber-composer browser plugin', () => {
  it('registers the dock and Arabic language contribution, then disposes both', async () => {
    const b = await boot()
    const entry = ctxEntry(b.ctx)
    expect(entry.options).toMatchObject({
      id: 'transcriber-composer',
      order: 5,
    })
    expect(entry.locale).toBe('transcriberComposer')
    expect(entry.component).toBe(TranscriberComposer)
    expect(b.locale.addLanguage).toHaveBeenCalledWith({ id: ARABIC_LOCALE, label: 'العربية (مصر)', fallback: 'en' })
    expect(b.locale.setLocale).toHaveBeenCalledWith(ARABIC_LOCALE)
    expect(b.locale.register).toHaveBeenCalledWith('transcriberComposer', { zh, en })
    expect(b.locale.register).toHaveBeenCalledWith('conversation', ARABIC_LOCALE, conversationArabic)

    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.input.dock')).toEqual([])
    expect(b.locale.register.mock.results.every(result => typeof result.value === 'function')).toBe(true)
    expect(b.register).toHaveBeenCalled()
  })
})

function ctxEntry(ctx: Context): { options: Record<string, unknown>; locale: string | undefined; component: unknown } {
  const entry = ctx.slots.entries('conversation.input.dock')[0]
  if (entry === undefined) throw new Error('composer entry was not registered')
  return {
    options: entry.options,
    locale: entry.locale,
    component: entry.component,
  }
}
