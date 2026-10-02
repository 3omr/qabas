/**
 * The library's front page: every module as a card with how far along it is,
 * and above them the few things waiting on the student.
 *
 * "Waiting on the student" is derived, never stored: lectures nobody has
 * transcribed, drafts nobody finished, a notebook that is not answering. Each
 * is a button that takes the student to where it gets done.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconEmber, IconModule } from '../icons.tsx'
import { countStates, displayTitle, type LibraryModule, type ModuleContents } from '../model.ts'
import { StateLegend, StateProgress } from '../parts.tsx'
import type { LibraryRoute, Loadable } from '../service.ts'
import type { LibrarySetup } from '../editing.ts'
import { AddModuleDialog, FolderDialog, LibraryFolder } from './Setup.tsx'
import type {} from '../locales.ts'
import css from '../LibraryPanel.module.css'

/** One thing waiting on the student, and where it gets done. */
export interface Need {
  readonly key: string
  readonly text: string
  readonly route: LibraryRoute
}

/**
 * Derive what is waiting on the student, most pressing first: drafts (work
 * already half done), then modules with lectures nobody has started, then
 * notebooks that are not answering.
 * @param modules - the workspace's modules.
 * @param contents - per-module contents read so far.
 * @param t - translate.
 * @returns the needs, at most one per module and kind.
 */
export function needsOf(
  modules: readonly LibraryModule[],
  contents: Readonly<Record<string, Loadable<ModuleContents>>>,
  t: TranslateNS<'library'>,
): Need[] {
  const drafts: Need[] = []
  const pending: Need[] = []
  const warnings: Need[] = []
  for (const module of modules) {
    const read = contents[module.id]
    if (read?.status !== 'ready') continue
    for (const lecture of read.value.lectures) {
      if (lecture.state !== 'draft') continue
      drafts.push({
        key: `draft:${module.id}:${lecture.title}`,
        text: t('needs.draft', { lecture: displayTitle(lecture.title), module: module.displayName }),
        route: { kind: 'lecture', module: module.id, lecture: lecture.title },
      })
    }
    const waiting = read.value.lectures.filter(lecture => lecture.state === 'pending' && lecture.parts > 0).length
    if (waiting > 0) {
      pending.push({
        key: `pending:${module.id}`,
        text: t('needs.pending', { count: String(waiting), module: module.displayName }),
        route: { kind: 'module', module: module.id },
      })
    }
    if (read.value.warning !== undefined) {
      warnings.push({
        key: `notebook:${module.id}`,
        text: t('needs.notebook', { module: module.displayName }),
        route: { kind: 'module', module: module.id },
      })
    }
  }
  return [...drafts, ...pending, ...warnings]
}

/**
 * One module card.
 * @param props.module - the module.
 * @param props.contents - its contents, when read.
 * @param props.onOpen - open the module page.
 * @param props.t - translate.
 */
function ModuleCard({ module, contents, onOpen, t }: {
  readonly module: LibraryModule
  readonly contents: Loadable<ModuleContents> | undefined
  readonly onOpen: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const lectures = contents?.status === 'ready' ? contents.value.lectures : undefined
  const counts = lectures === undefined ? undefined : countStates(lectures)
  return (
    <li>
      <button type="button" className={css.card} onClick={onOpen} data-library-module={module.id}>
        <span className={css.cardHead}>
          <span className={css.cardIcon}><IconModule size={18} /></span>
          <span className={css.cardTitles}>
            <span className={css.cardTitle} dir="auto">{module.displayName}</span>
            <span className={css.cardMeta}>
              {lectures === undefined
                ? t('home.card.reading')
                : t('home.card.lectures', { count: String(lectures.length) })}
            </span>
          </span>
          <span className={css.cardChevron} aria-hidden><IconChevronRightOutline14 /></span>
        </span>
        {counts === undefined
          ? <span className={css.progressSkeleton} />
          : (
            <>
              <StateProgress counts={counts} t={t} />
              <StateLegend counts={counts} t={t} />
            </>
          )}
      </button>
    </li>
  )
}

/**
 * The front page.
 * @param props.modules - the workspace's modules.
 * @param props.contents - per-module contents read so far.
 * @param props.navigate - library navigation.
 * @param props.t - translate.
 */
export function HomeView({ modules, contents, navigate, workspace, setup, changed, t }: {
  readonly modules: readonly LibraryModule[]
  /** The folder the library was read from. */
  readonly workspace?: string | undefined
  readonly contents: Readonly<Record<string, Loadable<ModuleContents>>>
  readonly navigate: (route: LibraryRoute) => void
  /** Choosing the folder and adding modules; absent on an older Host. */
  readonly setup?: LibrarySetup | undefined
  /** Read the library again after the folder changed or a module was added. */
  readonly changed?: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const reread = (): void => { changed?.() }
  const dialogs = setup === undefined ? null : (
    <>
      {adding && (
        <AddModuleDialog
          setup={setup}
          close={() => { setAdding(false) }}
          created={(id) => {
            setAdding(false)
            reread()
            navigate({ kind: 'module', module: id })
          }}
          t={t}
        />
      )}
      {choosing && (
        <FolderDialog
          setup={setup}
          initial={undefined}
          close={() => { setChoosing(false) }}
          saved={() => {
            setChoosing(false)
            reread()
          }}
          t={t}
        />
      )}
    </>
  )
  const needs = needsOf(modules, contents, t)
  const lectures = modules.flatMap((module) => {
    const read = contents[module.id]
    return read?.status === 'ready' ? read.value.lectures : []
  })
  const finished = lectures.filter(lecture => lecture.state === 'final').length
  if (modules.length === 0) {
    return (
      <div className={css.empty}>
        <span className={css.emptyMark}><IconEmber size={28} /></span>
        <h2 className={css.emptyTitle}>{t('home.empty.title')}</h2>
        <p className={css.emptyBody}>{t('home.empty.body')}</p>
        {setup !== undefined && (
          <div className={css.emptyActions}>
            <Button variant="primary" onClick={() => { setAdding(true) }}>{t('home.add')}</Button>
            <Button variant="outline" onClick={() => { setChoosing(true) }}>{t('folder.choose')}</Button>
          </div>
        )}
        {setup !== undefined && <LibraryFolder path={workspace} setup={setup} changed={reread} t={t} />}
        {dialogs}
      </div>
    )
  }
  return (
    <div className={css.page}>
      <header className={css.hero}>
        <h1 className={css.heroTitle}>{t('home.title')}</h1>
        <p className={css.heroSubtitle}>
          {t('home.subtitle', {
            modules: String(modules.length),
            lectures: String(lectures.length),
            final: String(finished),
          })}
        </p>
        {setup !== undefined && <LibraryFolder path={workspace} setup={setup} changed={reread} t={t} />}
      </header>
      {needs.length > 0 && (
        <section className={css.section} aria-labelledby="library-needs">
          <h2 id="library-needs" className={css.sectionTitle}>{t('home.needs.title')}</h2>
          <ul className={css.needs}>
            {needs.slice(0, 6).map(need => (
              <li key={need.key}>
                <button type="button" className={css.need} onClick={() => { navigate(need.route) }}>
                  <span className={css.needMark} aria-hidden><IconEmber size={14} /></span>
                  <span className={css.needText}>{need.text}</span>
                  <span className={css.cardChevron} aria-hidden><IconChevronRightOutline14 /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={css.section} aria-labelledby="library-modules">
        <div className={css.sectionBar}>
          <h2 id="library-modules" className={css.sectionTitle}>{t('home.modules.title')}</h2>
          {setup !== undefined && <Button variant="outline" size="sm" onClick={() => { setAdding(true) }}>{t('home.add')}</Button>}
        </div>
        <ul className={css.cards}>
          {modules.map(module => (
            <ModuleCard
              key={module.id}
              module={module}
              contents={contents[module.id]}
              onOpen={() => { navigate({ kind: 'module', module: module.id }) }}
              t={t}
            />
          ))}
        </ul>
      </section>
      {dialogs}
    </div>
  )
}
