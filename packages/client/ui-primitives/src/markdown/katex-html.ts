/**
 * TeX-to-HTML via KaTeX for surfaces that draw outside React. It returns
 * markup, not product copy, so it lives outside the TSX renderer.
 */

import katex from 'katex'
// An editor widget that draws math needs KaTeX's fonts and layout too.
import 'katex/dist/katex.min.css'

/**
 * Render TeX source to an HTML string through KaTeX, for surfaces that draw
 * outside React (an editor widget). Same fallbacks as `renderTexToReact` in katex.tsx.
 * @param value - The TeX source.
 * @param displayMode - Display (block) versus inline rendering.
 * @returns KaTeX's markup, or an escaped error span when it cannot render.
 */
export function renderTexToHtml(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, { displayMode, throwOnError: true })
  } catch {
    try {
      return katex.renderToString(value, { displayMode, strict: 'ignore', throwOnError: false })
    } catch {
      /* v8 ignore next 2 */
      const escaped = value.replace(/[&<>"]/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
      return `<span class="katex-error" style="color:#cc0000">${escaped}</span>`
    }
  }
}
