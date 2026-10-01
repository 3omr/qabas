/**
 * Table cells: pipes split cells unless escaped, and a cell's inline marks
 * render as safe HTML.
 */
import { describe, expect, it } from 'vitest'
import { cellHtml, tableCells } from '../src/client/tables.ts'

describe('tableCells', () => {
  it('splits a row and keeps an escaped pipe inside its cell', () => {
    expect(tableCells('| **A** | x \\| y | High |')).toEqual(['**A**', 'x | y', 'High'])
  })
})

describe('cellHtml', () => {
  it('renders bold, code and italic, and escapes markup', () => {
    expect(cellHtml('**High** `T3` *low* <script>')).toBe('<strong>High</strong> <code>T3</code> <em>low</em> &lt;script&gt;')
  })
})
