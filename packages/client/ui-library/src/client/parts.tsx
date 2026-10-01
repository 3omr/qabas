/**
 * Small pieces every library page draws the same way: a lecture's state, a
 * module's progress, the page's actions, and reading a store from React.
 */
import { useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { LECTURE_STATES, type LectureState, type StateCounts } from './model.ts'
import type { LibraryAction, LibraryTarget } from './service.ts'
import type {} from './locales.ts'
import css from './LibraryPanel.module.css'

/**
 * Read a snapshot store and re-render on change.
 * @param store - the store.
 * @returns its current snapshot.
 */
export function useSnapshot<T>(store: ObservableSnapshot<T>): T {
  return useSyncExternalStore(store.subscribe.bind(store), store.getSnapshot.bind(store))
}

/** The dictionary key naming each state. */
export function stateKey(state: LectureState): 'state.pending' | 'state.verbatim' | 'state.draft' | 'state.final' {
  return `state.${state}`
}

/**
 * A lecture's state as a small labelled chip in the state's own color.
 * @param props.state - the state.
 * @param props.t - translate.
 */
export function StateBadge({ state, t }: { readonly state: LectureState; readonly t: TranslateNS<'library'> }): ReactNode {
  return (
    <span className={css.badge} data-state={state}>
      <span className={css.badgeDot} aria-hidden />
      {t(stateKey(state))}
    </span>
  )
}

/**
 * A module's lectures as one bar, a segment per state, finished first.
 * @param props.counts - lectures per state.
 * @param props.t - translate, for the accessible description.
 */
export function StateProgress({ counts, t }: { readonly counts: StateCounts; readonly t: TranslateNS<'library'> }): ReactNode {
  const total = LECTURE_STATES.reduce((sum, state) => sum + counts[state], 0)
  const order: readonly LectureState[] = ['final', 'draft', 'verbatim', 'pending']
  const label = order.filter(state => counts[state] > 0)
    .map(state => `${t(stateKey(state))}: ${counts[state]}`).join('، ')
  return (
    <div className={css.progress} role="img" aria-label={label}>
      {total === 0
        ? <span className={css.progressEmpty} />
        : order.map(state => counts[state] === 0 ? null : (
          <span
            key={state}
            className={css.progressSegment}
            data-state={state}
            style={{ flexGrow: counts[state] }}
          />
        ))}
    </div>
  )
}

/**
 * The counts under a progress bar: one dot and number per state that has any.
 * @param props.counts - lectures per state.
 * @param props.t - translate.
 */
export function StateLegend({ counts, t }: { readonly counts: StateCounts; readonly t: TranslateNS<'library'> }): ReactNode {
  const order: readonly LectureState[] = ['final', 'draft', 'verbatim', 'pending']
  return (
    <ul className={css.legend}>
      {order.filter(state => counts[state] > 0).map(state => (
        <li key={state} data-state={state}>
          <span className={css.badgeDot} aria-hidden />
          <span className={css.legendCount}>{counts[state]}</span>
          <span>{t(stateKey(state))}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The actions that apply to a target, the first primary one filled.
 * @param props.actions - registered actions of the page's scope.
 * @param props.target - what they run on.
 * @param props.compact - small buttons, for rows.
 * @param props.primaryOnly - draw only the primary action (rows).
 */
export function ActionButtons({ actions, target, compact = false, primaryOnly = false }: {
  readonly actions: readonly LibraryAction[]
  readonly target: LibraryTarget
  readonly compact?: boolean
  readonly primaryOnly?: boolean
}): ReactNode {
  const [running, setRunning] = useState<string | undefined>()
  const applicable = actions.filter(action => action.appliesTo(target))
  const primary = applicable.find(action => action.primary?.(target) === true)
  const shown = primaryOnly ? (primary === undefined ? [] : [primary]) : applicable
  if (shown.length === 0) return null
  const run = (action: LibraryAction): void => {
    setRunning(action.id)
    void Promise.resolve(action.run(target)).finally(() => { setRunning(undefined) })
  }
  return (
    <div className={clsx(css.actions, compact && css.actionsCompact)}>
      {shown.map(action => (
        <Button
          key={action.id}
          variant={action === primary ? 'primary' : 'outline'}
          size={compact ? 'sm' : 'md'}
          disabled={running !== undefined}
          aria-busy={running === action.id}
          onClick={(event) => { event.stopPropagation(); run(action) }}
          data-library-action={action.id}
        >
          {action.label()}
        </Button>
      ))}
    </div>
  )
}
