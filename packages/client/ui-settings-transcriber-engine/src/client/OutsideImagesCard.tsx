/**
 * Settings → Accounts and tools: the switch for outside illustrations.
 *
 * When the doctor describes something whose look matters and no slide shows
 * it, the engine may add an openly licensed picture from Wikimedia Commons,
 * checked by the writer and labelled with its source, at most five a lecture.
 * Some students want only the lecture's own material; this card lets them say
 * so. The preference lives with the library (the engine's settings file), so
 * every job reads the same answer.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranscriberEngineClient } from '@deepseek-ai/dsh-api-transcriber-engine/client'
import { ServiceCard, type Standing } from './ServiceCard.tsx'
import type { Translate } from './standing.ts'
import css from './AccountsSection.module.css'

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly enabled: boolean; readonly saving: boolean }
  | { readonly status: 'error'; readonly message: string }

/**
 * The card.
 * @param props - the engine client and copy.
 * @param props.engine - transcriber engine client; without the settings calls the card is not shown.
 * @param props.t - translate.
 * @returns the card.
 */
export function OutsideImagesCard({ engine, t }: {
  readonly engine: Partial<Pick<TranscriberEngineClient, 'getEngineSettings' | 'setEngineSettings'>>
  readonly t: Translate
}): ReactNode {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const available = typeof engine.getEngineSettings === 'function' && typeof engine.setEngineSettings === 'function'
  useEffect(() => {
    if (engine.getEngineSettings === undefined) return undefined
    const controller = new AbortController()
    void engine.getEngineSettings(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setLoad(result.ok
        ? { status: 'ready', enabled: result.value.web_figures, saving: false }
        : { status: 'error', message: result.error.message })
    })
    return () => { controller.abort() }
  }, [engine])

  const change = (enabled: boolean): void => {
    if (load.status !== 'ready' || engine.setEngineSettings === undefined) return
    setLoad({ status: 'ready', enabled, saving: true })
    void engine.setEngineSettings({ web_figures: enabled }).then((result) => {
      setLoad(result.ok
        ? { status: 'ready', enabled: result.value.web_figures, saving: false }
        : { status: 'error', message: result.error.message })
    })
  }

  // An engine from before this setting existed has nothing to switch.
  if (!available) return null
  // Off is a choice, not a problem: only a failed read asks for attention.
  const standing: Standing = load.status === 'loading' ? 'checking' : load.status === 'error' ? 'attention' : 'ready'
  const state = load.status === 'loading'
    ? t('accounts.checking')
    : load.status === 'error' ? t('accounts.outside.error') : load.enabled ? t('accounts.outside.on') : t('accounts.outside.off')
  return (
    <ServiceCard id="outside-images" title={t('accounts.outside.title')} purpose={t('accounts.outside.purpose')} standing={standing} state={state}>
      {load.status === 'ready' && (
        <div className={css.actions}>
          <Switch
            checked={load.enabled}
            onChange={change}
            disabled={load.saving}
            label={t('accounts.outside.switch')}
          />
          <span className={css.note}>{t('accounts.outside.switch')}</span>
        </div>
      )}
      {load.status === 'error' && <p className={css.error} role="alert">{load.message}</p>}
    </ServiceCard>
  )
}
