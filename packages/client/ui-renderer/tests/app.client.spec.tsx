// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { buildRenderApp } from '../src/client/app.tsx'

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
})

async function bench() {
  runtime = await SlotTestRuntime.create()
  await runtime.root.declare({}, () => <div data-testid="frame" />)
  return { runtime, renderApp: buildRenderApp({ ctx: runtime.ctx }) }
}

describe('buildRenderApp', () => {
  it('fails loud when the slot registry is unavailable', () => {
    const renderApp = buildRenderApp({ ctx: new Context() })
    expect(() => renderApp()).toThrow()
  })

  it('renders the root slot tree', async () => {
    const b = await bench()
    const view = render(<>{b.renderApp()}</>)
    expect(view.getByTestId('frame')).toBeTruthy()
    expect(view.getByTestId('frame').parentElement?.parentElement?.getAttribute('dir')).toBe('ltr')
  })

  it('tracks a right-to-left locale and switches back to left-to-right', async () => {
    const b = await bench()
    const locale = new LocaleRuntime(b.runtime.ctx)
    locale.addLanguage({ id: 'ar', label: 'العربية', fallback: 'en', direction: 'rtl' })
    locale.setLocale('ar')
    b.runtime.slots.installLocale(locale)
    const view = render(<>{b.renderApp()}</>)
    const root = view.getByTestId('frame').parentElement?.parentElement

    expect(root?.getAttribute('dir')).toBe('rtl')
    act(() => { locale.setLocale('en') })
    expect(root?.getAttribute('dir')).toBe('ltr')
  })

})
