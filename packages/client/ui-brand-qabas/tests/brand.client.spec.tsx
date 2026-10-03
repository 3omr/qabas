// @vitest-environment jsdom
/**
 * The قَبَس marks: the flame-quote symbol in the sidebar, the symbol over the
 * wordmark where the app introduces itself, and the name beside the symbol.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { QabasBrandMark, QabasBrandName, QabasHeroMark, QabasSymbol } from '../src/client/Brand.tsx'

afterEach(() => { cleanup() })

describe('Qabas brand', () => {
  it('draws the symbol as two flame-quotes on the ember tile, in theme tokens', () => {
    const { container } = render(<QabasSymbol size={24} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-label')).toBe('قَبَس')
    expect(svg?.getAttribute('width')).toBe('24')
    expect(container.querySelector('rect')?.getAttribute('fill')).toContain('--dsw-alias-brand-primary')
    expect(container.querySelectorAll('path')).toHaveLength(2)
  })

  it('uses the symbol in the sidebar and the name beside it', () => {
    const mark = render(<QabasBrandMark size={28} />)
    expect(mark.container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 64 64')
    const name = render(<QabasBrandName />)
    expect(name.container.querySelector('svg')?.getAttribute('height')).toBe('28')
  })

  it('stacks the symbol over the wordmark on the hero', () => {
    const { container } = render(<QabasHeroMark size={44} className="hero" />)
    const svgs = container.querySelectorAll('.hero svg')
    expect(svgs).toHaveLength(2)
    expect(svgs[1]?.getAttribute('height')).toBe('39.6')
  })
})
