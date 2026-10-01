/**
 * The library's own actions: each one opens a conversation on the transcriber
 * agent in the study workspace and sends it one Egyptian Arabic sentence.
 *
 * These are the fallback, not the product. A plugin that runs the same work in
 * the background registers actions with the same ids, which replaces these;
 * until one does, every button still does something real.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { canTranscribe } from './model.ts'
import type { LibraryAction, LibraryTarget } from './service.ts'
import type {} from './locales.ts'

/** The agent preset whose prompt is the transcriber skill's procedure. */
export const TRANSCRIBER_PRESET = 'transcriber'

/** The layout's reserved key for the Conversation. */
const CONVERSATION_PANEL = 'conversation' as MainPanelId

/** Opens a conversation and sends it one sentence. */
export type StartConversation = (sentence: string | undefined) => Promise<void>

/**
 * The sentence for one action. The lecture is named exactly as the engine
 * lists it, emoji and all: that title is what the transcriber matches its
 * recordings on, and a prettier one could name a different unit.
 * @param kind - which action.
 * @param target - what it runs on.
 * @returns the sentence.
 */
export function sentence(kind: 'transcribe' | 'continue' | 'audit' | 'questions', target: LibraryTarget): string {
  const module = `«${target.module.displayName}»`
  const lecture = `«${target.lecture?.title ?? ''}»`
  switch (kind) {
    case 'transcribe': return `فرّغ محاضرة ${lecture} من موديول ${module}.`
    case 'continue': return `كمّل تفريغ محاضرة ${lecture} من موديول ${module} من المسودة اللي اتحفظت، لحد ما يخلص.`
    case 'audit': return `راجع مصادر موديول ${module} وقولي لو في حاجة ناقصة.`
    case 'questions': return `ابني فهرس الأسئلة لموديول ${module}.`
  }
}

/**
 * Build the conversation starter the actions share.
 * @param ctx - client root context.
 * @param workspace - the study workspace path, read when the action runs.
 * @returns the starter.
 */
export function conversationStarter(ctx: Context, workspace: () => string | undefined): StartConversation {
  return async (text) => {
    const cwd = workspace()
    const id: SessionId = await ctx.sessions.create({
      ...cwd === undefined ? {} : { cwd },
      agentPreset: TRANSCRIBER_PRESET,
    })
    ctx.sessions.open(id)
    ctx.layout.selectPanel(CONVERSATION_PANEL)
    if (text !== undefined) await ctx.sessions.scope(id)?.conversation.send(text)
  }
}

/**
 * The fallback actions.
 * @param t - this package's translate.
 * @param start - conversation starter.
 * @returns the actions, in page order.
 */
export function chatActions(t: TranslateNS<'library'>, start: StartConversation): LibraryAction[] {
  return [
    {
      id: 'transcribe',
      order: 10,
      scope: 'lecture',
      label: () => t('action.transcribe'),
      appliesTo: target => target.lecture !== undefined && canTranscribe(target.lecture)
        && target.lecture.state !== 'draft',
      primary: () => true,
      run: target => start(sentence('transcribe', target)),
    },
    {
      id: 'continue',
      order: 20,
      scope: 'lecture',
      label: () => t('action.continue'),
      appliesTo: target => target.lecture?.state === 'draft',
      primary: () => true,
      run: target => start(sentence('continue', target)),
    },
    {
      id: 'questions',
      order: 30,
      scope: 'module',
      label: () => t('action.questions'),
      appliesTo: () => true,
      run: target => start(sentence('questions', target)),
    },
    {
      id: 'audit',
      order: 40,
      scope: 'module',
      label: () => t('action.audit'),
      appliesTo: () => true,
      run: target => start(sentence('audit', target)),
    },
  ]
}
