import type { LectureUnit, ModuleView } from '@deepseek-ai/dsh-client-transcriber-workspace'

/** A request the strip can prepare without executing. */
export type ComposerAction =
  | 'transcribe' | 'review' | 'audit' | 'readiness' | 'findUntranscribed' | 'prepareQuestions'

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
    case 'findUntranscribed': return `دور في النوت بوك على المحاضرات اللي لسه ماتفَرّغتش في موديول ${moduleName}.`
    case 'prepareQuestions': return `جهّز ملف الأسئلة لموديول ${moduleName}.`
    default: return assertNever(action)
  }
}

/**
 * Derive the requests that can apply to the current module and lecture.
 *
 * Notebook-dependent actions stay absent while the engine listing is pending;
 * the strip explains that state beside the choices instead of guessing.
 * @param module - selected module, when one exists.
 * @param lecture - selected lecture, when one exists.
 * @returns applicable actions in the strip's display order.
 */
export function actionsFor(
  module: ModuleView | undefined,
  lecture: LectureUnit | undefined,
): ComposerAction[] {
  if (module === undefined) return []
  const actions: ComposerAction[] = ['audit', 'readiness']
  if (!module.questionFileExists) actions.push('prepareQuestions')
  // A lecture with no local file is still transcribable, and on this product's
  // normal workspace it is the only kind there is: the audio is uploaded once
  // and deleted, and the default route reads the transcript back from the
  // notebook without ever opening the recording. Requiring a local file meant
  // the action could never appear for a student whose recordings all live in
  // NotebookLM -- which is the student this is for.
  if (lecture !== undefined && !lecture.transcribed) actions.unshift('transcribe')
  if (lecture?.transcribed === true) actions.push('review')
  if (module.notebookStatus === 'ready' && module.lectures.some(item => !item.transcribed)) {
    actions.push('findUntranscribed')
  }
  return actions
}
