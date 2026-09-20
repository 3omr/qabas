/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { LocaleFace } from '@deepseek-ai/dsh-client-ui-slots'

/** Inputs available after the UI renderer's inject set activates. */
export interface AssemblyDeps {
  /** Client context carrying the renderer-owned Slot registry. */
  ctx: Context
}

/** Render the one application root with the active locale direction. */
function RootDirection({ locale, children }: { locale: LocaleFace | undefined; children?: ReactNode }): ReactNode {
  const direction = useSyncExternalStore(
    listener => locale?.subscribe(listener) ?? (() => {}),
    () => locale?.getSnapshot().direction ?? 'ltr',
    () => locale?.getSnapshot().direction ?? 'ltr',
  )
  return createElement('div', { dir: direction, style: { display: 'contents' } }, children)
}

/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  return () => createElement(
    RootDirection,
    { locale: ctx.slots.getLocale() },
    ctx.slots.renderSlot('root', {}),
  )
}
