import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranscriberAuthFrame } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { en } from './locales.ts'
import css from './Controls.module.css'

type Translate = (key: keyof typeof en, params?: Record<string, string>) => string

/** Props for the NotebookLM authentication conversation. */
export interface NotebookLmConnectProps {
  readonly engine: TranscriberEngineClient
  readonly t: Translate
  readonly onAuthorized: () => void
  readonly onConnectionStatus: (connected: boolean) => void
  /**
   * Drawn inside a card that already names NotebookLM and its state: no
   * heading, and the state lines give way to the card's own.
   */
  readonly compact?: boolean
}

interface AuthPrompt {
  readonly id: string
  readonly message: string
}

interface AuthState {
  readonly status: 'checking' | 'idle' | 'running' | 'connected' | 'cancelled' | 'failed'
  readonly lines: readonly string[]
  readonly prompt: AuthPrompt | undefined
  readonly message: string | undefined
  readonly fallback: 'desktop' | 'unavailable' | false
}

const initialState: AuthState = { status: 'checking', lines: [], prompt: undefined, message: undefined, fallback: false }
const URL_PATTERN = /https?:\/\/[^\s<>"']+/u

/** Render the click-to-connect NotebookLM conversation beside the `nlm` row. */
export function NotebookLmConnect({ engine, t, onAuthorized, onConnectionStatus, compact = false }: NotebookLmConnectProps): ReactNode {
  const [state, setState] = useState<AuthState>(initialState)
  const abort = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    void engine.authStatus(controller.signal).then((response) => {
      if (controller.signal.aborted) return
      const connected = response.ok && response.value.connected
      onConnectionStatus(connected)
      setState(previous => ({ ...previous, status: connected ? 'connected' : 'idle' }))
    }, () => {
      if (controller.signal.aborted) return
      onConnectionStatus(false)
      setState(previous => ({ ...previous, status: 'idle' }))
    })
    return () => { controller.abort(); abort.current?.abort() }
  }, [engine, onConnectionStatus])

  const start = useCallback((): void => {
    const controller = new AbortController()
    abort.current = controller
    setState({ status: 'running', lines: [], prompt: undefined, message: undefined, fallback: false })
    void (async () => {
      try {
        for await (const frame of engine.auth(controller.signal)) applyFrame(frame)
      } catch (error: unknown) {
        if (!controller.signal.aborted) setState(previous => ({
          ...previous,
          status: 'failed',
          prompt: undefined,
          fallback: authFallback(error),
        }))
      } finally {
        if (abort.current === controller) abort.current = undefined
        if (!controller.signal.aborted) {
          setState(previous => previous.status === 'running' ? { ...previous, status: 'cancelled' } : previous)
        }
      }
    })()

    function applyFrame(frame: TranscriberAuthFrame): void {
      if (frame.type === 'notice') {
        setState(previous => ({ ...previous, lines: [...previous.lines, frame.message] }))
        return
      }
      if (frame.type === 'prompt') {
        setState(previous => ({ ...previous, prompt: { id: frame.id, message: frame.message } }))
        return
      }
      if (frame.outcome === 'authorized') {
        setState(previous => ({ ...previous, status: 'connected', prompt: undefined, fallback: false }))
        onAuthorized()
        return
      }
      if (frame.outcome === 'failed') {
        setState(previous => ({
          ...previous,
          status: 'failed',
          prompt: undefined,
          message: frame.message,
          fallback: false,
        }))
        return
      }
      setState(previous => ({ ...previous, status: 'cancelled', prompt: undefined }))
    }
  }, [engine, onAuthorized])

  const send = useCallback((value: string): void => {
    const prompt = state.prompt
    if (prompt === undefined) return
    setState(previous => ({ ...previous, prompt: undefined }))
    void engine.answerAuth(value).then((response) => {
      if (response.ok) return
      setState(previous => ({ ...previous, status: 'failed', fallback: 'unavailable', prompt: undefined }))
    }, () => {
      setState(previous => ({ ...previous, status: 'failed', fallback: 'unavailable', prompt: undefined }))
    })
  }, [engine, state.prompt])

  const cancel = useCallback((): void => {
    abort.current?.abort()
    setState(previous => ({ ...previous, status: 'cancelled', prompt: undefined }))
    void engine.cancelAuth().then((response) => {
      if (response.ok) return
      setState(previous => ({ ...previous, status: 'failed', fallback: 'unavailable' }))
    }, () => {
      setState(previous => ({ ...previous, status: 'failed', fallback: 'unavailable' }))
    })
  }, [engine])

  const running = state.status === 'running'
  const transcript = state.lines.join('')
  return (
    <section className={css.auth} data-notebooklm-connect="">
      {!compact && (
        <div className={css.authHeader}>
          <h3 className={css.authTitle}>{t('notebookLmTitle')}</h3>
          <p className={css.authDescription}>{t('notebookLmDescription')}</p>
        </div>
      )}
      {!running && state.status !== 'checking' && (
        <Button size="sm" variant={compact ? 'outline' : 'ghost'} className={css.authStart} onClick={start}>
          {state.status === 'idle' ? t('notebookLmConnect') : t('notebookLmReconnect')}
        </Button>
      )}
      {state.status === 'idle' && <p className={css.authNote}>{t('notebookLmConnectHelp')}</p>}
      {transcript.length > 0 && (
        <ol className={css.authLog} aria-label={t('notebookLmTranscript')} dir="ltr">
          {transcript.split(/\r?\n/u).map((line, index) => <li key={index} className={css.authLine}><OutputLine text={line} /></li>)}
        </ol>
      )}
      {state.status === 'checking' && <p className={css.authNote} role="status">{t('notebookLmChecking')}</p>}
      {running && <p className={css.authNote} role="status">{t('notebookLmConnecting')}</p>}
      {state.prompt !== undefined && running && (
        <form
          className={css.authAsk}
          dir="ltr"
          onSubmit={(event) => { event.preventDefault(); send((new FormData(event.currentTarget).get('response') as string).trim()) }}
        >
          <label className={css.authLabel} htmlFor="notebooklm-auth-response">{state.prompt.message}</label>
          <div className={css.authInputRow}>
            <input
              id="notebooklm-auth-response"
              name="response"
              className={css.authInput}
              type="text"
              aria-label={t('notebookLmInput')}
              placeholder={t('notebookLmInputPlaceholder')}
              autoFocus
            />
            <Button size="sm" type="submit">{t('notebookLmSend')}</Button>
          </div>
        </form>
      )}
      {running && <Button size="sm" variant="outline" onClick={cancel}>{t('notebookLmCancel')}</Button>}
      {state.status === 'connected' && (
        <p className={compact ? css.authNote : css.authSuccess} role="status">{t(compact ? 'notebookLmSession' : 'notebookLmConnected')}</p>
      )}
      {state.status === 'idle' && !compact && <p className={css.authNote} role="status">{t('notebookLmNotConnected')}</p>}
      {state.status === 'cancelled' && <p className={css.authNote}>{t('notebookLmCancelled')}</p>}
      {state.status === 'failed' && !state.fallback && (
        <p className={css.authNote} role="alert">{t('notebookLmFailed', { message: state.message ?? t('notebookLmUnavailable') })}</p>
      )}
      {state.fallback === 'desktop' && (
        <div className={css.authFallback} role="alert">
          <p>{t('notebookLmDesktopOnly')}</p>
        </div>
      )}
      {state.fallback === 'unavailable' && (
        <div className={css.authFallback} role="alert">
          <p>{t('notebookLmUnavailable')}</p>
        </div>
      )}
    </section>
  )
}

function authFallback(error: unknown): 'desktop' | 'unavailable' {
  if (typeof error !== 'object' || error === null) return 'unavailable'
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  const details = 'details' in error && typeof error.details === 'object' && error.details !== null ? error.details : undefined
  const detail = details !== undefined && 'detail' in details && typeof details.detail === 'string' ? details.detail : ''
  return detail === 'native desktop PTY is unavailable'
    || message.includes('native PTY unavailable')
    || message.includes('browser profile')
    ? 'desktop'
    : 'unavailable'
}

function OutputLine({ text }: { readonly text: string }): ReactNode {
  const match = URL_PATTERN.exec(text)
  if (match === null) return <span>{text}</span>
  const rawUrl = match[0]
  const url = rawUrl.replace(/[),.;]+$/u, '')
  const suffix = rawUrl.slice(url.length)
  return (
    <>
      <span>{text.slice(0, match.index)}</span>
      <a href={url} target="_blank" rel="noreferrer noopener" className={css.authUrl}>{url}</a>
      <span>{suffix}{text.slice(match.index + rawUrl.length)}</span>
    </>
  )
}
