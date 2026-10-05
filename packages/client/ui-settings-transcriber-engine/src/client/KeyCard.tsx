/**
 * The Gemini key card, shared by the Accounts and tools page and first-run
 * setup: one field, a real check against Google, and when the free quota
 * renews.
 */
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GeminiKeyCheck } from '@deepseek-ai/dsh-api-remotes/client'
import { quotaResetTime } from './quota.ts'
import { ServiceCard, type Standing } from './ServiceCard.tsx'
import type { Translate } from './standing.ts'
import css from './AccountsSection.module.css'

/** Where a free key is made. */
export const AI_STUDIO_KEYS = 'https://aistudio.google.com/apikey'

/** The stored Gemini key, as far as the page may know it: whether there is one, never its value. */
export interface KeyState {
  readonly configured: boolean
  readonly writable: boolean
}

/** Credential-safe result of checking the stored Gemini key on the Host. */
export type KeyCheck = GeminiKeyCheck

/** The Gemini key's calls; the value goes in and never comes back out. */
export interface GeminiKey {
  describe(): Promise<KeyState | undefined>
  /**
   * Check the stored key without returning its value.
   * @returns authentication status; catalog acceptance does not prove generation quota.
   */
  check(): Promise<KeyCheck>
  save(value: string): Promise<string | undefined>
  remove(): Promise<string | undefined>
  /** Call back when the key changed anywhere; returns the unsubscribe. */
  watch(changed: () => void): () => void
}

/**
 * The Gemini key. One field, one save: the old page offered the same key
 * twice, once as a "Gemini API key" sign-in button and again as an "API key"
 * field, and a student reasonably asked what the difference was.
 */
export function KeyCard({ geminiKey, t, now = () => new Date() }: {
  readonly geminiKey: GeminiKey
  readonly t: Translate
  readonly now?: () => Date
}): ReactNode {
  const [state, setState] = useState<KeyState | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<KeyCheck | undefined>(undefined)
  // One real request to Google, made on the Host with the stored key; the
  // value never comes back to the page. Run after every save, and on demand.
  const test = (): void => {
    setChecking(true)
    setChecked(undefined)
    void geminiKey.check().then((result) => {
      setChecking(false)
      setChecked(result)
    }, () => {
      setChecking(false)
      setChecked({ status: 'network' })
    })
  }
  useEffect(() => {
    let live = true
    const read = (): void => { void geminiKey.describe().then((value) => { if (live) setState(value) }) }
    read()
    const stop = geminiKey.watch(read)
    return () => { live = false; stop() }
  }, [geminiKey])

  const configured = state?.configured === true
  const writable = state?.writable !== false
  const showField = writable && (editing || (state !== undefined && !configured))
  const standing: Standing = state === undefined ? 'checking' : configured ? 'ready' : 'unset'
  const pill = { checking: t('accounts.checking'), ready: t('accounts.key.saved'), unset: t('accounts.key.missing'), attention: '' }[standing]
  const lang = typeof document === 'undefined' ? 'ar' : document.documentElement.lang || 'ar'

  const save = (event: FormEvent): void => {
    event.preventDefault()
    const value = draft.trim()
    if (value === '') { setError(t('accounts.key.blank')); return }
    if (/\s/u.test(value)) { setError(t('accounts.key.spaces')); return }
    setBusy(true)
    setError(undefined)
    void geminiKey.save(value).then((failure) => {
      setBusy(false)
      if (failure !== undefined) { setError(failure); return }
      setDraft('')
      setEditing(false)
      setSaved(true)
      setState({ configured: true, writable: true })
      test()
    })
  }
  const remove = (): void => {
    setBusy(true)
    setError(undefined)
    void geminiKey.remove().then((failure) => {
      setBusy(false)
      setConfirmRemove(false)
      if (failure !== undefined) { setError(failure); return }
      setSaved(false)
      setChecked(undefined)
      setState({ configured: false, writable: true })
    })
  }

  return (
    <ServiceCard id="gemini-key" title={t('accounts.key.title')} purpose={t('accounts.key.purpose')} standing={standing} state={pill}>
      {configured && !editing && (
        <>
          <p className={css.note} role={saved ? 'status' : undefined}>
            {saved ? t('accounts.key.justSaved') : writable ? t('accounts.key.stored') : t('accounts.key.fromEnvironment')}
          </p>
          {!confirmRemove && (
            <div className={css.actions}>
              <Button size="sm" variant="outline" disabled={checking} onClick={test}>
                {checking ? t('accounts.key.checking') : t('accounts.key.check')}
              </Button>
              {writable && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(true); setSaved(false); setChecked(undefined) }}>
                    {t('accounts.key.change')}
                  </Button>
                  <Button size="sm" variant="ghost" className={css.danger} onClick={() => { setConfirmRemove(true) }}>
                    {t('accounts.key.remove')}
                  </Button>
                </>
              )}
            </div>
          )}
          {confirmRemove && (
            <div className={css.actions}>
              <span className={css.note}>{t('accounts.key.removeAsk')}</span>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmRemove(false) }}>{t('accounts.key.keep')}</Button>
              <Button size="sm" variant="outline" className={css.danger} disabled={busy} onClick={remove}>{t('accounts.key.removeConfirm')}</Button>
            </div>
          )}
          {checked !== undefined && <CheckResult result={checked} reset={quotaResetTime(now(), lang)} t={t} />}
        </>
      )}
      {showField && (
        <form className={css.keyForm} onSubmit={save}>
          <Input
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={t('accounts.key.placeholder')}
            aria-label={t('accounts.key.field')}
            onChange={(event) => { setDraft(event.currentTarget.value); setError(undefined) }}
          />
          <div className={css.actions}>
            <Button size="sm" variant="primary" type="submit" disabled={busy}>{busy ? t('accounts.key.saving') : t('accounts.key.save')}</Button>
            {editing && configured && (
              <Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setDraft(''); setError(undefined) }}>
                {t('accounts.key.cancel')}
              </Button>
            )}
            <a className={css.link} href={AI_STUDIO_KEYS} target="_blank" rel="noreferrer">{t('accounts.key.get')}</a>
          </div>
        </form>
      )}
      {error !== undefined && <p className={css.error} role="alert" dir="auto">{error}</p>}
      <p className={css.note}>{t('accounts.key.reset', { time: quotaResetTime(now(), lang) })}</p>
    </ServiceCard>
  )
}

/**
 * What Google said about the key, in one line a student can act on.
 * @param props.result - the Host's check.
 * @param props.reset - when the free daily quota renews, on the student's clock.
 * @param props.t - translate.
 */
function CheckResult({ result, reset, t }: {
  readonly result: KeyCheck
  readonly reset: string
  readonly t: Translate
}): ReactNode {
  if (result.status === 'works') return <p className={css.ok} role="status">{t('accounts.key.works')}</p>
  const line = result.status === 'quota'
    ? result.limit === 'per-minute' ? t('accounts.key.quotaMinute') : t('accounts.key.quotaDaily', { time: reset })
    : t(`accounts.key.${result.status === 'invalid-key' ? 'invalid' : result.status === 'no-key' ? 'none' : 'network'}`)
  return <p className={css.error} role="alert">{line}</p>
}
