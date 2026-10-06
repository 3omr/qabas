/** Sequential preparation of every tool used by Qabas, including optional file converters. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { isHidden, type Translate } from './standing.ts'
import css from './Controls.module.css'

/** A streamed result for one tool in the preparation queue. */
export interface ToolPreparation {
  readonly name: string
  readonly status: 'running' | 'installed' | 'failed' | 'cancelled'
  readonly output: string
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
    let result: ToolPreparation = { name, status: 'running', output: '' }
    update(result)
    try {
      for await (const frame of engine.installDependency({ name }, signal)) {
        if (frame.type === 'output') result = { ...result, output: result.output + frame.text }
        if (frame.type === 'settled') {
          result = { ...result, status: frame.outcome === 'installed' ? 'installed' : 'failed' }
          if (frame.report !== undefined) {
            report = frame.report
            onReport(report)
          }
        }
        update(result)
      }
      if (result.status === 'running') update({ ...result, status: 'failed' })
    } catch {
      if (signal.aborted) update({ ...result, status: 'cancelled' })
      signal.throwIfAborted()
      update({ ...result, status: 'failed' })
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
  const [failed, setFailed] = useState(false)
  const [complete, setComplete] = useState(false)
  useEffect(() => () => { controller.current?.abort() }, [])
  const start = (): void => {
    if (controller.current !== undefined) return
    const active = new AbortController()
    controller.current = active
    setRunning(true)
    setFailed(false)
    setComplete(false)
    setResults([])
    void prepareAllTools(engine, active.signal, (result) => {
      setResults(previous => [...previous.filter(tool => tool.name !== result.name), result])
    }, onReport).then(() => { setComplete(true) }).catch(() => {
      if (!active.signal.aborted) setFailed(true)
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
      {complete && results.every(result => result.status === 'installed') && <p role="status">{t('installAllReady')}</p>}
      {failed && <p role="alert">{t('installFailed')}</p>}
      {results.map(result => (
        <div key={result.name}>
          <p role="status" dir="auto">{result.name}: {t(result.status === 'installed' ? 'installInstalled' : result.status === 'failed' ? 'installFailed' : result.status === 'cancelled' ? 'installAllCancelled' : 'installRunning')}</p>
          {result.output !== '' && <pre className={css.installOutput} dir="ltr">{result.output}</pre>}
        </div>
      ))}
    </div>
  )
}
