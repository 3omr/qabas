/**
 * The note panel: open notes as tabs, the active one in the editor or in
 * reading mode, its outline beside it, and where it stands with the disk.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Button, IconCloseOutline16, MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Editor } from './Editor.tsx'
import { createImageCache, type ImageCache } from './images.ts'
import { headingsOf, type PreviewHooks } from './live-preview.ts'
import { baseName, type NoteService, type OpenNote } from './service.ts'
import type {} from './locales.ts'
import css from './NotePanel.module.css'

/** What the panel is handed besides its copy. */
export interface NotePanelInjected {
  readonly notes: NoteService
  /** Open a link written in a note: a wikilink target or a relative `.md` path. */
  readonly openLink: (target: string, from: string) => void
  /** Markdown labels for reading mode (code copy, footnotes). */
  readonly labels: MarkdownLabels
}

/** The panel's props. */
export type NotePanelProps = NotePanelInjected & PropsLocale<'note'>

/**
 * Count the words a student would count: runs of letters or digits, in any script.
 * @param text - the note.
 * @returns the count.
 */
export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0
}

/** CodeMirror's own strings, in the student's language. */
function phrasesOf(t: TranslateNS<'note'>): Record<string, string> {
  return {
    'Find': t('cm.find'),
    'Replace': t('cm.replace'),
    'next': t('cm.next'),
    'previous': t('cm.previous'),
    'all': t('cm.all'),
    'match case': t('cm.matchCase'),
    'regexp': t('cm.regexp'),
    'by word': t('cm.byWord'),
    'replace all': t('cm.replaceAll'),
    'close': t('cm.close'),
  }
}

function SaveIndicator({ note, notes, t }: { readonly note: OpenNote; readonly notes: NoteService; readonly t: TranslateNS<'note'> }): ReactNode {
  if (note.save === 'conflict') {
    return (
      <div className={css.conflict} role="alert">
        <span>{t('save.conflict')}</span>
        <Button size="sm" variant="outline" onClick={() => { void notes.reload(note.path) }}>{t('conflict.reload')}</Button>
        <Button size="sm" variant="primary" onClick={() => { void notes.keepMine(note.path) }}>{t('conflict.keep')}</Button>
      </div>
    )
  }
  if (note.save === 'failed') {
    return <span className={clsx(css.save, css.saveFailed)} role="alert">{t('save.failed', { message: note.message ?? '' })}</span>
  }
  return <span className={css.save} data-save={note.save}>{t(`save.${note.save}`)}</span>
}

function Outline({ text, view, t }: { readonly text: string; readonly view: EditorView | undefined; readonly t: TranslateNS<'note'> }): ReactNode {
  const headings = useMemo(() => {
    const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] })
    return headingsOf(state)
  }, [text])
  if (headings.length === 0) return <p className={css.outlineEmpty}>{t('outline.empty')}</p>
  return (
    <ul className={css.outlineList}>
      {headings.map(heading => (
        <li key={heading.from}>
          <button
            type="button"
            className={css.outlineItem}
            style={{ paddingInlineStart: `${(heading.level - 1) * 12 + 8}px` }}
            data-level={heading.level}
            dir="auto"
            onClick={() => {
              if (view === undefined) return
              view.dispatch({ selection: { anchor: heading.from }, scrollIntoView: true })
              view.focus()
            }}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The reading page's direction, from the script most of the note is written
 * in. `dir="auto"` reads only the first strong letter, and a transcript opens
 * with an English title ("# 🧪 Animal poisoning"), which turned a page of
 * Arabic left to right while the editor (direction per line) showed it right.
 * @param text - the note.
 * @returns rtl when Arabic letters outnumber Latin ones.
 */
export function documentDirection(text: string): 'rtl' | 'ltr' {
  const arabic = text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/gu)?.length ?? 0
  const latin = text.match(/[A-Za-z]/gu)?.length ?? 0
  return arabic > latin ? 'rtl' : 'ltr'
}

function ActiveNote({ note, notes, openLink, labels, t }: NotePanelInjected & {
  readonly note: OpenNote
  readonly t: TranslateNS<'note'>
}): ReactNode {
  const [mode, setMode] = useState<'live' | 'read'>('read')
  const [outline, setOutline] = useState(true)
  const [view, setView] = useState<EditorView | undefined>()
  const [, redraw] = useState(0)
  const cache = useRef<ImageCache | undefined>(undefined)
  // One cache and one set of hooks per note: the editor keeps its view as
  // long as these keep their identity.
  const hooks = useMemo<PreviewHooks>(() => {
    cache.current?.dispose()
    const created = createImageCache(notes.files, note.path, () => { redraw(value => value + 1) })
    cache.current = created
    return {
      image: reference => created.get(reference),
      openLink: (target) => { openLink(target, note.path) },
    }
  }, [note.path, notes, openLink])
  useEffect(() => () => { cache.current?.dispose() }, [])
  const keys = useMemo<KeyBinding[]>(() => [
    { key: 'Mod-s', preventDefault: true, run: () => { void notes.flush(note.path); return true } },
    { key: 'Mod-e', preventDefault: true, run: () => { setMode('read'); return true } },
  ], [notes, note.path])
  const pathImages = useMemo(() => ({ resolve: (value: string) => cache.current?.peek(value) }), [hooks])

  if (note.status === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (note.status === 'failed') return <p className={css.status} role="alert">{t('failed', { message: note.message ?? '' })}</p>
  return (
    <div className={css.body}>
      <div className={css.toolbar}>
        <div className={css.modes} role="tablist" aria-label={t('mode.toggle')}>
          {(['live', 'read'] as const).map(item => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={mode === item}
              className={clsx(css.mode, mode === item && css.modeActive)}
              onClick={() => { setMode(item) }}
            >
              {t(`mode.${item}`)}
            </button>
          ))}
        </div>
        <SaveIndicator note={note} notes={notes} t={t} />
        <span className={css.words}>{t('words', { count: String(wordCount(note.text)) })}</span>
        <button
          type="button"
          className={clsx(css.toolButton, outline && css.toolButtonOn)}
          aria-pressed={outline}
          onClick={() => { setOutline(!outline) }}
        >
          {t('outline.toggle')}
        </button>
      </div>
      <div className={css.workspace}>
        <div className={css.page} data-mode={mode}>
          {mode === 'live'
            ? (
              <Editor
                text={note.text}
                onChange={(text) => { notes.edit(note.path, text) }}
                hooks={hooks}
                keys={keys}
                phrases={phrasesOf(t)}
                onView={setView}
              />
            )
            : (
              <div
                className={css.reading}
                dir={documentDirection(note.text)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
                    event.preventDefault()
                    setMode('live')
                  }
                }}
              >
                <MarkdownText text={note.text} labels={labels} pathImages={pathImages} />
              </div>
            )}
        </div>
        {outline && (
          <aside className={css.outline} aria-label={t('outline.label')}>
            <h2 className={css.outlineTitle}>{t('outline.label')}</h2>
            <Outline text={note.text} view={mode === 'live' ? view : undefined} t={t} />
          </aside>
        )}
      </div>
    </div>
  )
}

/**
 * The main panel.
 * @param props - see {@link NotePanelProps}.
 */
export function NotePanel({ notes, openLink, labels, t }: NotePanelProps): ReactNode {
  const state = useSyncExternalStore(notes.state.subscribe.bind(notes.state), notes.state.getSnapshot.bind(notes.state))
  const active = state.notes.find(note => note.path === state.active)
  if (state.notes.length === 0) {
    return (
      <div className={css.empty}>
        <h2>{t('panel.empty.title')}</h2>
        <p>{t('panel.empty.body')}</p>
      </div>
    )
  }
  return (
    <div className={css.root}>
      <div className={css.tabs} role="tablist" aria-label={t('panel.label')}>
        {state.notes.map(note => (
          <div key={note.path} className={clsx(css.tab, note.path === state.active && css.tabActive)} data-save={note.save}>
            <button
              type="button"
              role="tab"
              aria-selected={note.path === state.active}
              className={css.tabLabel}
              title={note.path}
              onClick={() => { notes.activate(note.path) }}
              dir="auto"
            >
              {baseName(note.path).replace(/\.md$/iu, '')}
            </button>
            <button
              type="button"
              className={css.tabClose}
              aria-label={t('tab.close', { name: baseName(note.path) })}
              onClick={() => { void notes.close(note.path) }}
            >
              <IconCloseOutline16 />
            </button>
          </div>
        ))}
      </div>
      {active !== undefined && <ActiveNote key={active.path} note={active} notes={notes} openLink={openLink} labels={labels} t={t} />}
    </div>
  )
}
