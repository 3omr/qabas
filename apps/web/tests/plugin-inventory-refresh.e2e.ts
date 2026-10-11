/** Real Host inventory reads across manual refresh and connection replacement, without model calls. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
} from './scaffold.ts'

const copies = [
  { locale: 'en-US', settings: 'Settings', plugins: 'Plugins', tab: 'Plugin list', refresh: 'Refresh status', search: 'Search plugins', empty: 'No matching plugins.', waiting: 'Waiting for a connection. Plugin state is not confirmed.' },
] as const

describe('plugin inventory freshness', () => {
  it.each(copies)('refreshes Loader observations in $locale without changing configuration', async (copy) => {
    const scaffold = await launchWebScaffold({})
    try {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1100, height: 800 } })
        await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        await page.getByRole('button', { name: copy.settings, exact: true }).click()
        const dialog = page.getByRole('dialog', { name: copy.settings })
        await dialog.getByRole('button', { name: copy.plugins, exact: true }).click()
        await dialog.getByRole('tab', { name: copy.tab, exact: true }).click()
        const search = dialog.getByRole('searchbox', { name: copy.search })
        await search.fill('inventory-refresh-probe')
        await dialog.getByText(copy.empty, { exact: true }).waitFor()

        // Disabled rows need no executable fixture and cannot start an agent.
        const id = await scaffold.ctx.loader.create({ name: 'cordis:inventory-refresh-probe', disabled: true })
        try {
          const response = page.waitForResponse('**/api/pluginInventory/list')
          await dialog.getByRole('button', { name: copy.refresh }).click()
          expect((await response).ok()).toBe(true)
          const row = dialog.locator('[data-plugin-module="cordis:inventory-refresh-probe"]')
          await row.waitFor()
          expect(await search.inputValue()).toBe('inventory-refresh-probe')
          const hostEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.id === id)
          expect(hostEntry?.disabled).toBe(true)
          const golden = fileURLToPath(new URL(`./expected/plugin-inventory-refresh.${copy.locale}.aria.txt`, import.meta.url))
          await compareOrRefreshGolden(golden, await captureStableAria(page, '[data-plugin-inventory-toolbar]', scaffold.workspaceCwd), webSnapshotMode())

          await page.context().setOffline(true)
          await dialog.getByText(copy.waiting, { exact: true }).waitFor()
          expect(await row.count()).toBe(0)
          await scaffold.ctx.loader.remove(id)
          // Reconnection must repull without a click and retract the removed row.
          await page.context().setOffline(false)
          await dialog.getByText(copy.empty, { exact: true }).waitFor()
          expect(await search.inputValue()).toBe('inventory-refresh-probe')
          expect(await row.count()).toBe(0)
        } finally {
          if ([...scaffold.ctx.loader.entries()].some(entry => entry.id === id)) await scaffold.ctx.loader.remove(id)
        }
      } finally {
        await browser.close()
      }
    } finally {
      await scaffold.close()
    }
  })
})
