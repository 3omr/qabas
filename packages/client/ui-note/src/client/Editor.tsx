/**
 * One note in CodeMirror with the live preview.
 *
 * The view is created once per note and kept: recreating it on every keystroke
 * would lose the cursor, the undo history and the scroll position. The note's
 * text flows out through `onChange`; text that changes underneath it (a reload
 * after a conflict) flows back in as one replacing transaction.
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { search, searchKeymap } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, type KeyBinding } from '@codemirror/view'
import { tablePreview } from './tables.ts'
import { livePreview, type PreviewHooks } from './live-preview.ts'
import { noteTheme } from './theme.ts'

/** The editor's props. */
export interface EditorProps {
  /** The note's text when the editor mounts or is reset. */
  readonly text: string
  /** Called with the whole text after every change. */
  readonly onChange: (text: string) => void
  /** Image resolution and link opening. */
  readonly hooks: PreviewHooks
  /** Extra key bindings (save, reading mode). */
  readonly keys: readonly KeyBinding[]
  /** CodeMirror's own UI strings in the student's language. */
  readonly phrases: Readonly<Record<string, string>>
  /** Called with the view once it exists, so the outline can scroll it. */
  readonly onView?: (view: EditorView | undefined) => void
}

/**
 * The CodeMirror editor.
 * @param props - see {@link EditorProps}.
 */
export function Editor({ text, onChange, hooks, keys, phrases, onView }: EditorProps): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | undefined>(undefined)
  const change = useRef(onChange)
  change.current = onChange

  useEffect(() => {
    const parent = host.current
    if (parent === null) return undefined
    const created = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          markdown({ base: markdownLanguage }),
          history(),
          search({ top: true }),
          keymap.of([...keys, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.lineWrapping,
          // Each line takes the direction of its own first strong character:
          // an Arabic explanation and an English drug list sit side by side.
          EditorView.perLineTextDirection.of(true),
          EditorState.phrases.of(phrases),
          livePreview(hooks),
          tablePreview,
          noteTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = created
    onView?.(created)
    return () => {
      onView?.(undefined)
      created.destroy()
      view.current = undefined
    }
    // The view is the note's for its lifetime; props that change identity
    // every render must not rebuild it. `text` is reconciled below.
  }, [hooks])

  useEffect(() => {
    const current = view.current
    if (current === undefined || current.state.doc.toString() === text) return
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } })
  }, [text])

  return <div ref={host} className="qabas-note-editor" style={{ height: '100%' }} />
}
