/** First-run provider selection and pi-ai authorization. */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AuthorizationEntryView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelsSettingsState, ModelsSettingsStore, ProviderRow } from './store.ts'
import { onboardingReadiness } from './store.ts'
import { saveDefaultFromDiscovery } from './default-model.ts'
import type { ModelsOperations } from './operations.ts'
import { OnboardingModal } from './OnboardingModal.tsx'
import { SignIn } from './SignIn.tsx'
import type { en } from './locales.ts'
import styles from './ProviderOnboardingDialog.module.css'

/** Dependencies supplied by the Models plugin registration. */
export interface ProviderOnboardingInjected {
  hooks: {
    /** Shared Models-page join state. */
    models: SnapshotStore<ModelsSettingsState>
  }
  /** Shared Models-page join controller. */
  controller: ModelsSettingsStore
  /** Host authorization and settings operations. */
  operations: ModelsOperations
  /** Feature copy. */
  t: (key: keyof typeof en, params?: Record<string, string>) => string
}

/** Slot owner props plus the feature's injected dependencies. */
export type ProviderOnboardingDialogProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<ProviderOnboardingInjected>

/** Providers with the clearest subscription choices lead the list. */
const SUBSCRIPTION_ORDER = ['anthropic', 'openai-codex', 'github-copilot', 'openrouter']

function flowFor(row: ProviderRow, flows: readonly AuthorizationEntryView[]): AuthorizationEntryView | undefined {
  return flows.find(candidate => candidate.key === `${row.entry.settingsNs}/${row.entry.provider}`)
}

function sortProviders(
  rows: readonly ProviderRow[],
  flows: readonly AuthorizationEntryView[],
): ProviderRow[] {
  return rows
    .map((row, index) => ({ row, index, flow: flowFor(row, flows) }))
    .sort((left, right) => {
      const leftPriority = SUBSCRIPTION_ORDER.indexOf(left.row.entry.provider)
      const rightPriority = SUBSCRIPTION_ORDER.indexOf(right.row.entry.provider)
      const leftRank = leftPriority === -1 ? (left.flow?.methods.some(method => method.id === 'oauth') ? 100 : 200) : leftPriority
      const rightRank = rightPriority === -1 ? (right.flow?.methods.some(method => method.id === 'oauth') ? 100 : 200) : rightPriority
      return leftRank - rightRank || left.index - right.index
    })
    .map(entry => entry.row)
}

/**
 * The provider name inside a pi-ai OAuth method's label.
 *
 * pi-ai writes these labels for its own CLI, and it is not consistent about
 * them: Anthropic's is the bare "Anthropic (Claude Pro/Max)", while
 * OpenRouter's, Kimi's and xAI's already read "Sign in with …". Interpolating
 * the second kind into a "Sign in with {provider}" sentence produced "Sign in
 * with Sign in with OpenRouter". Strip the phrase the sentence supplies so the
 * label contributes only the name.
 */
function providerNameOf(label: string): string {
  return label.replace(/^\s*sign in with\s+/i, '')
}

function requirementFor(
  flow: AuthorizationEntryView | undefined,
  t: ProviderOnboardingInjected['t'],
): string {
  const oauth = flow?.methods.find(method => method.id === 'oauth')
  const apiKey = flow?.methods.some(method => method.id !== 'oauth') === true
  if (oauth === undefined) return t('onboardingPasteKey')
  const provider = providerNameOf(oauth.label)
  return apiKey
    ? t('onboardingSignInOrUseKey', { provider })
    : t('onboardingSignInWith', { provider })
}

/**
 * Render the first-run provider chooser. The selected flow owns all auth
 * prompts; a successful authorization also materializes its pi-ai route.
 * @param props - onboarding owner state and Models operations.
 * @returns the modal or null when setup is complete or unavailable.
 */
export function ProviderOnboardingDialog(props: ProviderOnboardingDialogProps): ReactNode {
  const { complete, controller, useModels, operations, t } = props
  const state = useModels(snapshot => snapshot)
  const [flows, setFlows] = useState<readonly AuthorizationEntryView[]>([])
  const [selected, setSelected] = useState<string | undefined>()
  const signedIn = useMemo(
    () => new Set(flows.filter(flow => flow.signedIn).map(flow => flow.key)),
    [flows],
  )
  const readiness = onboardingReadiness(state, signedIn)
  const rows = useMemo(
    () => sortProviders(
      state.rows.filter(row => row.entry.settingsNs === 'llm-pi-ai'),
      flows,
    ),
    [flows, state.rows],
  )
  const selectedRow = rows.find(row => row.entry.provider === selected) ?? rows[0]
  const selectedFlow = selectedRow === undefined ? undefined : flowFor(selectedRow, flows)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    let live = true
    void operations.listFlows().then((listed) => { if (live) setFlows(listed) })
    return () => { live = false }
  }, [operations])

  useEffect(() => {
    if (readiness.kind === 'provider-ready' || readiness.kind === 'adapter-absent' || readiness.kind === 'unavailable') {
      complete()
    }
  }, [complete, readiness.kind])

  if (readiness.kind !== 'credential-missing') return null

  const authorize = async (): Promise<void> => {
    if (selectedRow === undefined || selectedFlow === undefined) return
    const namespace = state.namespaces.get(selectedRow.entry.settingsNs)
    if (namespace === undefined) throw new Error(t('settingsPathUnresolvable'))
    if (!selectedRow.configured) {
      const written = await operations.writeSettings(
        selectedRow.entry.settingsNs,
        [{ op: 'set', path: [...selectedRow.entry.settingsPath], value: {} }],
        namespace.revision,
      )
      if (written.kind !== 'written') {
        throw new Error(written.kind === 'conflict' ? t('conflict') : written.message)
      }
      await saveDefaultFromDiscovery(operations, selectedRow.entry.provider, {
        settingsNs: selectedRow.entry.settingsNs,
        request: { provider: selectedRow.entry.provider },
      })
    }
    await controller.load()
    complete()
  }

  return (
    <OnboardingModal title={t('onboardingTitle')}>
      <p className={styles.description}>{t('onboardingDescription')}</p>
      <div className={styles.providers} role="list" aria-label={t('onboardingProviders')}>
        {rows.map((row) => {
          const flow = flowFor(row, flows)
          const isSelected = row.entry.provider === selectedRow?.entry.provider
          return (
            <button
              key={row.entry.provider}
              type="button"
              className={`${styles.provider} ${isSelected ? styles.providerSelected : ''}`}
              data-onboarding-provider={row.entry.provider}
              aria-pressed={isSelected}
              onClick={() => { setSelected(row.entry.provider) }}
            >
              <span className={styles.providerName}>
                <span>{row.entry.displayName}</span>
                <span className={styles.requirement}>{requirementFor(flow, t)}</span>
              </span>
            </button>
          )
        })}
      </div>
      {selectedRow !== undefined && selectedFlow !== undefined && (
        <div className={styles.selection}>
          <h3 className={styles.selectionTitle}>{selectedRow.entry.displayName}</h3>
          <SignIn entry={selectedFlow} operations={operations} t={t} onAuthorized={authorize} />
        </div>
      )}
      {selectedRow !== undefined && selectedFlow === undefined
        ? <p className={styles.error}>{t('onboardingNoLogin')}</p>
        : null}
      <div className={styles.later}>
        <Button variant="outline" onClick={complete}>{t('onboardingLater')}</Button>
      </div>
    </OnboardingModal>
  )
}
