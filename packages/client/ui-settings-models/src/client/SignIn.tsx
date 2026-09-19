/**
 * The sign-in half of a provider card: the button that starts a subscription
 * login, and the conversation it turns into.
 *
 * A flow is not a form. It says "open this page", waits, and then asks for
 * what the page gave back, so this renders a running transcript rather than a
 * set of fields: every notice is appended, and a question becomes the one
 * input the card is waiting on. The transcript matters because the URL is the
 * whole of the first step — a reader who scrolled past it has no other way to
 * get it back.
 *
 * A key typed here goes into pi-ai's own prompt rather than into the card's
 * API-key field. That is the adapter's arrangement, not this component's: the
 * providers that ship an interactive key login collect it themselves, and
 * routing it through the flow is what lets them validate it before it is
 * stored.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationEntryView, AuthorizationFrame } from '@deepseek-ai/dsh-api-remotes/client'
import type { AuthorizationOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link SignIn}. */
export interface SignInProps {
  /** The flow for this route, as the seam describes it. */
  entry: AuthorizationEntryView
  /** The Host operations that run the conversation. */
  operations: AuthorizationOperations
  /** Namespace-bound translate. */
  t: (key: keyof typeof en, params?: Record<string, string>) => string
  /** Called once a sign-in stores a credential, so the card can re-read it. */
  onAuthorized?: () => void
}

/** A question the flow is waiting on. */
interface Waiting {
  readonly id: string
  readonly message: string
  readonly kind: 'text' | 'secret' | 'select'
  readonly placeholder?: string
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[]
}

/** One line of the running transcript. */
interface Line {
  readonly message: string
  readonly url?: string
  readonly code?: string
}

/**
 * The sign-in control and, while one is running, its transcript.
 * @param props - the flow, the operations, and the copy.
 * @returns the card's sign-in area.
 */
export function SignIn({ entry, operations, t, onAuthorized }: SignInProps): ReactNode {
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [waiting, setWaiting] = useState<Waiting | undefined>()
  const [draft, setDraft] = useState('')
  const [outcome, setOutcome] = useState<
    { kind: 'authorized' } | { kind: 'cancelled' } | { kind: 'failed'; message: string } | undefined
  >()
  const abort = useRef<AbortController | undefined>(undefined)

  // An attempt outlives a closed card only as far as its signal: leaving the
  // page must not leave a flow prompting nobody on the Host.
  useEffect(() => () => { abort.current?.abort() }, [])

  const start = useCallback((method: string | undefined) => {
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setLines([])
    setWaiting(undefined)
    setOutcome(undefined)

    void (async () => {
      try {
        for await (const frame of operations.runFlow(entry.key, method, controller.signal)) {
          apply(frame)
        }
      } catch (error: unknown) {
        setOutcome({ kind: 'failed', message: error instanceof Error ? error.message : String(error) })
      } finally {
        setRunning(false)
        setWaiting(undefined)
        abort.current = undefined
      }
    })()

    function apply(frame: AuthorizationFrame): void {
      if (frame.type === 'notice') {
        setLines(current => [...current, {
          message: frame.message,
          ...frame.url === undefined ? {} : { url: frame.url },
          ...frame.code === undefined ? {} : { code: frame.code },
        }])
        return
      }
      if (frame.type === 'prompt') {
        setDraft('')
        setWaiting({
          id: frame.id,
          message: frame.message,
          kind: frame.kind,
          ...frame.placeholder === undefined ? {} : { placeholder: frame.placeholder },
          ...frame.options === undefined ? {} : { options: frame.options },
        })
        return
      }
      setOutcome({ kind: frame.outcome })
      if (frame.outcome === 'authorized') onAuthorized?.()
    }
  }, [entry.key, operations, onAuthorized])

  const send = useCallback((value: string) => {
    if (waiting === undefined) return
    setWaiting(undefined)
    setDraft('')
    void operations.answer(entry.key, waiting.id, value)
  }, [entry.key, operations, waiting])

  const cancel = useCallback(() => {
    abort.current?.abort()
    void operations.cancelFlow(entry.key)
  }, [entry.key, operations])

  if (entry.methods.length === 0) return null

  return (
    <div className={styles.signIn} data-models-signin={entry.key}>
      {!running && outcome?.kind !== 'authorized' && (
        <div className={styles.signInMethods}>
          {entry.methods.map((method: AuthorizationEntryView['methods'][number]) => (
            <button
              key={method.id}
              type="button"
              className={styles.signInButton}
              data-models-signin-method={method.id}
              onClick={() => { start(method.id) }}
            >
              {method.label}
            </button>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <ol className={styles.signInLog}>
          {lines.map((line, index) => (
            // The transcript is append-only and never reordered, so the index
            // is a stable identity here.
            <li key={index} className={styles.signInLine}>
              <span>{line.message}</span>
              {line.url !== undefined && (
                <a href={line.url} target="_blank" rel="noreferrer noopener" className={styles.signInUrl}>
                  {line.url}
                </a>
              )}
              {line.code !== undefined && <code className={styles.signInCode}>{line.code}</code>}
            </li>
          ))}
        </ol>
      )}

      {waiting !== undefined && waiting.kind !== 'select' && (
        <form
          className={styles.signInAsk}
          onSubmit={(event) => { event.preventDefault(); send(draft.trim()) }}
        >
          <label className={styles.signInLabel} htmlFor={`signin-${entry.key}`}>{waiting.message}</label>
          <input
            id={`signin-${entry.key}`}
            className={styles.signInInput}
            type={waiting.kind === 'secret' ? 'password' : 'text'}
            placeholder={waiting.placeholder}
            value={draft}
            autoFocus
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <button type="submit" className={styles.signInButton} disabled={draft.trim().length === 0}>
            {t('signIn.submit')}
          </button>
        </form>
      )}

      {waiting !== undefined && waiting.kind === 'select' && (
        <div className={styles.signInAsk}>
          <span className={styles.signInLabel}>{waiting.message}</span>
          {(waiting.options ?? []).map(option => (
            <button
              key={option.id}
              type="button"
              className={styles.signInButton}
              onClick={() => { send(option.id) }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {running && (
        <button type="button" className={styles.signInCancel} onClick={cancel}>
          {t('signIn.cancel')}
        </button>
      )}

      {outcome?.kind === 'authorized' && <p className={styles.signInDone}>{t('signIn.authorized')}</p>}
      {outcome?.kind === 'cancelled' && <p className={styles.signInNote}>{t('signIn.cancelled')}</p>}
      {outcome?.kind === 'failed' && (
        <p className={styles.signInNote}>{t('signIn.failed', { message: outcome.message })}</p>
      )}
    </div>
  )
}
