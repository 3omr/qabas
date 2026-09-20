import type { LectureUnit, ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'

/** A request the strip can prepare without executing. */
export type ComposerAction = 'transcribe' | 'review' | 'audit' | 'readiness'

function assertNever(value: never): never {
  throw new Error(`ui-transcriber-composer: unknown action ${String(value)}`)
}

/**
 * Write the natural Egyptian Arabic sentence for one selected action.
 * @param action - operation the user wants the chat to handle.
 * @param module - selected module.
 * @param lecture - selected lecture for lecture-scoped actions.
 * @returns the sentence placed into the composer draft.
 */
export function sentenceFor(
  action: ComposerAction,
  module: ModuleView,
  lecture: LectureUnit | undefined,
): string {
  const moduleName = `«${module.displayName}»`
  const lectureName = `«${lecture?.title ?? ''}»`
  switch (action) {
    case 'transcribe': return `فرّغ محاضرة ${lectureName} من موديول ${moduleName}.`
    case 'review': return `راجع مسودة تفريغ محاضرة ${lectureName} في موديول ${moduleName}.`
    case 'audit': return `راجع مصادر موديول ${moduleName} وقولي لو في حاجة ناقصة.`
    case 'readiness': return `اتأكد إن موديول ${moduleName} جاهز للتفريغ وقولي لو في حاجة ناقصة.`
    default: return assertNever(action)
  }
}
