/** Placeholder geometry for asynchronously loaded content. */
import type { ReactNode } from 'react'
import css from './Skeleton.module.css'

/**
 * Render an inert row-sized placeholder; the caller supplies an accessible loading label on its container.
 * @param props - number of text lines, defaulting to two.
 * @returns placeholder lines hidden from assistive technology.
 */
export function Skeleton({ lines = 2 }: { readonly lines?: number }): ReactNode {
  return <div className={css.row} aria-hidden="true" data-skeleton>{Array.from({ length: lines }, (_, index) => <span className={css.line} key={index} />)}</div>
}
