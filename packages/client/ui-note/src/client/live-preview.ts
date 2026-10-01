/**
 * Live preview, the way Obsidian does it: the markdown stays the document, and
 * every line the cursor is not on is drawn as what it means. Move onto a line
 * and its marks come back so it can be edited; move off and it renders again.
 *
 * Everything here is decoration over the markdown syntax tree — nothing
 * rewrites the text — so what is saved is exactly what was typed, and an
 * engine that reads the file afterwards sees ordinary markdown.
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import {
  Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'

/** Resolves an image reference written in the note to something an `<img>` can show. */
export type ImageSource = (reference: string) => Promise<string | undefined>

/** Opens a `[[wikilink]]` or a relative markdown link. */
export type LinkOpener = (target: string) => void

/** What the preview needs from the panel around it. */
export interface PreviewHooks {
  readonly image: ImageSource
  readonly openLink: LinkOpener
}

/** The Obsidian callout types and the theme colour each is drawn in. */
export const CALLOUT_TYPES: Readonly<Record<string, string>> = {
  note: 'note', info: 'note', todo: 'note',
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  tip: 'tip', hint: 'tip', important: 'important',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'danger', fail: 'danger', missing: 'danger', danger: 'danger', error: 'danger', bug: 'danger',
  example: 'example', quote: 'quote', cite: 'quote',
}

/** `> [!type]+ Title` — the callout's first line. */
const CALLOUT_HEAD = /^\s*>\s*\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/u

/** `[[target|alias]]` and `![[embed]]`. */
const WIKILINK = /(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/gu

/** The lines the selection touches: these show their markdown. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let line = first; line <= last; line++) lines.add(line)
  }
  return lines
}

class ImageWidget extends WidgetType {
  constructor(readonly reference: string, readonly alt: string, readonly hooks: PreviewHooks) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.reference === this.reference && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const figure = document.createElement('span')
    figure.className = 'cm-qabas-image'
    const image = document.createElement('img')
    image.alt = this.alt
    image.loading = 'lazy'
    figure.append(image)
    void this.hooks.image(this.reference).then((url) => {
      if (url === undefined) {
        figure.classList.add('cm-qabas-image-missing')
        figure.textContent = this.alt === '' ? this.reference : this.alt
        return
      }
      image.src = url
    })
    return figure
  }

  override ignoreEvent(): boolean {
    return false
  }
}

class LinkWidget extends WidgetType {
  constructor(readonly target: string, readonly label: string, readonly hooks: PreviewHooks) {
    super()
  }

  override eq(other: LinkWidget): boolean {
    return other.target === this.target && other.label === this.label
  }

  toDOM(): HTMLElement {
    const link = document.createElement('a')
    link.className = 'cm-qabas-wikilink'
    link.textContent = this.label
    link.href = '#'
    link.addEventListener('mousedown', (event) => {
      event.preventDefault()
      this.hooks.openLink(this.target)
    })
    return link
  }
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement('span')
    bullet.className = 'cm-qabas-bullet'
    bullet.textContent = '•'
    return bullet
  }
}

class CalloutIconWidget extends WidgetType {
  constructor(readonly kind: string, readonly title: string) {
    super()
  }

  override eq(other: CalloutIconWidget): boolean {
    return other.kind === this.kind && other.title === this.title
  }

  toDOM(): HTMLElement {
    const title = document.createElement('span')
    title.className = 'cm-qabas-callout-title'
    title.textContent = this.title
    return title
  }
}

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })

/** Collect the decorations for the visible part of the document. */
function build(view: EditorView, hooks: PreviewHooks): DecorationSet {
  const { state } = view
  const active = activeLines(state)
  const decorations: Range<Decoration>[] = []
  const lineOf = (pos: number): number => state.doc.lineAt(pos).number
  const onActive = (node: SyntaxNodeRef): boolean => {
    for (let line = lineOf(node.from); line <= lineOf(node.to); line++) if (active.has(line)) return true
    return false
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name
        const heading = /^ATXHeading(\d)$/u.exec(name)
        if (heading !== null) {
          const line = state.doc.lineAt(node.from)
          decorations.push(Decoration.line({ class: `cm-qabas-h cm-qabas-h${heading[1]}` }).range(line.from))
          return
        }
        if (name === 'HeaderMark' && !onActive(node)) {
          // The space after `##` goes with the mark, so the title sits flush.
          const end = Math.min(node.to + 1, state.doc.lineAt(node.from).to)
          decorations.push(hidden.range(node.from, end))
          return
        }
        if ((name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') && !onActive(node)) {
          if (node.from < node.to) decorations.push(hidden.range(node.from, node.to))
          return
        }
        if (name === 'StrongEmphasis') {
          decorations.push(Decoration.mark({ class: 'cm-qabas-strong' }).range(node.from, node.to))
          return
        }
        if (name === 'Emphasis') {
          decorations.push(Decoration.mark({ class: 'cm-qabas-em' }).range(node.from, node.to))
          return
        }
        if (name === 'InlineCode') {
          decorations.push(Decoration.mark({ class: 'cm-qabas-code' }).range(node.from, node.to))
          return
        }
        if (name === 'Image' && !onActive(node)) {
          const text = state.sliceDoc(node.from, node.to)
          const match = /^!\[([^\]]*)\]\(([^)\s]+)/u.exec(text)
          if (match !== null) {
            decorations.push(Decoration.replace({
              widget: new ImageWidget(match[2] ?? '', match[1] ?? '', hooks),
            }).range(node.from, node.to))
          }
          return false
        }
        if (name === 'Link' && !onActive(node)) {
          const text = state.sliceDoc(node.from, node.to)
          const match = /^\[([^\]]*)\]\(([^)\s]+)/u.exec(text)
          if (match !== null && /\.md(?:#.*)?$/iu.test(match[2] ?? '')) {
            decorations.push(Decoration.replace({
              widget: new LinkWidget(match[2] ?? '', match[1] ?? '', hooks),
            }).range(node.from, node.to))
            return false
          }
          decorations.push(Decoration.mark({ class: 'cm-qabas-link' }).range(node.from, node.to))
          return
        }
        if ((name === 'LinkMark' || name === 'URL') && !onActive(node)) {
          const parent = node.node.parent
          if (parent?.name === 'Link') decorations.push(hidden.range(node.from, node.to))
          return
        }
        if (name === 'ListMark' && !onActive(node)) {
          const mark = state.sliceDoc(node.from, node.to)
          if (mark === '-' || mark === '*' || mark === '+') decorations.push(bullet.range(node.from, node.to))
          return
        }
        if (name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from)
          decorations.push(Decoration.line({ class: 'cm-qabas-hr' }).range(line.from))
          if (!onActive(node)) decorations.push(hidden.range(node.from, node.to))
          return
        }
        if (name === 'Blockquote') {
          // The quote styles its lines; its contents — figures and links in a
          // callout, the common case in a transcript — still render inside it.
          decorateQuote(state, node, active, decorations)
          return undefined
        }
        if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos)
            decorations.push(Decoration.line({ class: 'cm-qabas-codeblock' }).range(line.from))
            pos = line.to + 1
          }
          return false
        }
        return undefined
      },
    })
    decorateWikilinks(state, from, to, active, decorations, hooks)
  }
  return Decoration.set(decorations, true)
}

/**
 * A blockquote: an Obsidian callout when its first line is `> [!type]`,
 * otherwise a plain quote. The `>` marks hide off the active line.
 */
function decorateQuote(
  state: EditorState,
  node: SyntaxNodeRef,
  active: ReadonlySet<number>,
  decorations: Range<Decoration>[],
): void {
  const firstLine = state.doc.lineAt(node.from)
  const head = CALLOUT_HEAD.exec(firstLine.text)
  const kind = head === null ? undefined : CALLOUT_TYPES[(head[1] ?? '').toLowerCase()] ?? 'note'
  const lastLine = state.doc.lineAt(node.to)
  for (let number = firstLine.number; number <= lastLine.number; number++) {
    const line = state.doc.line(number)
    const classes = kind === undefined
      ? 'cm-qabas-quote'
      : `cm-qabas-callout cm-qabas-callout-${kind}${number === firstLine.number ? ' cm-qabas-callout-head' : ''}${number === lastLine.number ? ' cm-qabas-callout-last' : ''}`
    decorations.push(Decoration.line({ class: classes }).range(line.from))
    if (active.has(number)) continue
    const mark = /^\s*>\s?/u.exec(line.text)
    if (mark !== null && mark[0].length > 0) decorations.push(hidden.range(line.from, line.from + mark[0].length))
    if (number === firstLine.number && head !== null && kind !== undefined) {
      // `[!type]+ ` is replaced by the type's title when the head line has none.
      const marker = /\[![A-Za-z]+\][+-]?\s*/u.exec(line.text)
      if (marker !== null) {
        const start = line.from + marker.index
        const title = (head[3] ?? '').trim()
        decorations.push(Decoration.replace({
          widget: new CalloutIconWidget(kind, title === '' ? capitalize(head[1] ?? kind) : ''),
        }).range(start, start + marker[0].length))
      }
    }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
}

/** `[[links]]` and `![[embeds]]` — not markdown, so not in the syntax tree. */
function decorateWikilinks(
  state: EditorState,
  from: number,
  to: number,
  active: ReadonlySet<number>,
  decorations: Range<Decoration>[],
  hooks: PreviewHooks,
): void {
  const text = state.sliceDoc(from, to)
  for (const match of text.matchAll(WIKILINK)) {
    const start = from + match.index
    const end = start + match[0].length
    if (active.has(state.doc.lineAt(start).number)) continue
    const target = (match[2] ?? '').trim()
    if (match[1] === '!') {
      decorations.push(Decoration.replace({ widget: new ImageWidget(target, target, hooks) }).range(start, end))
    } else {
      decorations.push(Decoration.replace({
        widget: new LinkWidget(target, (match[3] ?? target).trim(), hooks),
      }).range(start, end))
    }
  }
}

/**
 * The live-preview extension.
 * @param hooks - image resolution and link opening from the panel.
 * @returns the CodeMirror extension.
 */
export function livePreview(hooks: PreviewHooks): ViewPlugin<{ decorations: DecorationSet; update: (update: ViewUpdate) => void }> {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = build(view, hooks)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet
        || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view, hooks)
      }
    }
  }, { decorations: plugin => plugin.decorations })
}

/**
 * The document's headings, for the outline pane.
 * @param state - editor state.
 * @returns each heading's level, text and position, in document order.
 */
export function headingsOf(state: EditorState): { readonly level: number; readonly text: string; readonly from: number }[] {
  const headings: { level: number; text: string; from: number }[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      const heading = /^ATXHeading(\d)$/u.exec(node.name)
      if (heading === null) return undefined
      const text = state.sliceDoc(node.from, node.to).replace(/^#+\s*/u, '').trim()
      headings.push({ level: Number(heading[1]), text, from: node.from })
      return false
    },
  })
  return headings
}
