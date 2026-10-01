// SetupStage: the full-screen frame every first-run setup step draws in, so a
// sequence of steps contributed by different plugins reads as one flow.

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './SetupStage.module.css'

/** Where a step sits in the setup sequence. */
export interface SetupProgress {
  /** Zero-based index of this step. */
  readonly index: number
  /** Number of steps in the sequence. */
  readonly total: number
}

/**
 * Render one setup step over the whole window, making the app behind it inert.
 * @param props.mark - the product mark drawn above the title.
 * @param props.progress - the step's place in the sequence, drawn as segments.
 * @param props.eyebrow - small line above the title (the step's name).
 * @param props.title - the step's question or greeting.
 * @param props.lead - one or two sentences under the title.
 * @param props.children - the step's content.
 * @param props.footer - actions; the last group aligns to the end edge.
 * @param props.label - accessible name of the dialog.
 * @returns the portal.
 */
export function SetupStage({ mark, progress, eyebrow, title, lead, children, footer, label }: {
  mark?: ReactNode
  progress?: SetupProgress | undefined
  eyebrow?: ReactNode
  title: ReactNode
  lead?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  label: string
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  // A screen reader starts at the step's title, and keyboard focus leaves
  // the app the sheet just made inert.
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    appRoot.inert = true
    return () => { appRoot.inert = false }
  }, [])

  return createPortal((
    <div className={css.overlay} role="dialog" aria-modal="true" aria-label={label}>
      <div className={css.sheet}>
        <header className={css.head}>
          {mark !== undefined && <span className={css.mark}>{mark}</span>}
          {progress !== undefined && (
            <ol className={css.progress} aria-hidden="true">
              {Array.from({ length: progress.total }, (_, index) => (
                <li
                  key={index}
                  data-state={index < progress.index ? 'done' : index === progress.index ? 'current' : 'ahead'}
                />
              ))}
            </ol>
          )}
          {eyebrow !== undefined && <p className={css.eyebrow}>{eyebrow}</p>}
          <h1 ref={heading} className={css.title} tabIndex={-1}>{title}</h1>
          {lead !== undefined && <p className={css.lead}>{lead}</p>}
        </header>
        {children !== undefined && <div className={css.body}>{children}</div>}
        {footer !== undefined && <footer className={css.footer}>{footer}</footer>}
      </div>
    </div>
  ), document.body)
}

/**
 * Group footer actions at the end edge of a setup step.
 * @param props.children - the actions.
 * @returns the group.
 */
export function SetupStageActions({ children }: { children: ReactNode }) {
  return <div className={css.footerEnd}>{children}</div>
}
