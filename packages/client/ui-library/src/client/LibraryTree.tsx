/**
 * The library in the sidebar: modules that open onto their lectures, each
 * lecture with its state's dot. Clicking anything opens it in the library
 * panel, so the tree is a way into the library, never a second copy of it.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, IconChevronLeftOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconLibrary, IconModule } from './icons.tsx'
import { displayTitle } from './model.ts'
import { useSnapshot } from './parts.tsx'
import type { LibraryRoute, LibraryService } from './service.ts'
import type {} from './locales.ts'
import css from './LibraryTree.module.css'

/** What the tree is handed besides its copy. */
export interface LibraryTreeInjected {
  readonly library: LibraryService
  /** Show the library panel in the main column. */
  readonly show: () => void
}

/** The tree's props. */
export type LibraryTreeProps = LibraryTreeInjected & PropsLocale<'library'>

function sameRoute(left: LibraryRoute, right: LibraryRoute): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * The sidebar section.
 * @param props.library - the library service.
 * @param props.show - bring the library panel forward.
 * @param props.t - translate.
 */
export function LibraryTree({ library, show, t }: LibraryTreeProps): ReactNode {
  const state = useSnapshot(library.state)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const go = (route: LibraryRoute): void => {
    library.navigate(route)
    show()
  }
  const toggle = (module: string): void => {
    const next = new Set(open)
    if (next.has(module)) next.delete(module)
    else {
      next.add(module)
      if (library.state.getSnapshot().contents[module] === undefined) void library.loadModule(module)
    }
    setOpen(next)
  }
  const modules = state.modules.status === 'ready' ? state.modules.value : []
  return (
    <section className={css.root} aria-label={t('panel.label')}>
      <button
        type="button"
        className={clsx(css.heading, sameRoute(state.route, { kind: 'home' }) && css.current)}
        onClick={() => { go({ kind: 'home' }) }}
      >
        <IconLibrary size={14} />
        <span>{t('panel.label')}</span>
      </button>
      <ul className={css.list}>
        {modules.map((module) => {
          const expanded = open.has(module.id)
          const read = state.contents[module.id]
          const moduleRoute: LibraryRoute = { kind: 'module', module: module.id }
          return (
            <li key={module.id}>
              <div className={clsx(css.row, sameRoute(state.route, moduleRoute) && css.current)}>
                <button
                  type="button"
                  className={css.disclosure}
                  aria-expanded={expanded}
                  aria-label={module.displayName}
                  onClick={() => { toggle(module.id) }}
                >
                  {expanded ? <IconChevronDownOutline14 /> : <IconChevronLeftOutline14 />}
                </button>
                <button type="button" className={css.label} onClick={() => { go(moduleRoute) }}>
                  <IconModule size={14} />
                  <span className={css.text}>{module.displayName}</span>
                </button>
              </div>
              {expanded && read?.status === 'ready' && (
                <ul className={css.lectures}>
                  {read.value.lectures.map((lecture) => {
                    const route: LibraryRoute = { kind: 'lecture', module: module.id, lecture: lecture.title }
                    return (
                      <li key={lecture.title}>
                        <button
                          type="button"
                          className={clsx(css.lecture, sameRoute(state.route, route) && css.current)}
                          data-state={lecture.state}
                          onClick={() => { go(route) }}
                          title={t(`state.${lecture.state}`)}
                        >
                          <span className={css.dot} aria-hidden />
                          <span className={css.text}>{displayTitle(lecture.title)}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {expanded && read?.status !== 'ready' && (
                <p className={css.hint}>{read?.status === 'failed' ? read.message : t('home.card.reading')}</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
