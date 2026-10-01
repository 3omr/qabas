/** Shared action rules and sentences, plus explicit visible assistant conversations. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { canTranscribe } from './model.ts'
import { requireConversation } from './conversation.ts'
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
export function sentence(kind: 'transcribe' | 'continue' | 'audit' | 'questions', target: {
  readonly module: Pick<LibraryTarget['module'], 'displayName'>
  readonly lecture?: Pick<NonNullable<LibraryTarget['lecture']>, 'title'>
}): string {
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
    if (text !== undefined) await requireConversation(ctx, id).send(text)
  }
}

/**
 * The actions for consumers that explicitly start visible conversations.
 * @param t - this package's translate.
 * @param start - conversation starter.
 * @returns the actions, in page order.
 */
export function chatActions(t: TranslateNS<'library'>, start: StartConversation): LibraryAction[] {
  return actionRules(t).map(rule => ({ ...rule, run: target => start(sentence(rule.id, target)) }))
}

/**
 * Shared applicability and presentation of chat and background actions.
 * @param t - library translator.
 * @returns ordered action rules with procedure ids.
 */
export function actionRules(t: TranslateNS<'library'>): (Omit<LibraryAction, 'run'> & { readonly id: Parameters<typeof sentence>[0] })[] {
  return [
    {
      id: 'transcribe',
      order: 10,
      scope: 'lecture',
      label: () => t('action.transcribe'),
      appliesTo: target => target.lecture !== undefined && canTranscribe(target.lecture)
        && target.lecture.state !== 'draft',
      primary: () => true,
    },
    {
      id: 'continue',
      order: 20,
      scope: 'lecture',
      label: () => t('action.continue'),
      appliesTo: target => target.lecture?.state === 'draft',
      primary: () => true,
    },
    {
      id: 'questions',
      order: 30,
      scope: 'module',
      label: () => t('action.questions'),
      appliesTo: () => true,
    },
    {
      id: 'audit',
      order: 40,
      scope: 'module',
      label: () => t('action.audit'),
      appliesTo: () => true,
    },
  ]
}
