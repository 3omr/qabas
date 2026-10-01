/**
 * The engine doctor as React state: the readiness page and the setup step both
 * read the same report, rerun the same checks and learn NotebookLM's
 * connection the same way.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranscriberDoctorReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'

/** Presence looks for each tool; live runs it. */
export type CheckMode = 'presence' | 'live'

/** The doctor's last answer, kept across a rerun so the rows do not blink. */
export type DoctorState =
  | { readonly status: 'loading'; readonly mode: CheckMode; readonly report?: TranscriberDoctorReport }
  | { readonly status: 'ready'; readonly report: TranscriberDoctorReport }
  | { readonly status: 'error'; readonly message: string; readonly report?: TranscriberDoctorReport }

/** What a doctor-driven view reads and calls. */
export interface Doctor {
  readonly state: DoctorState
  /** NotebookLM's sign-in, once the connect control has asked. */
  readonly notebookConnected: boolean | undefined
  readonly check: (mode: CheckMode) => void
  readonly onInstalled: (report: TranscriberDoctorReport) => void
  readonly onConnectionStatus: (connected: boolean) => void
  readonly onAuthorized: () => void
}

/**
 * Run a presence check on mount and keep the report.
 * @param engine - the engine client.
 * @returns the report and its actions.
 */
export function useDoctor(engine: TranscriberEngineClient): Doctor {
  const [state, setState] = useState<DoctorState>({ status: 'loading', mode: 'presence' })
  const [notebookConnected, setNotebookConnected] = useState<boolean | undefined>(undefined)
  const activeRequest = useRef<AbortController | undefined>(undefined)

  const check = useCallback((mode: CheckMode): void => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setState(previous => ({ status: 'loading', mode, ...previous.report === undefined ? {} : { report: previous.report } }))
    void engine.doctor({ live: mode === 'live' }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) setState({ status: 'ready', report: result.value })
      else setState(previous => ({
        status: 'error',
        message: `${result.error.code}: ${result.error.message}`,
        ...previous.report === undefined ? {} : { report: previous.report },
      }))
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setState(previous => ({
        status: 'error',
        message: messageOf(error),
        ...previous.report === undefined ? {} : { report: previous.report },
      }))
    })
  }, [engine])

  const onInstalled = useCallback((freshReport: TranscriberDoctorReport): void => {
    setState({ status: 'ready', report: freshReport })
  }, [])
  const onConnectionStatus = useCallback((connected: boolean): void => {
    setNotebookConnected(connected)
  }, [])
  const onAuthorized = useCallback((): void => {
    setNotebookConnected(true)
    check('live')
  }, [check])

  useEffect(() => {
    check('presence')
    return () => { activeRequest.current?.abort() }
  }, [check])

  return { state, notebookConnected, check, onInstalled, onConnectionStatus, onAuthorized }
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}
