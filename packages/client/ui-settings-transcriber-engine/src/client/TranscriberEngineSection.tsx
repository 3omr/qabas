/** Settings page that turns the engine doctor report into actionable rows. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
type CheckMode = 'presence' | 'live'
type ViewState =
  | { readonly status: 'loading'; readonly mode: CheckMode; readonly report?: TranscriberDoctorReport }
  | { readonly status: 'ready'; readonly report: TranscriberDoctorReport }
  | { readonly status: 'error'; readonly message: string; readonly report?: TranscriberDoctorReport }

/** Render one dependency's standing from the report's explicit probe facts. */
export function dependencyStatus(
  report: Pick<TranscriberDoctorReport, 'live'>,
  dependency: Pick<TranscriberDependencyReport, 'resolved' | 'probe'>,
): CatalogStatus {
  if (!dependency.resolved) return 'unset'
  if (!report.live) return 'ready'
  return dependency.probe?.passed === true ? 'ready' : 'attention'
}

/** Render the readiness page. */
export function TranscriberEngineSection({ engine, t }: TranscriberEngineSectionProps): ReactNode {
  return <Loaded engine={engine} t={t} />
}

function Loaded({ engine, t }: { readonly engine: TranscriberEngineClient; readonly t: Translate }): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading', mode: 'presence' })
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
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

  useEffect(() => {
    check('presence')
    return () => { activeRequest.current?.abort() }
  }, [check])

  const report = state.report
  const dependencies = report?.dependencies ?? []
  const entries: CatalogEntry[] = useMemo(() => report === undefined ? [] : dependencies.map((dependency) => {
    const status = dependencyStatus(report, dependency)
    return {
      id: dependency.name,
      label: dependency.name,
      hint: t('rowHint', {
        purpose: dependency.purpose,
        requirement: t(dependency.required ? 'required' : 'optional'),
      }),
      status,
      keywords: [dependency.purpose],
    }
  }), [dependencies, report, t])
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
    : copy.status[dependencyStatus(report, active)]
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
                status={dependencyStatus(report, active)}
                {...(statusLabel === undefined ? {} : { statusLabel })}
                description={active.purpose}
                tabs={[{ id: 'details', label: t('details'), content: <DependencyDetails dependency={active} report={report} t={t} /> }]}
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
  dependency, report, t,
}: {
  readonly dependency: TranscriberDependencyReport
  readonly report: TranscriberDoctorReport
  readonly t: Translate
}): ReactNode {
  const status = dependencyStatus(report, dependency)
  const notWorking = status !== 'ready'
  return (
    <div className={css.detail} data-transcriber-dependency={dependency.name}>
      <dl className={css.facts}>
        <div className={css.fact}><dt>{t('purpose')}</dt><dd>{dependency.purpose}</dd></div>
        <div className={css.fact}><dt>{t('requirement')}</dt><dd>{t(dependency.required ? 'required' : 'optional')}</dd></div>
        <div className={css.fact}><dt>{t('state')}</dt><dd>{t(status === 'ready' ? 'statusReady' : status === 'unset' ? 'statusUnset' : 'statusAttention')}</dd></div>
      </dl>
      {notWorking ? (
        <div className={css.failure} role="alert">
          {dependency.failure_hint.trim() === '' ? null : (
            <div>
              <p>{t('failureHint')}</p>
              <p>{dependency.failure_hint}</p>
            </div>
          )}
          <div>
            <p>{t('installCommand')}</p>
            <code className={css.command}>{dependency.install_command}</code>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}
