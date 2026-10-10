/** Automatic reading-tool installation and one paper retry. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditOutcome, LectureEditing } from './editing.ts'

/**
 * Prepare one paper and recover missing local reading tools once.
 * @param editing - engine preparation and installer adapter.
 * @param module - owning module.
 * @param path - original paper path.
 * @param signal - cancellation for the operation.
 * @param installing - installation progress callback.
 * @param t - localized installation failure copy.
 * @returns paper preparation outcome.
 */
export async function prepareExam(
  editing: LectureEditing, module: string, path: string, signal: AbortSignal,
  installing: (name: string) => void, t: TranslateNS<'library'>,
): Promise<EditOutcome<null>> {
  if (editing.prepareExamFile === undefined) return { ok: true, value: null }
  const result = await editing.prepareExamFile(module, path, signal)
  if (result.ok || result.code !== 'ocr_tool_missing' || editing.installReadingTool === undefined) return result
  for (const name of result.tools ?? []) {
    signal.throwIfAborted()
    installing(name)
    const installed = await editing.installReadingTool(name, signal)
    if (!installed.ok) return { ok: false, code: 'ocr_install_failed', message: t('exams.toolFailed', { name }) }
  }
  signal.throwIfAborted()
  return editing.prepareExamFile(module, path, signal)
}
