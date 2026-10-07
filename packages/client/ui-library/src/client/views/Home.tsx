/**
 * The library's front page: every module as a card with how far along it is.
 * Each card already says what is left in that module, so the page does not
 * repeat it in a list of reminders above them.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconCheckOutline14, IconChevronRightOutline14, IconEllipsisOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconEmber, IconModule, IconTranscript } from '../icons.tsx'
import { countStates, type LibraryModule, type ModuleContents } from '../model.ts'
import { StateLegend, StateProgress } from '../parts.tsx'
import type { LibraryRoute, Loadable } from '../service.ts'
import type { LibrarySetup, RemovedModule } from '../editing.ts'
import { AddModuleDialog } from './Setup.tsx'
import { useConfirm } from './Confirm.tsx'
import { shortDate } from './Module.tsx'
import type {} from '../locales.ts'
import css from '../LibraryPanel.module.css'

/**
 * One module card.
 * @param props.module - the module.
 * @param props.contents - its contents, when read.
 * @param props.onOpen - open the module page.
 * @param props.t - translate.
 */
function ModuleCard({ module, contents, onOpen, remove, t }: {
  readonly module: LibraryModule
  readonly contents: Loadable<ModuleContents> | undefined
  readonly onOpen: () => void
  /** Send the module to the library's trash; absent on an older engine. */
  readonly remove?: (() => void) | undefined
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [menu, setMenu] = useState(false)
  const lectures = contents?.status === 'ready' ? contents.value.lectures : undefined
  const counts = lectures === undefined ? undefined : countStates(lectures)
  return (
    <li className={css.cardItem}>
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
      {remove !== undefined && (
        // Beside the card's button, not inside it: a button cannot hold another.
        <div className={css.cardMenu}>
          <Menu
            open={menu}
            portal
            align="end"
            items={[{ id: 'remove', label: t('module.remove'), danger: true }]}
            onSelect={() => { setMenu(false); remove() }}
            onClose={() => { setMenu(false) }}
            anchor={(
              <button
                type="button"
                className={css.cardMenuButton}
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={t('home.card.more', { module: module.displayName })}
                onClick={() => { setMenu(value => !value) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </div>
      )}
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
export function HomeView({ modules, contents, navigate, setup, changed, t }: {
  readonly modules: readonly LibraryModule[]
  /** Per-module contents read so far. */
  readonly contents: Readonly<Record<string, Loadable<ModuleContents>>>
  readonly navigate: (route: LibraryRoute) => void
  /** Adding, removing and restoring modules; absent on an older Host. */
  readonly setup?: LibrarySetup | undefined
  /** Read the library again after a module was added or restored. */
  readonly changed?: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const reread = (): void => { changed?.() }
  const [removeError, setRemoveError] = useState<string | undefined>(undefined)
  const confirm = useConfirm(t)
  // Removal moves the module to the library's trash; the list below brings it back.
  const removeModule = (module: LibraryModule): void => {
    const remove = setup?.removeModule
    if (remove === undefined) return
    void confirm.ask({
      title: t('module.remove.title', { module: module.displayName }),
      body: t('module.remove.confirm', { module: module.displayName }),
      confirm: t('module.remove'),
      danger: true,
    }).then((yes) => {
      if (!yes) return
      setRemoveError(undefined)
      void remove(module.id).then((answer) => {
        if (answer.ok) reread()
        else setRemoveError(answer.message)
      })
    })
  }
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
    </>
  )
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
          </div>
        )}
        {setup !== undefined && <RemovedModules setup={setup} restored={reread} t={t} />}
        {dialogs}
      </div>
    )
  }
  return (
    <div className={css.page}>
      <header className={css.hero}>
        <h1 className={css.heroTitle}>{t('home.title')}</h1>
        <ul className={css.facts} aria-label={t('home.facts')}>
          <li className={css.fact}><IconModule size={14} aria-hidden />{t('home.fact.modules', { count: String(modules.length) })}</li>
          <li className={css.fact}><IconTranscript aria-hidden />{t('home.fact.lectures', { count: String(lectures.length) })}</li>
          <li className={css.fact} data-tone="done"><IconCheckOutline14 aria-hidden />{t('home.fact.final', { count: String(finished) })}</li>
        </ul>
      </header>
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
              {...setup?.removeModule === undefined ? {} : { remove: () => { removeModule(module) } }}
              t={t}
            />
          ))}
        </ul>
      </section>
      {removeError !== undefined && <p className={css.calloutError} role="alert" dir="auto">{removeError}</p>}
      {confirm.dialog}
      {setup !== undefined && <RemovedModules setup={setup} restored={reread} t={t} />}
      {dialogs}
    </div>
  )
}

/**
 * Modules the student removed, with a way back. Removal moves a module to
 * the library's trash and nothing is deleted, so this list is the other half
 * of the remove button; it stays out of sight while it is empty.
 * @param props.setup - the module calls.
 * @param props.restored - read the library again after a restore.
 * @param props.t - translate.
 */
function RemovedModules({ setup, restored, t }: {
  readonly setup: LibrarySetup
  readonly restored: () => void
  readonly t: TranslateNS<'library'>
}): ReactNode {
  const [removed, setRemoved] = useState<readonly RemovedModule[]>([])
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const list = setup.listRemovedModules
  const restore = setup.restoreModule
  useEffect(() => {
    if (list === undefined) return
    let live = true
    void list().then((answer) => { if (live && answer.ok) setRemoved(answer.value) })
    return () => { live = false }
  }, [list])
  if (list === undefined || restore === undefined || removed.length === 0) return null
  const bringBack = (entry: RemovedModule): void => {
    setBusy(entry.trashId)
    setError(undefined)
    void restore(entry.trashId).then((answer) => {
      setBusy(undefined)
      if (!answer.ok) { setError(answer.message); return }
      setRemoved(removed.filter(item => item.trashId !== entry.trashId))
      restored()
    })
  }
  return (
    <section className={css.section} aria-labelledby="library-removed">
      <h2 id="library-removed" className={css.sectionTitle}>{t('home.removed.title')}</h2>
      <ul className={css.removedList}>
        {removed.map(entry => (
          <li key={entry.trashId} className={css.removedRow}>
            <span className={css.removedName} dir="auto">{entry.displayName}</span>
            <span className={css.removedWhen}>{shortDate(entry.removedAt)}</span>
            <Button size="sm" variant="outline" disabled={busy !== undefined} onClick={() => { bringBack(entry) }}>
              {busy === entry.trashId ? t('home.removed.restoring') : t('home.removed.restore')}
            </Button>
          </li>
        ))}
      </ul>
      {error !== undefined && <p className={css.calloutError} role="alert" dir="auto">{error}</p>}
    </section>
  )
}
