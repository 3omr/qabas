/** One card on the Accounts and tools page: a service, its standing, and its controls. */
import type { ReactNode } from 'react'
import type { CatalogStatus } from '@deepseek-ai/dsh-client-ui-settings-catalog'
import css from './AccountsSection.module.css'

/** A card's standing: the catalog's three, plus a check still running. */
export type Standing = CatalogStatus | 'checking'

/**
 * One service: what it is for, whether it works, and what to do about it.
 * @param props.id - stable hook for tests and styles.
 * @param props.title - the service's name.
 * @param props.purpose - one sentence on what it does for the student.
 * @param props.standing - drives the dot and the pill.
 * @param props.state - the pill's words.
 * @param props.children - the card's controls.
 */
export function ServiceCard({ id, title, purpose, standing, state, children }: {
  readonly id: string
  readonly title: string
  readonly purpose: string
  readonly standing: Standing
  readonly state: string
  readonly children?: ReactNode
}): ReactNode {
  return (
    <article className={css.card} data-status={standing} data-account={id} aria-labelledby={`account-${id}`}>
      <div className={css.cardHead}>
        <span className={css.dot} aria-hidden />
        <div className={css.cardText}>
          <div className={css.titleRow}>
            <h3 id={`account-${id}`} className={css.cardTitle}>{title}</h3>
            <span className={css.pill} role={standing === 'checking' ? 'status' : undefined}>{state}</span>
          </div>
          <p className={css.purpose}>{purpose}</p>
        </div>
      </div>
      {children !== undefined && children !== false && <div className={css.cardBody}>{children}</div>}
    </article>
  )
}
