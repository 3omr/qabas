/** Shared module heading and status facts for lecture and exam management. */
import type { ReactNode } from 'react'
import { IconCheckOutline14, IconLinkOutline14, IconQuestionOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LibraryModule, ModuleContents } from '../model.ts'
import { IconTranscript } from '../icons.tsx'
import type {} from '../locales.ts'
import css from '../LibraryPanel.module.css'

/**
 * Show the owning module and its current library status.
 * @param props - module, loaded contents, indexing activity, optional notice, and localized copy.
 * @returns the module title and status pills shared by its management pages.
 */
export function ModuleHeading({ module, contents, indexing = false, children, t }: {
  readonly module: LibraryModule
  readonly contents?: ModuleContents | undefined
  readonly indexing?: boolean
  readonly children?: ReactNode
  readonly t: TranslateNS<'library'>
}): ReactNode {
  return (
    <div className={css.pageTitles}>
      <h1 className={css.pageTitle}><bdi>{module.displayName}</bdi></h1>
      <ul className={css.facts} aria-label={t('module.facts')}>
        <li className={css.fact}><IconTranscript aria-hidden />{t('home.fact.lectures', { count: String(contents?.lectures.length ?? 0) })}</li>
        <li className={css.fact} data-tone={module.notebooks.length > 0 ? 'done' : 'attention'}>
          <IconLinkOutline14 aria-hidden />
          {module.notebooks.length > 0 ? t('module.notebook.linked') : t('module.notebook.none')}
        </li>
        {contents?.questionIndex?.state === 'built' && (
          <li className={css.fact} data-tone="done">
            <IconCheckOutline14 aria-hidden />{indexing ? t('qindex.building') : t('qindex.ready')}
          </li>
        )}
        {contents?.questionIndex?.files === 0 && <li className={css.fact} data-tone="attention"><IconQuestionOutline14 aria-hidden />{t('exams.none.short')}</li>}
      </ul>
      {children}
    </div>
  )
}
