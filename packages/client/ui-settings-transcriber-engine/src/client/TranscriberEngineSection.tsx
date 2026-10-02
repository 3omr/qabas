/** Settings page that turns the engine doctor report into actionable rows. */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CatalogPage, DetailPane } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type {
  CatalogEntry, CatalogFilter, CatalogPageCopy, CatalogStatus,
} from '@deepseek-ai/dsh-client-ui-settings-catalog'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  TranscriberDependencyReport, TranscriberDoctorReport,
} from '@deepseek-ai/dsh-api-transcriber-engine/types'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import type { en } from './locales.ts'
import css from './TranscriberEngineSection.module.css'
import { NotebookLmConnect } from './NotebookLmConnect.tsx'
import { DependencyInstall } from './DependencyInstall.tsx'
import { useDoctor } from './doctor.ts'

/** Client service delivered by the capability package. */
export interface TranscriberEngineSectionInjected {
  readonly engine: TranscriberEngineClient
}

/** Props composed by the Settings slot renderer. */
export type TranscriberEngineSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.transcriberEngine'>
  & InjectFace<TranscriberEngineSectionInjected>

type Translate = (key: keyof typeof en, params?: Record<string, string>) => string

/**
 * The localized purpose for a tool the engine reports, or the engine's own.
 *
 * The engine writes these in English on purpose: it is run from a terminal as
 * well, where English is right and a translation layer would be noise. They
 * are still user-facing here, so this page carries copy for the tools it knows
 * and falls back to what the engine said for anything it does not — a tool
 * added upstream shows an English sentence rather than a missing one.
 * @param name - dependency name exactly as the engine reports it.
 * @param fallback - the engine's own English purpose.
 * @param t - namespace-bound translate.
 * @returns the sentence to show.
 */
export function purposeOf(name: string, fallback: string, t: Translate): string {
  const key = `tool.${name}` as keyof typeof en
  // A miss can come back as the key or as nothing at all, depending on which
  // translate reaches this: the app's returns undefined, a test's echoes the
  // key. Both mean "no copy for this tool", and treating only one of them as a
  // miss put the literal word "undefined" in front of the student for any tool
  // the engine added that this page does not carry.
  const localized = t(key) as string | undefined
  return localized === undefined || localized === key ? fallback : localized
}

/**
 * The localized reason a present tool still fails, or the engine's own.
 *
 * Same bargain as {@link purposeOf}: the engine writes for a terminal, this
 * page writes for a student. Without it the one hint the engine has -- the one
 * shown at the exact moment a student is stuck -- arrived as an English
 * paragraph in the middle of an Arabic page.
 * @param name - dependency name exactly as the engine reports it.
 * @param fallback - the engine's own English hint.
 * @param t - namespace-bound translate.
 * @returns the sentence to show.
 */
export function failureHintOf(name: string, fallback: string, t: Translate): string {
  const key = `hint.${name}` as keyof typeof en
  const localized = t(key) as string | undefined
  return localized === undefined || localized === key ? fallback : localized
}

/**
 * Tools the app never offers. The local whisper engine is one: Qabas
 * transcribes through NotebookLM only, so installing it would be a dead end.
 * @param name - the engine's dependency name.
 * @returns whether to leave it off every list.
 */
export function isHidden(name: string): boolean {
  return /whisper/iu.test(name)
}

/** Render one dependency's standing from the report's explicit probe facts. */
export function dependencyStatus(
  report: Pick<TranscriberDoctorReport, 'live'>,
  dependency: Pick<TranscriberDependencyReport, 'name' | 'resolved' | 'probe'>,
  notebookConnected?: boolean,
): CatalogStatus {
  if (!dependency.resolved) return 'unset'
  if (dependency.name === 'nlm' && notebookConnected !== true) return 'attention'
  if (!report.live) return 'ready'
  return dependency.probe?.passed === true ? 'ready' : 'attention'
}

/** Render the readiness page. */
export function TranscriberEngineSection({ engine, t }: TranscriberEngineSectionProps): ReactNode {
  return <Loaded engine={engine} t={t} />
}

function Loaded({ engine, t }: { readonly engine: TranscriberEngineClient; readonly t: Translate }): ReactNode {
  const { state, notebookConnected, check, onInstalled, onConnectionStatus, onAuthorized } = useDoctor(engine)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const report = state.report
  const dependencies = (report?.dependencies ?? []).filter(dependency => !isHidden(dependency.name))
  const entries: CatalogEntry[] = useMemo(() => report === undefined ? [] : dependencies.map((dependency) => {
    const status = dependencyStatus(report, dependency, notebookConnected)
    return {
      id: dependency.name,
      label: dependency.name,
      hint: t('rowHint', {
        purpose: purposeOf(dependency.name, dependency.purpose, t),
        requirement: t(dependency.required ? 'required' : 'optional'),
      }),
      status,
      keywords: [dependency.purpose, purposeOf(dependency.name, dependency.purpose, t)],
    }
  }), [dependencies, notebookConnected, report, t])
  const filters: CatalogFilter[] = [
    { id: 'all', label: t('filterAll') },
    { id: 'ready', label: t('filterReady'), statuses: ['ready'] },
    { id: 'attention', label: t('filterAttention'), statuses: ['attention'] },
    { id: 'unset', label: t('filterUnset'), statuses: ['unset'] },
  ]
  const copy: CatalogPageCopy = {
    search: t('search'),
    groupReady: t('groupReady'),
    groupRest: t('groupRest'),
    noMatches: t('noMatches'),
    noSelection: t('noSelection'),
    status: {
      ready: t('statusReady'),
      attention: t('statusAttention'),
      unset: t('statusUnset'),
    },
  }
  const selected = dependencies.find(dependency => dependency.name === selectedId)
  const active = selected === undefined ? dependencies[0] : selected
  const statusLabel = active === undefined || report === undefined
    ? undefined
    : copy.status[dependencyStatus(report, active, notebookConnected)]
  const loading = state.status === 'loading'

  useEffect(() => {
    if (active !== undefined && active.name !== selectedId) setSelectedId(active.name)
  }, [active, selectedId])

  return (
    <section className={css.section} aria-busy={loading} data-transcriber-engine-section="">
      <div>
        <h2 className={css.heading}>{t('title')}</h2>
        <p className={css.description}>{t('description')}</p>
      </div>
      <div className={css.toolbar}>
        <p className={css.status} role={loading ? 'status' : undefined}>
          {loading ? t(state.mode === 'live' ? 'checkingLive' : 'checkingPresence') : report?.live ? t('liveChecked') : t('presenceChecked')}
        </p>
        <div className={css.actions}>
          <Button size="sm" disabled={loading} onClick={() => { check('presence') }}>
            {t(state.status === 'error' ? 'retry' : 'checkAgain')}
          </Button>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => { check('live') }}>
            {t('runLiveChecks')}
          </Button>
        </div>
      </div>
      {state.status === 'error' ? (
        <p className={css.error} role="alert">
          {t('loadError', { message: state.message })}
        </p>
      ) : null}
      {report === undefined ? null : (
        <div className={css.catalog}>
          <CatalogPage
            entries={entries}
            filters={filters}
            copy={copy}
            selectedId={active?.name}
            onSelect={setSelectedId}
          >
            {active === undefined ? null : (
              <DetailPane
                title={active.name}
                status={dependencyStatus(report, active, notebookConnected)}
                {...(statusLabel === undefined ? {} : { statusLabel })}
                description={purposeOf(active.name, active.purpose, t)}
                tabs={[{
                  id: 'details',
                  label: t('details'),
                  content: (
                    <>
                      <DependencyDetails
                        dependency={active}
                        report={report}
                        engine={engine}
                        t={t}
                        onInstalled={onInstalled}
                        notebookConnected={notebookConnected}
                      />
                      {active.name === 'nlm' && (
                        <NotebookLmConnect
                          engine={engine}
                          t={t}
                          onAuthorized={onAuthorized}
                          onConnectionStatus={onConnectionStatus}
                        />
                      )}
                    </>
                  ),
                }]}
                activeTabId="details"
                onSelectTab={() => {}}
              />
            )}
          </CatalogPage>
        </div>
      )}
    </section>
  )
}

function DependencyDetails({
  dependency, report, engine, t, onInstalled, notebookConnected,
}: {
  readonly dependency: TranscriberDependencyReport
  readonly report: TranscriberDoctorReport
  readonly engine: TranscriberEngineClient
  readonly t: Translate
  readonly onInstalled: (report: TranscriberDoctorReport) => void
  readonly notebookConnected: boolean | undefined
}): ReactNode {
  const status = dependencyStatus(report, dependency, notebookConnected)
  const notWorking = status !== 'ready'
  return (
    <div className={css.detail} data-transcriber-dependency={dependency.name}>
      <dl className={css.facts}>
        <div className={css.fact}><dt>{t('purpose')}</dt><dd>{purposeOf(dependency.name, dependency.purpose, t)}</dd></div>
        <div className={css.fact}><dt>{t('requirement')}</dt><dd>{t(dependency.required ? 'required' : 'optional')}</dd></div>
        <div className={css.fact}><dt>{t('state')}</dt><dd>{t(status === 'ready' ? 'statusReady' : status === 'unset' ? 'statusUnset' : 'statusAttention')}</dd></div>
      </dl>
      {notWorking ? (
        <div className={css.failure} role="alert">
          {dependency.failure_hint.trim() === '' ? null : (
            <div>
              <p>{t('failureHint')}</p>
              <p>{failureHintOf(dependency.name, dependency.failure_hint, t)}</p>
            </div>
          )}
          {status === 'unset' && (
            <DependencyInstall dependency={dependency} engine={engine} t={t} onInstalled={onInstalled} />
          )}
        </div>
      ) : null}
    </div>
  )
}
