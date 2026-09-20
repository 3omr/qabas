/** Browser half of the Qabas Egyptian Arabic language pack. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { dictionaries } from './locales.ts'

const ARABIC_LOCALE = 'ar'

/** The locale service is the only browser service this pack consumes. */
export const inject = ['locale']

/** Register Arabic copy, right-to-left direction, and the product default. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const removeLanguage = ctx.locale.addLanguage({
      id: ARABIC_LOCALE,
      label: 'العربية',
      fallback: 'en',
      direction: 'rtl',
    })
    const removers = Object.entries(dictionaries).map(([namespace, dictionary]) =>
      ctx.locale.register(namespace, ARABIC_LOCALE, dictionary))
    ctx.locale.setLocaleIfUnset(ARABIC_LOCALE)
    return () => {
      for (const remove of removers.reverse()) remove()
      removeLanguage()
    }
  }, 'locale-ar: Arabic dictionaries and direction')
}
