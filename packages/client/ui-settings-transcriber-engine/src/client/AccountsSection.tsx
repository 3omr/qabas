/**
 * Settings → Accounts and tools: everything Qabas needs to transcribe, on one
 * page, one card per service. Each card says what the service is for, whether
 * it works now, and carries the one control that fixes it when it does not.
 *
 * It replaces two pages that came with the harness: a provider catalog where
 * the only provider Qabas uses sat among dozens, with its key field shown
 * twice under two names, and a tools catalog with a search box and filters
 * for a list of eight. A student does not shop for providers or filter tools;
 * they need to know whether the app can run, and what to do if it cannot.
 */
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogStatus } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriberDependencyReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { useDoctor, type Doctor } from './doctor.ts'
import { NotebookLmConnect } from './NotebookLmConnect.tsx'
import { AgyProbeResult, ToolRow } from './SetupStep.tsx'
import { quotaResetTime } from './quota.ts'
import { dependencyStatus, isHidden, type TranscriberEngineInjected, type Translate } from './standing.ts'
import css from './AccountsSection.module.css'

/** Where a free key is made. */
export const AI_STUDIO_KEYS = 'https://aistudio.google.com/apikey'

/** The stored Gemini key, as far as the page may know it: whether there is one, never its value. */
export interface KeyState {
  readonly configured: boolean
  readonly writable: boolean
}

/** The Gemini key's calls; the value goes in and never comes back out. */
export interface GeminiKey {
  describe(): Promise<KeyState | undefined>
  save(value: string): Promise<string | undefined>
  remove(): Promise<string | undefined>
  /** Call back when the key changed anywhere; returns the unsubscribe. */
  watch(changed: () => void): () => void
}

/** What the page is handed besides its copy. */
export interface AccountsSectionInjected extends TranscriberEngineInjected {
  readonly geminiKey: GeminiKey
}

/** Props composed by the Settings slot renderer. */
export type AccountsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.transcriberEngine'> & InjectFace<AccountsSectionInjected>

type Standing = CatalogStatus | 'checking'

/**
 * The page.
 * @param props - injected services and copy.
 */
export function AccountsSection({ engine, geminiKey, t }: AccountsSectionProps): ReactNode {
  const doctor = useDoctor(engine)
  const report = doctor.state.report
  const loading = doctor.state.status === 'loading'
  const find = (name: string): TranscriberDependencyReport | undefined =>
    report?.dependencies.find(dependency => dependency.name === name)
  const notebook = find('nlm')
  const agy = find('agy')
  const tools = report?.dependencies.filter(dependency => dependency.name !== 'nlm' && dependency.name !== 'agy' && !isHidden(dependency.name)) ?? []
  return (
    <section className={css.page} aria-busy={loading} data-accounts-section="">
      <header className={css.head}>
        <div>
          <h2 className={css.title}>{t('accounts.title')}</h2>
          <p className={css.lead}>{t('accounts.lead')}</p>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={() => { doctor.check('presence') }}>
          {loading ? t('checkingPresence') : t('checkAgain')}
        </Button>
      </header>
      {doctor.state.status === 'error' && (
        <p className={css.error} role="alert">{t('loadError', { message: doctor.state.message })}</p>
      )}
      <NotebookCard dependency={notebook} doctor={doctor} engine={engine} t={t} />
      <AgyCard dependency={agy} doctor={doctor} engine={engine} t={t} />
      <KeyCard geminiKey={geminiKey} t={t} />
      <ToolsCard tools={tools} doctor={doctor} engine={engine} t={t} />
    </section>
  )
}

/**
 * One service: what it is for, whether it works, and what to do about it.
 * @param props.id - stable hook for tests and styles.
 * @param props.title - the service's name.
 * @param props.purpose - one sentence on what it does for the student.
 * @param props.standing - drives the dot and the pill.
 * @param props.state - the pill's words.
 * @param props.children - the card's controls.
 */
function ServiceCard({ id, title, purpose, standing, state, children }: {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly standing: Standing
  readonly state: string
  readonly children?: ReactNode
}): ReactNode {
  return (
    <article className={css.card} data-status={standing} data-account={id} aria-labelledby={`account-${id}`}>
      <div className={css.cardHead}>
        <span className={css.dot} aria-hidden />
        <div className={css.cardText}>
          <h3 id={`account-${id}`} className={css.cardTitle}>{title}</h3>
          <p className={css.purpose}>{purpose}</p>
        </div>
        <span className={css.pill} role={standing === 'checking' ? 'status' : undefined}>{state}</span>
      </div>
      {children !== undefined && children !== false && <div className={css.cardBody}>{children}</div>}
    </article>
  )
}

function NotebookCard({ dependency, doctor, engine, t }: {
  readonly dependency: TranscriberDependencyReport | undefined
  readonly doctor: Doctor
  readonly engine: AccountsSectionInjected['engine']
  readonly t: Translate
}): ReactNode {
  const installed = dependency?.resolved === true
  const standing: Standing = dependency === undefined
    ? 'checking'
    : !installed ? 'unset' : doctor.notebookConnected === undefined ? 'checking' : doctor.notebookConnected ? 'ready' : 'attention'
  const state = {
    checking: t('accounts.checking'),
    unset: t('accounts.notInstalled'),
    ready: t('accounts.notebook.connected'),
    attention: t('accounts.notebook.disconnected'),
  }[standing]
  return (
    <ServiceCard id="notebooklm" title={t('setup.notebook')} purpose={t('accounts.notebook.purpose')} standing={standing} state={state}>
      {dependency !== undefined && !installed && (
        <ToolRow dependency={dependency} status="unset" engine={engine} doctor={doctor} t={t} />
      )}
      {installed && (
        <NotebookLmConnect
          engine={engine}
          t={t}
          onAuthorized={doctor.onAuthorized}
          onConnectionStatus={doctor.onConnectionStatus}
        />
      )}
    </ServiceCard>
  )
}

function AgyCard({ dependency, doctor, engine, t }: {
  readonly dependency: TranscriberDependencyReport | undefined
  readonly doctor: Doctor
  readonly engine: AccountsSectionInjected['engine']
  readonly t: Translate
}): ReactNode {
  const report = doctor.state.report
  const testing = doctor.state.status === 'loading' && doctor.state.mode === 'live'
  const tested = report?.live === true && dependency?.probe?.ran === true
  const standing: Standing = dependency === undefined || testing
    ? 'checking'
    : !dependency.resolved ? 'unset' : !tested ? 'ready' : dependency.probe?.passed === true ? 'ready' : 'attention'
  const state = testing
    ? t('setup.agyChecking')
    : {
      checking: t('accounts.checking'),
      unset: t('accounts.notInstalled'),
      ready: tested ? t('accounts.agy.works') : t('accounts.agy.installed'),
      attention: t('accounts.agy.notAnswering'),
    }[standing]
  return (
    <ServiceCard id="agy" title={t('accounts.agy.title')} purpose={t('accounts.agy.purpose')} standing={standing} state={state}>
      {dependency !== undefined && !dependency.resolved && (
        <ToolRow dependency={dependency} status="unset" engine={engine} doctor={doctor} t={t} />
      )}
      {dependency?.resolved === true && (
        <div className={css.actions}>
          <Button size="sm" variant="outline" disabled={doctor.state.status === 'loading'} onClick={() => { doctor.check('live') }}>
            {t('setup.agyCheck')}
          </Button>
          {report !== undefined && <AgyProbeResult agy={dependency} live={report.live} t={t} />}
        </div>
      )}
    </ServiceCard>
  )
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
      setState({ configured: false, writable: true })
    })
  }

  return (
    <ServiceCard id="gemini-key" title={t('accounts.key.title')} purpose={t('accounts.key.purpose')} standing={standing} state={pill}>
      {configured && !editing && (
        <div className={css.actions}>
          <span className={css.note} role={saved ? 'status' : undefined}>
            {saved ? t('accounts.key.justSaved') : writable ? t('accounts.key.stored') : t('accounts.key.fromEnvironment')}
          </span>
          {writable && !confirmRemove && (
            <>
              <Button size="sm" variant="outline" onClick={() => { setEditing(true); setSaved(false) }}>{t('accounts.key.change')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmRemove(true) }}>{t('accounts.key.remove')}</Button>
            </>
          )}
          {confirmRemove && (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmRemove(false) }}>{t('accounts.key.keep')}</Button>
              <Button size="sm" variant="outline" className={css.danger} disabled={busy} onClick={remove}>{t('accounts.key.removeConfirm')}</Button>
            </>
          )}
        </div>
      )}
      {showField && (
        <form className={css.keyForm} onSubmit={save}>
          <Input
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder="AIza…"
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

function ToolsCard({ tools, doctor, engine, t }: {
  readonly tools: readonly TranscriberDependencyReport[]
  readonly doctor: Doctor
  readonly engine: AccountsSectionInjected['engine']
  readonly t: Translate
}): ReactNode {
  const report = doctor.state.report
  const [open, setOpen] = useState(false)
  const statusOf = (dependency: TranscriberDependencyReport): CatalogStatus =>
    report === undefined ? 'unset' : dependencyStatus(report, dependency, doctor.notebookConnected)
  const required = tools.filter(tool => tool.required)
  const missing = required.filter(tool => statusOf(tool) !== 'ready')
  const standing: Standing = report === undefined ? 'checking' : missing.length === 0 ? 'ready' : 'attention'
  const state = {
    checking: t('accounts.checking'),
    ready: t('accounts.tools.ready'),
    attention: t('accounts.tools.missing', { count: String(missing.length) }),
    unset: '',
  }[standing]
  // The ones that need doing are shown without asking; the rest fold away.
  const shown = open ? tools : missing
  return (
    <ServiceCard id="tools" title={t('accounts.tools.title')} purpose={t('accounts.tools.purpose')} standing={standing} state={state}>
      {report !== undefined && (
        <>
          {shown.length > 0 && (
            <div className={css.tools}>
              {shown.map(dependency => (
                <ToolRow
                  key={dependency.name}
                  dependency={dependency}
                  status={statusOf(dependency)}
                  engine={engine}
                  doctor={doctor}
                  t={t}
                />
              ))}
            </div>
          )}
          <button type="button" className={css.disclosure} aria-expanded={open} onClick={() => { setOpen(!open) }}>
            <span className={css.chevron} data-open={open} aria-hidden>›</span>
            {open ? t('accounts.tools.hide') : t('accounts.tools.show', { count: String(tools.length) })}
          </button>
        </>
      )}
    </ServiceCard>
  )
}
