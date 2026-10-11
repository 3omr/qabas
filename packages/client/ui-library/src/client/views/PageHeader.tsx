/** One title row shared by the library's subpages; the breadcrumb above them names the way back. */
import type { ReactNode } from 'react'
import css from './PageHeader.module.css'

/**
 * Title, one optional fact line, and the page's actions on the same row.
 * @param props - page title, short facts, and actions.
 * @returns the page header.
 */
export function PageHeader({ title, facts, children }: {
  readonly title: ReactNode
  readonly facts?: ReactNode
  readonly children?: ReactNode
}): ReactNode {
  return (
    <header className={css.head}>
      <div className={css.titles}>
        <h1 className={css.title}>{title}</h1>
        {facts !== undefined && <p className={css.facts}>{facts}</p>}
      </div>
      {children !== undefined && <div className={css.actions}>{children}</div>}
    </header>
  )
}
