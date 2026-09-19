/**
 * One entry's standing, as a dot and a word.
 *
 * Colour is never the only carrier: the dot says it again in shape, and the
 * label says it in words, so a reader who cannot separate green from amber
 * still reads the row correctly.
 */

import { StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import css from './StatusBadge.module.css'

/**
 * What an entry's standing can be.
 *
 * Three rather than two: an entry that is configured but unhappy -- a sign-in
 * whose refresh token the issuer revoked -- is neither ready nor unset, and
 * collapsing it into either one loses the only state a reader must act on.
 */
export type CatalogStatus = 'ready' | 'attention' | 'unset'

/** Props of {@link StatusBadge}. */
export interface StatusBadgeProps {
  status: CatalogStatus
  /** The word for this standing; the package owns no copy. */
  label: string
  className?: string | undefined
}

/** The dot state each standing reads as. */
const DOT = {
  ready: 'done',
  attention: 'error',
  unset: 'warning',
} as const

/** The tag tone each standing reads as. */
const TONE = {
  ready: 'success',
  attention: 'danger',
  unset: 'warning',
} as const

/**
 * Render one standing.
 * @param props - the standing and its word.
 * @returns the badge.
 */
export function StatusBadge({ status, label, className }: StatusBadgeProps): ReactNode {
  return (
    <Tag tone={TONE[status]} className={className}>
      <span className={css.badge} data-catalog-status={status}>
        <StateDot state={DOT[status]} size={7} />
        {label}
      </span>
    </Tag>
  )
}
