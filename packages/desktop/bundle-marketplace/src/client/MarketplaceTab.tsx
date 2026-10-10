/** Discovery and explicit next-launch commands; no automatic mutation retries. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { LinkIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketplaceEntry, MarketplaceSnapshot, MarketplaceCommandResult } from '../types.ts'
import type { DesktopProfileName } from '@deepseek-ai/dsh-desktop'
import type { BundleCatalogId, BundleReviewToken, BundleDetails, PreparationOperation } from '@deepseek-ai/dsh-bundle-preparation/types'
import { OperationHistory } from './OperationHistory.tsx'
import css from './MarketplaceTab.module.css'

/** Registration-owned callbacks and the renderer-bound connection observation. */
export interface MarketplaceInjected {
  /** The declared locale namespace rerenders the tab when this language changes. */
  catalogLanguage: () => 'en' | 'ar'
  openLocalAgents: () => Promise<MarketplaceCommandResult>
  snapshot: () => Promise<MarketplaceSnapshot>
  history: () => Promise<readonly PreparationOperation[]>
  refreshCatalog: () => Promise<MarketplaceCommandResult>
  install: (
    id: BundleCatalogId, profile: DesktopProfileName, version: string | null, reviewToken: BundleReviewToken,
  ) => Promise<MarketplaceCommandResult>
  cancel: (profile: DesktopProfileName) => Promise<MarketplaceCommandResult>
  remove: (profile: DesktopProfileName, packageName: string, version: string) => Promise<MarketplaceCommandResult>
  hooks: { connectionGeneration: ConnectionGenerationState }
}

/** Slot-owned props, dictionary and injected callbacks. */
export type MarketplaceProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.bundleMarketplace'> & InjectFace<MarketplaceInjected>
  & PropsRenderSlots<'settings.bundleMarketplace.action'>

type ReadState = { generation: number | undefined } & (
  | { status: 'loading' | 'error' }
  | { status: 'ready'; value: MarketplaceSnapshot }
)

const viewCopy = {
  discover: ['title', 'intro'], installed: ['installedTitle', 'inventoryHint'],
  updates: ['updatesTitle', 'updatesHint'], history: ['history', 'historyHint'],
} as const

const catalogCopy = { bundled: 'catalogBundled', online: 'catalogOnline', cached: 'catalogCached', unavailable: 'catalogUnavailable' } as const

/** Reconcile reads on reconnect and every command settlement without replaying commands. */
export function MarketplaceTab(props: MarketplaceProps): ReactNode {
  const { t, snapshot, install, cancel, remove, useConnectionGeneration, renderSlot, close } = props
  const generation = useConnectionGeneration(value => value?.id)
  const language = props.catalogLanguage()
  const [read, setRead] = useState<ReadState>({ status: 'loading', generation: undefined })
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<
    { kind: 'install'; entry: MarketplaceEntry; profile: DesktopProfileName; version: string | null }
    | { kind: 'remove'; profile: DesktopProfileName; packageName: string; version: string } | null
  >(null)
  const [view, setView] = useState<'discover' | 'installed' | 'updates' | 'history'>('discover')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let live = true
    setSelected(null)
    if (generation === undefined) return () => { live = false }
    setRead({ status: 'loading', generation })
    void snapshot().then(
      (value) => { if (live) setRead({ status: 'ready', generation, value }) },
      () => { if (live) setRead({ status: 'error', generation }) },
    )
    return () => { live = false }
  }, [snapshot, generation, revision])
  const value = generation !== undefined && read.generation === generation && read.status === 'ready' ? read.value : undefined
  const run = async (command: () => Promise<MarketplaceCommandResult>): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setSelected(null)
    setUnconfirmed(false)
    try {
      const result = await command()
      if (mounted.current) setUnconfirmed(result === 'unconfirmed')
    } catch {
      if (mounted.current) setUnconfirmed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) { setBusy(false); setRead({ status: 'loading', generation }); setRevision(n => n + 1) }
    }
  }
  const selection = value?.selection
  const pending = selection?.pending
  const current = value?.profiles.find(profile => profile.profile === selection?.activeProfile)
  const canInstall = !busy && current?.state === 'read' && selection !== undefined && selection.pending === null && selection.trial === null
  const installedBundles = new Map(current?.state === 'read' ? current.bundles.map(bundle => [bundle.packageName, bundle]) : [])
  const search = query.trim().toLocaleLowerCase(language)
  const entries = value?.entries.filter((entry) => {
    const installed = installedBundles.get(entry.packageName)
    if (view === 'updates' && (installed === undefined || installed.version === null || installed.version === entry.version)) return false
    return [entry.title, entry.packageName, entry.publisher, entry.details?.[language].summary ?? '']
      .some(text => text.toLocaleLowerCase(language).includes(search))
  }) ?? []
  return <section className={css.root} data-bundle-marketplace="">
    <header className={css.header}><div><h3>{t(viewCopy[view][0])}</h3><p>{t(viewCopy[view][1])}</p></div>
      <button type="button" disabled={busy || generation === undefined} onClick={() => { setRead({ status: 'loading', generation }); setRevision(n => n + 1) }}>{t('refresh')}</button>
    </header>
    {value?.catalog.remoteConfigured && <div className={css.notice}>
      <p role="status">{t(catalogCopy[value.catalog.source])}</p>
      <button type="button" disabled={busy || generation === undefined} onClick={() => { void run(props.refreshCatalog) }}>{t('checkCatalog')}</button>
    </div>}
    {(view === 'discover' || view === 'updates') && <p className={css.notice}>{t('trust')}</p>}
    <div role="group" aria-label={t('views')} className={css.views}>
      <button type="button" aria-pressed={view === 'discover'} onClick={() => { setView('discover'); setSelected(null) }}>{t('discover')}</button>
      <button type="button" aria-pressed={view === 'installed'} onClick={() => { setView('installed'); setSelected(null) }}>{t('installed')}</button>
      <button type="button" aria-pressed={view === 'updates'} onClick={() => { setView('updates'); setSelected(null) }}>{t('updates')}</button>
      <button type="button" aria-pressed={view === 'history'} onClick={() => { setView('history'); setSelected(null) }}>{t('history')}</button>
    </div>
    {(view === 'discover' || view === 'updates') && <label className={css.search}>{t('search')}
      <input type="search" value={query} placeholder={t('searchHint')} onChange={(event) => { setQuery(event.target.value); setSelected(null) }} />
    </label>}
    <LocalAgentsEntry key={generation} t={t} open={props.openLocalAgents} connected={generation !== undefined} />
    {unconfirmed && <p role="alert">{t('unconfirmed')}</p>}
    {view === 'history' ? <OperationHistory key={`${String(generation)}-${String(revision)}`} connected={generation !== undefined} history={props.history} t={t} /> : <>
      {generation === undefined ? <p role="status">{t('offline')}</p>
        : value === undefined ? <p role={read.status === 'error' ? 'alert' : 'status'}>{t(read.status === 'error' ? 'readFailed' : 'loading')}</p>
          : <>
            {view !== 'installed' && <p className={css.current}>{t('current')}: <code>{value.selection.activeProfile}</code></p>}
            {value.selection.lastFailure !== null && <div className={css.notice} role="status">
              <p>{t('recovered')}</p><p>{t(value.selection.lastFailure.reason)}</p>
            </div>}
            {pending && <div className={css.notice} role="status">
              <strong>{t('pending')}</strong><p>{t('pendingHint')}</p>
              <button type="button" disabled={busy} onClick={() => { void run(() => cancel(pending.profile)) }}>{t('cancel')}</button>
            </div>}
            {value.selection.trial !== null && <p role="status">{t('trial')}</p>}
            {view !== 'installed' && current?.state !== 'read' && <p role="alert">{t('inventoryFailed')}</p>}
            {view === 'installed' ? <>
              {value.profiles.map(profile => <section className={css.profile} key={profile.profile} aria-label={profile.profile}>
                <h4>{t(profile.profile === value.selection.activeProfile ? 'current' : profile.profile === pending?.profile ? 'pending' : 'trial')}</h4>
                <details className={css.current}><summary>{t('combinationId')}</summary><code>{profile.profile}</code></details>
                {profile.state === 'unavailable' ? <p role="alert">{t('inventoryFailed')}</p> : <>
                  {profile.bundles.length === 0 && <p>{t('noInstalled')}</p>}
                  <ul className={css.list}>{profile.bundles.map((bundle) => {
                    const version = bundle.version
                    return <li className={css.card} key={bundle.packageName}>
                      <div><h4>{value.entries.find(entry => entry.packageName === bundle.packageName)?.title ?? bundle.packageName}</h4>
                        <p><code>{bundle.packageName}</code></p>
                        <p>{bundle.version === null ? t('versionUnknown') : `${t('version')}: ${bundle.version}`}</p>
                      </div>
                      {bundle.removable && version !== null ? <button type="button"
                        disabled={!canInstall || profile.profile !== value.selection.activeProfile}
                        onClick={() => { setSelected({ kind: 'remove', profile: profile.profile, packageName: bundle.packageName, version }) }}>{t('remove')}</button>
                        : <p>{t('protected')}</p>}
                      {version !== null && profile.profile === value.selection.activeProfile && value.selection.trial === null
                    && <div className={css.contribution}>
                      {renderSlot('settings.bundleMarketplace.action', { close }, { entryKey: bundle.packageName })}
                    </div>}
                    </li>})}</ul>
                </>}
              </section>)}
              {selected?.kind === 'remove' && canInstall && <div className={css.review} role="group" aria-label={t('removeReview')}>
                <strong>{selected.packageName} · {selected.version}</strong><p>{t('removeHint')}</p>
                <button type="button" onClick={() => { void run(() => remove(selected.profile, selected.packageName, selected.version)) }}>{t('confirmRemove')}</button>
                <button type="button" autoFocus onClick={() => { setSelected(null) }}>{t('dismiss')}</button>
              </div>}
            </> : <>
              {entries.length === 0 && (view !== 'updates' || current?.state === 'read') && <p role="status">{t(value.entries.length === 0 ? 'empty' : search ? 'noMatches' : 'noUpdates')}</p>}
              <ul className={css.list}>{entries.map((entry) => {
                const installed = installedBundles.get(entry.packageName)
                const included = installed?.version === entry.version
                return <li className={css.card} key={entry.id}>
                  <div><h4>{entry.title}</h4><p><code>{entry.packageName}</code> · {entry.version}</p>
                    <p>{entry.details === null ? t('detailsUnavailable') : entry.details[language].summary}</p>
                    <p>{t('publisher')}: {entry.publisher}</p>
                    {installed?.version === null && <p>{t('versionUnknown')}</p>}
                    <a href={entry.source} target="_blank" rel="noreferrer noopener"><LinkIcon kind="url" /> {t('source')}</a>
                    {entry.issues.map(issue => <p key={issue}>{t(issue)}</p>)}
                    {entry.details !== null && <details className={css.details}>
                      <summary>{t('details')}</summary>
                      <BundleGuidance details={entry.details} language={language} t={t} />
                    </details>}
                  </div>
                  <button type="button" disabled={!canInstall || entry.issues.length !== 0 || included || installed?.version === null}
                    onClick={() => { setSelected({ kind: 'install', entry, profile: value.selection.activeProfile, version: installed?.version ?? null }) }}>{t(included ? 'included' : installed === undefined ? 'install' : 'replace')}</button>
                </li>})}</ul>
              {selected?.kind === 'install' && canInstall && <div className={css.review} role="group" aria-label={t(selected.version === null ? 'review' : 'replaceReview')}>
                <strong>{selected.entry.title}</strong><p>{t('reviewHint')}</p>
                {selected.entry.details === null ? <p>{t('detailsUnavailable')}</p>
                  : <BundleGuidance details={selected.entry.details} language={language} t={t} />}
                {selected.version !== null && <><p>{selected.version} → {selected.entry.version}</p><p>{t('replaceHint')}</p></>}
                <button type="button" onClick={() => { void run(() => install(selected.entry.id, selected.profile, selected.version, selected.entry.reviewToken)) }}>{t(selected.version === null ? 'confirm' : 'confirmReplace')}</button>
                <button type="button" autoFocus onClick={() => { setSelected(null) }}>{t('dismiss')}</button>
              </div>}
            </>}
          </>}
    </>}
    {busy && <p role="status">{t('preparing')}</p>}
  </section>
}

/** Review text is inert text; setup never becomes a shell command, HTML or a permission grant. */
function BundleGuidance({ details, language, t }: {
  details: BundleDetails
  language: 'en' | 'ar'
  t: MarketplaceProps['t']
}): ReactNode {
  const guide = details[language]
  return <dl className={css.guidance}>
    <div><dt>{t('accounts')}</dt><dd>{guide.accounts}</dd></div>
    <div><dt>{t('access')}</dt><dd>{guide.access}<p>{t('accessHint')}</p></dd></div>
    <div><dt>{t('setup')}</dt><dd>{guide.setup}</dd></div>
    <div><dt>{t('license')}</dt><dd>{details.license}</dd></div>
  </dl>
}

/** Connection-keyed window request; late settlements cannot update a replacement connection. */
function LocalAgentsEntry({ t, open, connected }: {
  t: MarketplaceProps['t']
  open: MarketplaceInjected['openLocalAgents']
  connected: boolean
}): ReactNode {
  const [state, setState] = useState<'idle' | 'opening' | 'unconfirmed'>('idle')
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const show = async (): Promise<void> => {
    setState('opening')
    try {
      const result = await open()
      if (mounted.current) setState(result === 'acknowledged' ? 'idle' : 'unconfirmed')
    } catch {
      if (mounted.current) setState('unconfirmed')
    }
  }
  return <section className={`${css.notice} ${css.agentConnections}`} aria-label={t('localAgents')}>
    <details><summary>{t('localAgents')}</summary><p>{t('localAgentsHint')}</p></details>
    <button type="button" disabled={!connected || state === 'opening'} onClick={() => { void show() }}>
      {t(state === 'opening' ? 'openingAgents' : 'configureAgents')}
    </button>
    {state === 'unconfirmed' && <p role="alert">{t('agentsUnconfirmed')}</p>}
  </section>
}
