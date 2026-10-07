/**
 * The readiness page as a first-run setup step. Not the settings page in a
 * frame: a checklist a student reads top to bottom — NotebookLM first, then
 * the tools a transcription cannot run without, each with its install button
 * right under it, and the optional tools folded away.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, SetupStage, SetupStageActions, type SetupProgress } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogStatus } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriberDependencyReport } from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { InstallAllTools } from './InstallAllTools.tsx'
import { DependencyInstall } from './DependencyInstall.tsx'
import { KeyCard, type GeminiKey } from './KeyCard.tsx'
import { useDoctor, type Doctor } from './doctor.ts'
import { NotebookLmConnect } from './NotebookLmConnect.tsx'
import { dependencyStatus, failureHintOf, isHidden, purposeOf, type TranscriberEngineInjected } from './standing.ts'
import type { en } from './locales.ts'
import css from './SetupStep.module.css'

/** What the step is handed besides its copy. */
export interface SetupStepInjected extends TranscriberEngineInjected {
  /** Write-only Gemini credential and route provisioning shared with the settings page. */
  readonly geminiKey: GeminiKey
  readonly progress: SetupProgress | undefined
}

/** The step's props. */
export type SetupStepProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<SetupStepInjected> & PropsLocale<'settings.transcriberEngine'>

type Translate = (key: keyof typeof en, params?: Record<string, string>) => string

const STATUS_KEY = { ready: 'statusReady', attention: 'statusAttention', unset: 'statusUnset' } as const

/**
 * The tools step.
 * @param props - owner share, injected face and copy.
 */
export function SetupStep({ complete, engine, geminiKey, progress, t }: SetupStepProps): ReactNode {
  const doctor = useDoctor(engine)
  const report = doctor.state.report
  const loading = doctor.state.status === 'loading'
  const notebook = report?.dependencies.find(dependency => dependency.name === 'nlm')
  // agy gets its own section: it is what keeps a free Gemini key under its limits.
  const agy = report?.dependencies.find(dependency => dependency.name === 'agy')
  const listed = (dependency: TranscriberDependencyReport): boolean => dependency.name !== 'nlm' && dependency.name !== 'agy' && !isHidden(dependency.name)
  const required = report?.dependencies.filter(dependency => dependency.required && listed(dependency)) ?? []
  const optional = report?.dependencies.filter(dependency => !dependency.required && listed(dependency)) ?? []
  const statusOf = (dependency: TranscriberDependencyReport): CatalogStatus =>
    report === undefined ? 'unset' : dependencyStatus(report, dependency, doctor.notebookConnected)
  const ready = report !== undefined
    && [notebook, ...required].every(dependency => dependency === undefined || statusOf(dependency) === 'ready')
  // NotebookLM's sign-in is probed after the report: until it answers, say so
  // rather than calling an installed tool broken.
  const checking = (dependency: TranscriberDependencyReport): boolean =>
    dependency.name === 'nlm' && dependency.resolved && doctor.notebookConnected === undefined
  const row = (dependency: TranscriberDependencyReport, children?: ReactNode): ReactNode => (
    <ToolRow
      key={dependency.name}
      dependency={dependency}
      status={statusOf(dependency)}
      checking={checking(dependency)}
      engine={engine}
      doctor={doctor}
      t={t}
    >
      {children}
    </ToolRow>
  )

  return (
    <SetupStage
      label={t('setup.label')}
      progress={progress}
      eyebrow={t('setup.eyebrow')}
      title={t('setup.title')}
      lead={ready ? t('setup.leadReady') : t('setup.lead')}
      footer={(
        <>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => { doctor.check('presence') }}>
            {loading ? t('checkingPresence') : t('checkAgain')}
          </Button>
          <SetupStageActions>
            {!ready && <Button variant="ghost" onClick={complete}>{t('setup.later')}</Button>}
            <Button variant={ready ? 'primary' : 'outline'} onClick={complete}>{t('setup.continue')}</Button>
          </SetupStageActions>
        </>
      )}
    >
      {doctor.state.status === 'error' && (
        <p className={css.error} role="alert">{t('loadError', { message: doctor.state.message })}</p>
      )}
      {report === undefined
        ? <p className={css.waiting} role="status">{t('checkingPresence')}</p>
        : (
          <>
            {/* The key comes first: the assistant answers with it, and it is the
                only account a student has to bring. It replaces the harness's
                provider chooser, which offered providers Qabas does not use. */}
            <InstallAllTools engine={engine} onReport={doctor.onInstalled} t={t} />
            <section className={css.group} aria-label={t('accounts.key.title')}>
              <KeyCard geminiKey={geminiKey} t={t} />
            </section>
            {notebook !== undefined && (
              <section className={css.group} aria-label={t('setup.notebook')}>
                {row(notebook, (
                  <NotebookLmConnect
                    engine={engine}
                    t={t}
                    onAuthorized={doctor.onAuthorized}
                    onConnectionStatus={doctor.onConnectionStatus}
                  />
                ))}
              </section>
            )}
            {agy !== undefined && (
              <section className={css.group} aria-labelledby="setup-agy">
                <h2 id="setup-agy" className={css.groupTitle}>{t('setup.agy')}</h2>
                <p className={css.groupLead}>{t('setup.agyLead')}</p>
                {row(agy, agy.resolved && (
                  <>
                    <Button size="sm" variant="outline" disabled={loading} onClick={() => { doctor.check('live') }}>
                      {loading ? t('setup.agyChecking') : t('setup.agyCheck')}
                    </Button>
                    <AgyProbeResult agy={agy} live={report.live} t={t} />
                  </>
                ))}
              </section>
            )}
            <section className={css.group} aria-labelledby="setup-required">
              <h2 id="setup-required" className={css.groupTitle}>{t('setup.required')}</h2>
              {required.map(dependency => row(dependency))}
            </section>
            {optional.length > 0 && (
              <OptionalTools tools={optional} statusOf={statusOf} row={row} t={t} />
            )}
          </>
        )}
    </SetupStage>
  )
}

function OptionalTools({ tools, statusOf, row, t }: {
  readonly tools: readonly TranscriberDependencyReport[]
  readonly statusOf: (dependency: TranscriberDependencyReport) => CatalogStatus
  readonly row: (dependency: TranscriberDependencyReport) => ReactNode
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const readyCount = tools.filter(tool => statusOf(tool) === 'ready').length
  return (
    <section className={css.group}>
      <button type="button" className={css.disclosure} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span className={css.chevron} data-open={open} aria-hidden>›</span>
        {t('setup.optional', { ready: String(readyCount), count: String(tools.length) })}
      </button>
      {open && tools.map(dependency => row(dependency))}
    </section>
  )
}

/**
 * One tool: its standing, what it is for, the hint when it is broken and its
 * install button when it is missing. The settings page draws the same rows.
 */
export function ToolRow({ dependency, status, checking = false, engine, doctor, t, children }: {
  readonly dependency: TranscriberDependencyReport
  readonly status: CatalogStatus
  readonly checking?: boolean
  readonly engine: TranscriberEngineClient
  readonly doctor: Doctor
  readonly t: Translate
  readonly children?: ReactNode
}): ReactNode {
  const hint = dependency.failure_hint.trim()
  return (
    <div className={css.row} data-status={checking ? 'checking' : status} data-transcriber-dependency={dependency.name}>
      <span className={css.dot} aria-hidden />
      <div className={css.rowBody}>
        <div className={css.rowHead}>
          <span className={css.name} dir="ltr">{dependency.name === 'nlm' ? t('setup.notebook') : dependency.name}</span>
          <span className={css.pill}>{checking ? t('setup.checking') : t(STATUS_KEY[status])}</span>
        </div>
        <p className={css.purpose}>{purposeOf(dependency.name, dependency.purpose, t)}</p>
        {status === 'attention' && hint !== '' && dependency.name !== 'nlm' && (
          <p className={css.hint}>{failureHintOf(dependency.name, dependency.failure_hint, t)}</p>
        )}
        {status === 'unset' && (
          <DependencyInstall dependency={dependency} engine={engine} t={t} onInstalled={doctor.onInstalled} />
        )}
        {children}
      </div>
    </div>
  )
}

/**
 * What the agy test found, in one line: the button alone left the student
 * looking at the same "ready" pill whether agy answered or not.
 */
export function AgyProbeResult({ agy, live, t }: {
  readonly agy: TranscriberDependencyReport
  readonly live: boolean
  readonly t: Translate
}): ReactNode {
  if (!live || agy.probe === null || !agy.probe.ran) return null
  if (agy.probe.passed) return <p className={css.probeOk} role="status">{t('setup.agyWorks')}</p>
  const key = agy.status === 'not-signed-in' ? 'setup.agySignIn' : agy.status === 'model-unavailable' ? 'setup.agyModel' : 'setup.agyFailed'
  return <p className={css.hint} role="alert">{t(key)}</p>
}
