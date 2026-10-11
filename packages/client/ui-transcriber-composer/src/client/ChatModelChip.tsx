/** Read-only chat provider indicator backed by the durable request projection. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './TranscriberComposer.module.css'

/** Session projection supplied by the slot registrant. */
export interface ChatModelChipInjected {
  readonly projection: ObservableSnapshot<unknown>
  /** Host default used before a durable request or selection exists. */
  readonly readDefault: () => Promise<string | undefined>
}

/**
 * Show the last answering provider, or the next selection before the first answer.
 * @param props - durable model projection and localized provider names.
 * @returns a compact status chip, absent until a model is known.
 */
export function ChatModelChip({ projection, readDefault, t }: ChatModelChipInjected & PropsLocale<'transcriberComposer'>) {
  const state = useSyncExternalStore(listener => projection.subscribe(listener), () => projection.getSnapshot())
  const selection = typeof state === 'object' && state !== null && 'lastUsed' in state && 'next' in state
    ? state.lastUsed ?? state.next : undefined
  const [defaultProvider, setDefaultProvider] = useState<string>()
  useEffect(() => {
    let live = true
    void readDefault().then((provider) => {
      if (live) setDefaultProvider(provider)
    }, () => { /* Unavailable Host catalog leaves the indicator absent. */ })
    return () => { live = false }
  }, [readDefault])
  const provider = typeof selection === 'object' && selection !== null && 'provider' in selection && typeof selection.provider === 'string'
    ? selection.provider : defaultProvider
  if (provider === undefined) return null
  const name = provider === 'agy' ? t('provider.omar') : provider === 'google' ? t('provider.gemini') : provider
  return <span className={css.providerChip} data-chat-provider={provider}><bdi>{name}</bdi></span>
}
