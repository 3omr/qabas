// @vitest-environment jsdom
/** The outside-illustrations switch reads and writes the engine's setting. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { OutsideImagesCard } from '../src/client/OutsideImagesCard.tsx'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)
afterEach(cleanup)

describe('OutsideImagesCard', () => {
  it('shows the stored choice and saves a change', async () => {
    const engine = {
      getEngineSettings: vi.fn(async () => ({ ok: true as const, value: { web_figures: true } })),
      setEngineSettings: vi.fn(async (request: { web_figures: boolean }) => ({ ok: true as const, value: request })),
    }
    render(<OutsideImagesCard engine={engine} t={t} />)
    const toggle = await screen.findByRole('switch', { name: en['accounts.outside.switch'] })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => { expect(engine.setEngineSettings).toHaveBeenCalledWith({ web_figures: false }) })
    await waitFor(() => { expect(screen.getByRole('switch', { name: en['accounts.outside.switch'] }).getAttribute('aria-checked')).toBe('false') })
    expect(screen.getByText(en['accounts.outside.off'])).toBeTruthy()
  })

  it('draws nothing for an engine without the setting', () => {
    const { container } = render(<OutsideImagesCard engine={{}} t={t} />)
    expect(container.innerHTML).toBe('')
  })
})
