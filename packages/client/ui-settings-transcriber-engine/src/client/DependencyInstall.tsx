import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  TranscriberDependencyReport, TranscriberDoctorReport, TranscriberInstallFailureCode, TranscriberInstallFrame,
} from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en, TranscriberEngineLocaleKey } from './locales.ts'
import { InstallOutputDetails } from './InstallOutputDetails.tsx'
import { INSTALL_FAILURE_COPY, type InstallOutputChunk } from './install-feedback.ts'
import css from './Controls.module.css'

type Translate = (key: keyof typeof en, params?: Record<string, string>) => string
type InstallStatus = 'idle' | 'running' | 'installed' | 'failed'
type InstallState = {
  readonly status: InstallStatus
  readonly command: string
  readonly prerequisite: string | undefined
  readonly output: readonly InstallOutputChunk[]
  readonly failure: TranscriberInstallFailureCode | undefined
  readonly notice: 'terminal-opened' | undefined
  readonly copied: 'yes' | 'failed' | undefined
}

/** Props for the app-managed dependency installation card. */
export interface DependencyInstallProps {
  readonly dependency: TranscriberDependencyReport
  readonly engine: TranscriberEngineClient
  readonly t: Translate
  readonly onInstalled: (report: TranscriberDoctorReport) => void
}

/** Render an install action or a copyable, explained fallback for one dependency. */
export function DependencyInstall({ dependency, engine, t, onInstalled }: DependencyInstallProps): ReactNode {
  const [state, setState] = useState<InstallState>({
    status: 'idle', command: dependency.install_command ?? '', prerequisite: undefined, output: [], failure: undefined, notice: undefined, copied: undefined,
  })
  const abort = useRef<AbortController | undefined>(undefined)

  useEffect(() => () => { abort.current?.abort() }, [])

  const start = useCallback((): void => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setState(previous => ({ ...previous, status: 'running', prerequisite: undefined, output: [], failure: undefined, notice: undefined, copied: undefined }))
    void (async () => {
      try {
        for await (const frame of engine.installDependency({ name: dependency.name }, controller.signal)) applyFrame(frame)
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, status: 'failed', failure: 'process-failed' }))
      } finally {
        if (abort.current === controller) abort.current = undefined
      }
    })()

    function applyFrame(frame: TranscriberInstallFrame): void {
      if (frame.type === 'plan') {
        setState(previous => ({
          ...previous,
          command: frame.command,
          prerequisite: frame.prerequisite,
          notice: frame.launcher === 'terminal' ? 'terminal-opened' : undefined,
        }))
        return
      }
      if (frame.type === 'output') {
        setState(previous => ({ ...previous, output: [...previous.output, frame] }))
        return
      }
      if (frame.outcome === 'installed') {
        setState(previous => ({ ...previous, status: 'installed', failure: undefined }))
        if (frame.report !== undefined) onInstalled(frame.report)
        return
      }
      setState(previous => ({ ...previous, status: 'failed', failure: frame.reason ?? 'process-failed' }))
    }
  }, [dependency.name, engine, onInstalled])

  const copy = useCallback((): void => {
    const command = state.command.trim()
    const clipboard = typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { readonly clipboard?: Clipboard }).clipboard
    if (command === '' || clipboard === undefined) {
      setState(previous => ({ ...previous, copied: 'failed' }))
      return
    }
    void clipboard.writeText(command).then(() => {
      setState(previous => ({ ...previous, copied: 'yes' }))
    }, () => {
      setState(previous => ({ ...previous, copied: 'failed' }))
    })
  }, [state.command])

  const routeCopy = routeLabel(dependency.install_route, t)
  const automatic = dependency.install_route !== 'manual'
  const running = state.status === 'running'
  return (
    <div className={css.installBox} data-transcriber-install={dependency.name}>
      <p>{t('installRoute')}</p>
      <p>{routeCopy}</p>
      {state.notice === 'terminal-opened' && <p role="status">{t('installTerminalOpened')}</p>}
      {state.status === 'installed' && <p role="status">{t('installInstalled')}</p>}
      {state.status === 'failed' && (
        <div role="alert">
          <p>{t('installFailed')}</p>
          {state.failure === 'package-manager-missing' && state.prerequisite !== undefined && (
            <p>{t(INSTALL_FAILURE_COPY[state.failure], { name: state.prerequisite })}</p>
          )}
          {state.failure !== undefined && state.failure !== 'package-manager-missing' && <p>{t(INSTALL_FAILURE_COPY[state.failure])}</p>}
        </div>
      )}
      <InstallOutputDetails chunks={state.output} expanded={state.status === 'failed'} t={t} />
      {state.command.trim() !== '' && <code className={css.command} dir="ltr">{state.command}</code>}
      <div className={css.installActions}>
        {automatic && (
          <Button size="sm" disabled={running} onClick={start}>
            {running ? t('installRunning') : dependency.install_route === 'user' ? t('installToolUser') : t('installToolPrivileged')}
          </Button>
        )}
        {state.command.trim() !== '' && (
          <Button size="sm" variant="outline" onClick={copy}>
            {state.copied === 'yes' ? t('installCopied') : t('installCopy')}
          </Button>
        )}
      </div>
      {state.copied === 'failed' && <p role="alert">{t('installCopyFailed')}</p>}
    </div>
  )
}

function routeLabel(route: TranscriberDependencyReport['install_route'], t: Translate): string {
  const key: TranscriberEngineLocaleKey = route === 'user'
    ? 'installRouteUser'
    : route === 'privileged' ? 'installRoutePrivileged' : 'installRouteManual'
  return t(key)
}
