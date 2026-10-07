// @vitest-environment jsdom
/**
 * The قَبَس marks: the flame-quote symbol in the sidebar, the symbol beside the
 * wordmark where the app introduces itself, and the name beside the symbol.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { QabasSymbol, qabasBrandOwners } from '../src/client/Brand.tsx'

afterEach(() => { cleanup() })

const owners = qabasBrandOwners(() => 'قَبَس')

describe('Qabas brand', () => {
  it('draws the symbol as two flame-quotes on the ember tile, in theme tokens', () => {
    const { container } = render(<QabasSymbol size={24} label="قَبَس" />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('قَبَس')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(container.querySelector('rect')?.getAttribute('fill')).toContain('--dsw-alias-brand-primary')
    expect(container.querySelectorAll('path')).toHaveLength(2)
  })

  it('uses the symbol in the sidebar and the name beside it', () => {
    const mark = render(<owners.mark size={28} />)
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 64 64')
    const name = render(<owners.name />)
    const wordmark = name.container.querySelector('svg')
    expect(wordmark?.getAttribute('height')).toBe('28')
    expect(wordmark?.getAttribute('aria-label')).toBe('قَبَس')
  })

  it('places the wordmark beside the symbol on the hero', () => {
    const { container } = render(<owners.hero size={44} className="hero" />)
    const svgs = container.querySelectorAll('.hero svg')
    expect(svgs).toHaveLength(2)
    expect(container.querySelector<HTMLElement>('.hero')?.style.flexDirection).toBe('row')
    expect(svgs[1]?.getAttribute('height')).toBe('39.6')
  })

  it('names the marks with the label read at render time', () => {
    let name = 'Qabas'
    const live = qabasBrandOwners(() => name)
    const first = render(<live.mark size={20} />)
    expect(first.container.querySelector('svg')?.getAttribute('aria-label')).toBe('Qabas')
    name = 'قَبَس'
    const second = render(<live.mark size={20} />)
    expect(second.container.querySelector('svg')?.getAttribute('aria-label')).toBe('قَبَس')
  })
})
