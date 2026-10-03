/**
 * How a tool the engine reports reads to a student: its purpose and hint in
 * the page's language, whether the app hides it, and its standing. Shared by
 * the first-run step and the settings page so the two never disagree.
 */
import type { CatalogStatus } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type {
  TranscriberDependencyReport, TranscriberDoctorReport,
} from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type { en } from './locales.ts'

/** Client service delivered by the capability package. */
export interface TranscriberEngineInjected {
  readonly engine: TranscriberEngineClient
}

/** The namespace-bound translate the package's parts take. */
export type Translate = (key: keyof typeof en, params?: Record<string, string>) => string

/**
 * The localized purpose for a tool the engine reports, or the engine's own.
 *
 * The engine writes these in English on purpose: it is run from a terminal as
 * well, where English is right and a translation layer would be noise. They
 * are still user-facing here, so this page carries copy for the tools it knows
 * and falls back to what the engine said for anything it does not — a tool
 * added upstream shows an English sentence rather than a missing one.
 * @param name - dependency name exactly as the engine reports it.
 * @param fallback - the engine's own English purpose.
 * @param t - namespace-bound translate.
 * @returns the sentence to show.
 */
export function purposeOf(name: string, fallback: string, t: Translate): string {
  const key = `tool.${name}` as keyof typeof en
  // A miss can come back as the key or as nothing at all, depending on which
  // translate reaches this: the app's returns undefined, a test's echoes the
  // key. Both mean "no copy for this tool", and treating only one of them as a
  // miss put the literal word "undefined" in front of the student for any tool
  // the engine added that this page does not carry.
  const localized = t(key) as string | undefined
  return localized === undefined || localized === key ? fallback : localized
}

/**
 * The localized reason a present tool still fails, or the engine's own.
 *
 * Same bargain as {@link purposeOf}: the engine writes for a terminal, this
 * page writes for a student. Without it the one hint the engine has -- the one
 * shown at the exact moment a student is stuck -- arrived as an English
 * paragraph in the middle of an Arabic page.
 * @param name - dependency name exactly as the engine reports it.
 * @param fallback - the engine's own English hint.
 * @param t - namespace-bound translate.
 * @returns the sentence to show.
 */
export function failureHintOf(name: string, fallback: string, t: Translate): string {
  const key = `hint.${name}` as keyof typeof en
  const localized = t(key) as string | undefined
  return localized === undefined || localized === key ? fallback : localized
}

/**
 * Tools the app never offers. The local whisper engine is one: Qabas
 * transcribes through NotebookLM only, so installing it would be a dead end.
 * @param name - the engine's dependency name.
 * @returns whether to leave it off every list.
 */
export function isHidden(name: string): boolean {
  return /whisper/iu.test(name)
}

/** Render one dependency's standing from the report's explicit probe facts. */
export function dependencyStatus(
  report: Pick<TranscriberDoctorReport, 'live'>,
  dependency: Pick<TranscriberDependencyReport, 'name' | 'resolved' | 'probe'>,
  notebookConnected?: boolean,
): CatalogStatus {
  if (!dependency.resolved) return 'unset'
  if (dependency.name === 'nlm' && notebookConnected !== true) return 'attention'
  if (!report.live) return 'ready'
  return dependency.probe?.passed === true ? 'ready' : 'attention'
}
