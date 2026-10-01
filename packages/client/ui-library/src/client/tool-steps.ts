/** Shared transcriber step copy for job progress and Tool rows. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './locales.ts'

/** The transcriber tools a step can name, each with its sentence. */
export const STEP_KEYS: Readonly<Record<string, Parameters<TranslateNS<'library'>>[0]>> = {
  begin_lecture: 'job.step.prepare',
  doctor: 'job.step.doctor',
  list_modules: 'job.step.find',
  list_lectures: 'job.step.find',
  prepare_manifest: 'job.step.prepare',
  build_exam_index: 'job.step.index',
  start_draft: 'job.step.fetch',
  read_draft: 'job.step.read',
  extract_figures: 'job.step.figures',
  drafting_reference: 'job.step.rules',
  stage_draft_part: 'job.step.write',
  apply_review: 'job.step.save',
  validate_draft: 'job.step.check',
  verify_provenance: 'job.step.provenance',
  finalize: 'job.step.finalize',
  audit_sources: 'job.step.audit',
}
