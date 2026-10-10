/**
 * `brand` namespace dictionaries, and the namespace's declaration. The
 * Egyptian Arabic dictionary lives in the Arabic language pack.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Product identity: the accessible name of the drawn marks. */
    brand: BrandKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  name: 'Qabas',
}

/** Every key the namespace declares. */
export type BrandKey = keyof typeof en
