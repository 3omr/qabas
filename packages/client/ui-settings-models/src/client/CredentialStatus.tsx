/** Persistent sidebar recovery affordance when no configured model can run. */

import { useEffect, useState } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ModelsSettingsStore } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import { onboardingReadiness } from './store.ts'
import type { ModelsKey } from './locales.ts'
import styles from './CredentialStatus.module.css'

/** Dependencies supplied by the models-settings registrant. */
export interface CredentialStatusInjected {
  /** Shared models-settings controller. */
  controller: ModelsSettingsStore
  /** Authorization directory used to recognize OAuth-backed routes. */
  operations: Pick<ModelsOperations, 'listFlows'>
  hooks: {
    /** Shared controller snapshot, bound by the slot renderer as useSnapshot. */
    snapshot: ModelsSettingsStore['store']
  }
  /** Models-settings translator. */
  t: (key: ModelsKey, values?: Record<string, string | number>) => string
}

/** Props supplied by the sidebar owner and the models-settings registrant. */
export type CredentialStatusProps =
  SidebarFooterActionOwnerProps & InjectFace<CredentialStatusInjected>

/**
 * Show a durable API-key warning after onboarding can be dismissed.
 * @param props - sidebar geometry and the shared models-settings store.
 * @returns a recovery button, or null when any provider is usable.
 */
export function CredentialStatus({ wide, controller, operations, useSnapshot, t }: CredentialStatusProps) {
  const [signedIn, setSignedIn] = useState<ReadonlySet<string>>(() => new Set())
  const readiness = useSnapshot(state => onboardingReadiness(state, signedIn))
  useEffect(() => {
    if (controller.store.getSnapshot().status === 'idle') void controller.load()
  }, [controller])
  useEffect(() => {
    let live = true
    void operations.listFlows().then((flows) => {
      if (!live) return
      setSignedIn(new Set(flows.filter(flow => flow.signedIn).map(flow => flow.key)))
    })
    return () => { live = false }
  }, [operations])
  if (readiness.kind !== 'credential-missing') return null
  return (
    <button
      type="button"
      className={styles.root}
      aria-label={t('credentialAction')}
      title={wide ? undefined : t('credentialAction')}
      onClick={() => {
        window.dispatchEvent(new CustomEvent('dsh-desktop-open-settings', {
          detail: { section: 'models' },
        }))
      }}
    >
      <span className={styles.badge} aria-hidden="true">!</span>
      {wide && <span>{t('credentialRequired')}</span>}
    </button>
  )
}
