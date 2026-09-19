/**
 * Stage one of this package's registration: what the `transcriber` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page
 * offers it as an entry box, and it opens nothing of its own — a lecture is a
 * recording, which no text viewer would have anything to show for.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconSkillOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const TRANSCRIBER_KIND = 'transcriber'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const TRANSCRIBER_ID = '@deepseek-ai/dsh-client-ui-transcriber'

/**
 * The transcriber type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function transcriberDefinition(t: TranslateNS<'transcriber'>): SidebarRightTabDefinition {
  return {
    id: TRANSCRIBER_ID,
    kind: TRANSCRIBER_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      order: 5,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconSkillOutline16,
    }],
  }
}
