/**
 * Tables in live preview. A GFM table the cursor is not in is drawn as a
 * table; step into it and its pipes come back for editing — the same bargain
 * as every other mark. Tables replace whole lines, which CodeMirror only takes
 * from a state field, so they live here rather than in the view plugin.
 */
import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/**
 * Split one table row into its cells, honouring `\|` inside a cell.
 * @param line - the row as written.
 * @returns the trimmed cells.
 */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '')
  return body.split(/(?<!\\)\|/u).map(cell => cell.trim().replaceAll('\\|', '|'))
}

/** Escape text for innerHTML. */
function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The inline marks a transcript's cells use: bold, italic, code.
 * @param text - one cell's markdown.
 * @returns safe HTML.
 */
export function cellHtml(text: string): string {
  return escape(text)
    .replace(/`([^`]+)`/gu, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/gu, '<em>$1</em>')
    .replace(/<br\s*\/?>|&lt;br\s*\/?&gt;/giu, '<br>')
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source
  }

  toDOM(): HTMLElement {
    const lines = this.source.split('\n').filter(line => line.trim() !== '')
    const wrap = document.createElement('div')
    wrap.className = 'cm-qabas-table'
    const table = document.createElement('table')
    const [head, , ...rows] = lines
    // The header decides which side the first column sits on: an Arabic
    // header reads right to left even when the cells are English terms.
    table.dir = /[\u0600-\u06FF]/u.test(head ?? '') ? 'rtl' : 'ltr'
    if (head !== undefined) {
      const tr = table.createTHead().insertRow()
      for (const cell of tableCells(head)) {
        const th = document.createElement('th')
        th.dir = 'auto'
        th.innerHTML = cellHtml(cell)
        tr.append(th)
      }
    }
    const body = table.createTBody()
    for (const row of rows) {
      const tr = body.insertRow()
      for (const cell of tableCells(row)) {
        const td = tr.insertCell()
        td.dir = 'auto'
        td.innerHTML = cellHtml(cell)
      }
    }
    wrap.append(table)
    return wrap
  }

  override ignoreEvent(): boolean {
    return false
  }
}

function build(state: EditorState): DecorationSet {
  const selected = state.selection.ranges
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined
      const from = state.doc.lineAt(node.from).from
      const to = state.doc.lineAt(node.to).to
      const editing = selected.some(range => range.to >= from && range.from <= to)
      if (!editing) {
        decorations.push(Decoration.replace({
          widget: new TableWidget(state.sliceDoc(from, to)),
          block: true,
        }).range(from, to))
      }
      return false
    },
  })
  return Decoration.set(decorations, true)
}

/** The table-preview extension. */
export const tablePreview = StateField.define<DecorationSet>({
  create: build,
  update: (value, transaction) => transaction.docChanged || transaction.selection !== undefined
    || syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    ? build(transaction.state)
    : value,
  provide: field => EditorView.decorations.from(field),
})
