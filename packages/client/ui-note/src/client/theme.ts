/**
 * The editor's look: a reading column on paper, set in the app's own font and
 * colours. Every colour is a theme token, so light and dark follow the app.
 *
 * Callouts take Obsidian's palette of meanings — note, tip, warning, danger…
 * — drawn with the theme's state colours rather than Obsidian's own hexes, so
 * a transcript's "Doctor's remark" box sits in the same family as the rest of
 * Qabas.
 */
import { EditorView } from '@codemirror/view'

const callout = (kind: string, colour: string): Record<string, Record<string, string>> => ({
  [`.cm-qabas-callout-${kind}`]: { '--callout': colour },
})

/** The editor theme. */
export const noteTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 'calc(16px + var(--dsh-content-font-delta, 0px))',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--dsw-font-family)',
    lineHeight: '1.85',
  },
  '.cm-content': {
    boxSizing: 'border-box',
    maxWidth: '780px',
    margin: '0 auto',
    padding: '40px 32px 50vh',
    caretColor: 'var(--dsw-alias-brand-primary)',
  },
  '.cm-line': { padding: '0 2px' },
  '.cm-cursor, .cm-dropCursor': { borderInlineStartColor: 'var(--dsw-alias-brand-primary)', borderInlineStartWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--dsw-alias-interactive-bg-hover-accent) !important',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-gutters': { display: 'none' },

  // Headings: sizes step down like a printed handout; h2 carries a rule,
  // because a transcript's five sections are its h2s.
  '.cm-qabas-h': { fontWeight: '700', lineHeight: '1.4', color: 'var(--dsw-alias-label-primary)' },
  '.cm-qabas-h1': { fontSize: '1.9em', paddingTop: '0.6em', paddingBottom: '0.2em' },
  '.cm-qabas-h2': {
    fontSize: '1.45em',
    paddingTop: '1.2em',
    paddingBottom: '0.3em',
    borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    marginBottom: '0.4em',
  },
  '.cm-qabas-h3': { fontSize: '1.2em', paddingTop: '0.9em', color: 'var(--dsw-alias-brand-text)' },
  '.cm-qabas-h4, .cm-qabas-h5, .cm-qabas-h6': { fontSize: '1.05em', paddingTop: '0.6em' },

  '.cm-qabas-strong': { fontWeight: '700' },
  '.cm-qabas-em': { fontStyle: 'italic' },
  '.cm-qabas-code': {
    padding: '0.1em 0.35em',
    borderRadius: '5px',
    backgroundColor: 'var(--dsw-alias-markdown-inline-code)',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: '0.88em',
  },
  '.cm-qabas-codeblock': {
    backgroundColor: 'var(--dsw-alias-markdown-code-block)',
    fontFamily: 'var(--ds-font-family-code)',
    fontSize: '0.88em',
  },
  '.cm-qabas-link, .cm-qabas-wikilink': {
    color: 'var(--dsw-alias-link)',
    textDecoration: 'none',
    borderBottom: '1px solid color-mix(in srgb, var(--dsw-alias-link) 35%, transparent)',
    cursor: 'pointer',
  },
  '.cm-qabas-bullet': { display: 'inline-block', width: '1em', color: 'var(--dsw-alias-brand-primary)', fontWeight: '700' },
  '.cm-qabas-hr': {
    height: '1px',
    margin: '1em 0',
    backgroundColor: 'var(--dsw-alias-border-l2)',
  },
  '.cm-qabas-quote': {
    borderInlineStart: '3px solid var(--dsw-alias-border-l3)',
    paddingInlineStart: '14px !important',
    color: 'var(--dsw-alias-label-secondary)',
  },

  // Callouts: one tinted box made of consecutive lines.
  '.cm-qabas-callout': {
    paddingInline: '16px !important',
    backgroundColor: 'color-mix(in srgb, var(--callout) 9%, transparent)',
    borderInlineStart: '3px solid var(--callout)',
  },
  '.cm-qabas-callout-head': {
    paddingTop: '8px !important',
    borderStartStartRadius: '6px',
    borderStartEndRadius: '6px',
    fontWeight: '650',
    color: 'var(--callout)',
  },
  '.cm-qabas-callout-last': {
    paddingBottom: '8px !important',
    borderEndStartRadius: '6px',
    borderEndEndRadius: '6px',
  },
  '.cm-qabas-callout-title': { fontWeight: '650' },
  ...callout('note', 'var(--qabas-state-verbatim, #3F7CAC)'),
  ...callout('abstract', 'var(--qabas-state-verbatim, #3F7CAC)'),
  ...callout('tip', 'var(--qabas-state-final, #2F7A4E)'),
  ...callout('success', 'var(--qabas-state-final, #2F7A4E)'),
  ...callout('important', 'var(--dsw-alias-brand-primary)'),
  ...callout('question', 'var(--qabas-state-draft, #C07A12)'),
  ...callout('warning', 'var(--qabas-state-draft, #C07A12)'),
  ...callout('danger', 'var(--dsw-alias-state-error-primary)'),
  ...callout('example', 'var(--dsw-alias-label-secondary)'),
  ...callout('quote', 'var(--dsw-alias-label-tertiary)'),

  // Figures: centred, framed, never wider than the column.
  '.cm-qabas-image': { display: 'block', margin: '0.6em 0', textAlign: 'center' },
  '.cm-qabas-image img': {
    maxWidth: '100%',
    maxHeight: '480px',
    borderRadius: '8px',
    border: '0.5px solid var(--dsw-alias-border-l2)',
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
  },
  '.cm-qabas-image-missing': {
    padding: '10px',
    borderRadius: '8px',
    border: '1px dashed var(--dsw-alias-border-l3)',
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '0.85em',
  },

  // The search panel, in the app's colours.
  '.cm-panels': {
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    borderColor: 'var(--dsw-alias-border-l2)',
  },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--qabas-state-draft, #C07A12) 25%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)' },
})
