/** Credential-safe Gemini account calls over the Host Remote. */
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { GeminiKey } from './AccountsSection.tsx'

/** The credential pi-ai reads Google's key from. */
export const GEMINI_KEY_REF = 'GEMINI_API_KEY'

/**
 * The Gemini key's calls over the credentials Remote. The value is written
 * and never read back: the page only learns whether one is stored.
 * @param remote - credential-safe Host credential calls.
 * @param watch - reference-change subscription returning its disposer.
 * @returns the key's calls.
 */
export function geminiKeyOf(remote: Pick<ClientRemote['credentials'], 'describe' | 'set' | 'unset' | 'checkGeminiKey'>,
  watch: (changed: (ref: string) => void) => () => void): GeminiKey {
  return {
    check: async () => {
      try {
        const response = await remote.checkGeminiKey()
        return response.ok ? response.value : { status: 'network' }
      } catch {
        // Remote transport failures have no authenticated check result to display.
        return { status: 'network' }
      }
    },
    describe: async () => {
      const response = await remote.describe([GEMINI_KEY_REF])
      const info = response.ok ? response.value[GEMINI_KEY_REF] : undefined
      return info === undefined ? undefined : { configured: info.configured, writable: info.writable }
    },
    save: async (value) => {
      const response = await remote.set(GEMINI_KEY_REF, value)
      return response.ok ? undefined : response.error.message
    },
    remove: async () => {
      const response = await remote.unset(GEMINI_KEY_REF)
      return response.ok ? undefined : response.error.message
    },
    watch: changed => watch((ref) => {
      if (ref === GEMINI_KEY_REF) changed()
    }),
  }
}
