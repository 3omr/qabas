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
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogStatus } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriberDependencyReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import { useDoctor, type Doctor } from './doctor.ts'
import { NotebookLmConnect } from './NotebookLmConnect.tsx'
import { AgyProbeResult, ToolRow } from './SetupStep.tsx'
import { dependencyStatus, isHidden, type TranscriberEngineInjected, type Translate } from './standing.ts'

import { KeyCard, type GeminiKey } from './KeyCard.tsx'
import { OutsideImagesCard } from './OutsideImagesCard.tsx'
import { InstallAllTools } from './InstallAllTools.tsx'
import { ServiceCard, type Standing } from './ServiceCard.tsx'
import css from './AccountsSection.module.css'

export { AI_STUDIO_KEYS, KeyCard } from './KeyCard.tsx'
export type { GeminiKey, KeyCheck, KeyState } from './KeyCard.tsx'

/** What the page is handed besides its copy. */
export interface AccountsSectionInjected extends TranscriberEngineInjected {
  readonly geminiKey: GeminiKey
}

/** Props composed by the Settings slot renderer. */
export type AccountsSectionProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings.transcriberEngine'> & InjectFace<AccountsSectionInjected>


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
      {report !== undefined && <InstallAllTools engine={engine} onReport={doctor.onInstalled} t={t} />}
      <NotebookCard dependency={notebook} doctor={doctor} engine={engine} t={t} />
      <AgyCard dependency={agy} doctor={doctor} engine={engine} t={t} />
      <KeyCard geminiKey={geminiKey} t={t} />
      <ToolsCard tools={tools} doctor={doctor} engine={engine} t={t} />
      <OutsideImagesCard engine={engine} t={t} />
    </section>
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
          compact
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
    : !dependency.resolved ? 'unset' : !tested ? 'ready' : dependency.probe.passed === true ? 'ready' : 'attention'
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
