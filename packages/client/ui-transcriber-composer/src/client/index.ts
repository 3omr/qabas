/** Egyptian Arabic lecture choices docked above the existing composer. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createReadModules } from '@deepseek-ai/dsh-client-transcriber-workspace'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { TranscriberComposer } from './TranscriberComposer.tsx'
import { transcriberComposerFace } from './face.ts'
import { en, zh } from './locales.ts'
import { createTranscriberComposerStore } from './store.ts'

export type { TranscriberComposerKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'transcriberComposer'

/** Browser services and slot registries required by the lecture strip. */
export const inject = ['slots', 'remote', 'remote.workspaceFiles', 'remote.transcriberEngine', 'locale']

/** Register the strip and its built-in dictionaries. */
export function apply(ctx: ClientContext): void {
  const store = createTranscriberComposerStore()
  const face = transcriberComposerFace(createReadModules(ctx.remote))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-transcriber-composer: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'transcriber-composer',
    order: 5,
    locale: NS,
    store,
    inject: (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createTranscriberComposerStore>>) => ({
      ...face(sessionId, actions),
    }),
  }, TranscriberComposer))
}
