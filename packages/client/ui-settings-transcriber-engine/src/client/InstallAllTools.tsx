/** Sequential preparation of every tool used by Qabas, including optional file converters. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranscriberDoctorReport, TranscriberInstallFailureCode } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { isHidden, type Translate } from './standing.ts'
import { InstallOutputDetails } from './InstallOutputDetails.tsx'
import { INSTALL_FAILURE_COPY, type InstallOutputChunk } from './install-feedback.ts'
import css from './Controls.module.css'

/** A streamed result for one tool in the preparation queue. */
export interface ToolPreparation {
  readonly name: string
  readonly status: 'running' | 'installed' | 'failed' | 'cancelled'
  readonly output: readonly InstallOutputChunk[]
  readonly failure: TranscriberInstallFailureCode | undefined
  readonly prerequisite: string | undefined
  readonly message: string | undefined
}

/**
 * Install missing tools sequentially and use fresh reports to skip shared packages.
 * @param engine - installation and doctor client.
 * @param signal - cancellation for the whole queue.
 * @param update - current tool result.
 * @param onReport - fresh discovery results.
 * @returns when every missing application tool has been attempted.
 */
export async function prepareAllTools(
  engine: TranscriberEngineClient,
  signal: AbortSignal,
  update: (result: ToolPreparation) => void,
  onReport: (report: TranscriberDoctorReport) => void,
): Promise<void> {
  const initial = await engine.doctor({ live: false }, signal)
  if (!initial.ok) throw new Error(initial.error.message)
  let report = initial.value
  onReport(report)
  const names = report.dependencies.filter(tool => !isHidden(tool.name)).map(tool => tool.name)
  for (const name of names) {
    signal.throwIfAborted()
    if (report.dependencies.find(tool => tool.name === name)?.resolved === true) continue
    let result: ToolPreparation = {
      name, status: 'running', output: [], failure: undefined, prerequisite: undefined, message: undefined,
    }
    update(result)
    try {
      for await (const frame of engine.installDependency({ name }, signal)) {
        if (frame.type === 'plan' && frame.prerequisite !== undefined) {
          result = { ...result, prerequisite: frame.prerequisite }
        }
        if (frame.type === 'output') result = { ...result, output: [...result.output, frame] }
        if (frame.type === 'settled') {
          result = {
            ...result,
            status: frame.outcome === 'installed' ? 'installed' : 'failed',
            failure: frame.reason,
          }
          if (frame.report !== undefined) {
            report = frame.report
            onReport(report)
          }
        }
        update(result)
      }
      if (result.status === 'running') update({ ...result, status: 'failed', failure: 'process-failed' })
    } catch (error: unknown) {
      if (signal.aborted) update({ ...result, status: 'cancelled' })
      signal.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      update({ ...result, status: 'failed', failure: 'process-failed', message })
    }
  }
}

/**
 * Render preparation, cancellation and per-tool installation output.
 * @param props - client, doctor result callback and localized copy.
 * @returns the queue controls and results.
 */
export function InstallAllTools({ engine, onReport, t }: {
  readonly engine: TranscriberEngineClient
  readonly onReport: (report: TranscriberDoctorReport) => void
  readonly t: Translate
}): ReactNode {
  const controller = useRef<AbortController | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<readonly ToolPreparation[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [complete, setComplete] = useState(false)
  useEffect(() => () => { controller.current?.abort() }, [])
  const start = (): void => {
    if (controller.current !== undefined) return
    const active = new AbortController()
    controller.current = active
    setRunning(true)
    setFailure(undefined)
    setComplete(false)
    setResults([])
    void prepareAllTools(engine, active.signal, (result) => {
      setResults(previous => [...previous.filter(tool => tool.name !== result.name), result])
    }, onReport).then(() => { setComplete(true) }).catch((error: unknown) => {
      if (!active.signal.aborted) setFailure(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (controller.current === active) controller.current = undefined
      setRunning(false)
    })
  }
  return (
    <div className={css.installBox}>
      <p>{t('installAllLead')}</p>
      <Button disabled={running} onClick={start}>{running ? t('installRunning') : t('installAll')}</Button>
      {running && <Button variant="ghost" onClick={() => { controller.current?.abort() }}>{t('installAllCancel')}</Button>}
      {complete && results.length === 0 && <p role="status">{t('installAllNothing')}</p>}
      {complete && results.length > 0 && results.every(result => result.status === 'installed') && <p role="status">{t('installAllReady')}</p>}
      {complete && results.some(result => result.status === 'failed') && (
        <p role="alert">{t('installAllFailed', { count: String(results.filter(result => result.status === 'failed').length) })}</p>
      )}
      {failure !== undefined && <div role="alert"><p>{t('installFailed')}</p><pre className={css.installOutput} dir="auto">{failure}</pre></div>}
      {results.map(result => (
        <div key={result.name}>
          <p role="status" dir="auto">{result.name}: {t(result.status === 'installed' ? 'installInstalled' : result.status === 'failed' ? 'installFailed' : result.status === 'cancelled' ? 'installAllCancelled' : 'installRunning')}</p>
          {result.status === 'failed' && result.failure !== undefined
            && (result.failure !== 'package-manager-missing' || result.prerequisite !== undefined) && (
            <p role="alert">{t(INSTALL_FAILURE_COPY[result.failure], result.prerequisite === undefined ? undefined : { name: result.prerequisite })}</p>
          )}
          {result.status === 'failed' && result.message !== undefined && <p role="alert">{result.message}</p>}
          <InstallOutputDetails chunks={result.output} expanded={result.status === 'failed'} t={t} />
        </div>
      ))}
    </div>
  )
}
