import type { ReactNode } from 'react'
import type { TranscriberEngineLocaleKey } from './locales.ts'
import type { InstallOutputChunk } from './install-feedback.ts'
import css from './Controls.module.css'

type Translate = (key: TranscriberEngineLocaleKey) => string

/**
 * Show installer output on demand while keeping failure details open initially.
 * @param props - streamed output, initial disclosure state and localized copy.
 * @returns a disclosure, or nothing when the installer produced no output.
 */
export function InstallOutputDetails({ chunks, expanded, t }: {
  readonly chunks: readonly InstallOutputChunk[]
  readonly expanded: boolean
  readonly t: Translate
}): ReactNode {
  const stdout = chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('')
  const stderr = chunks.filter(chunk => chunk.stream === 'stderr').map(chunk => chunk.text).join('')
  if (stdout === '' && stderr === '') return null
  return (
    <details className={css.installDetails} open={expanded}>
      <summary>{t('installOutputDetails')}</summary>
      {stderr !== '' && (
        <section className={css.installOutputGroup}>
          <p className={css.installOutputLabel}>{t('installOutputStderr')}</p>
          <pre className={css.installOutput} dir="ltr">{stderr}</pre>
        </section>
      )}
      {stdout !== '' && (
        <section className={css.installOutputGroup}>
          <p className={css.installOutputLabel}>{t('installOutputStdout')}</p>
          <pre className={css.installOutput} dir="ltr">{stdout}</pre>
        </section>
      )}
    </details>
  )
}
