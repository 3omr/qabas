/** Real browser contribution with a controlled clock; no model or account is used. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, prepareQabasUi, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

it.each([
  { locale: 'en-US', title: 'Focus timer', start: 'Start', pause: 'Pause', close: 'Close timer', resume: 'Resume',
    save: 'Save this duration', saved: 'Saved duration: 25 min', clear: 'Clear saved duration', empty: 'No saved duration' },
  { locale: 'zh-CN', title: '专注计时器', start: '开始', pause: '暂停', close: '关闭计时器', resume: '继续',
    save: '保存此时长', saved: '已保存时长：25 分钟', clear: '清除已保存时长', empty: '尚未保存时长' },
])('uses the built focus timer browser half in $locale', async (copy) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-focus-browser-'))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(directory, { recursive: true, force: true })]
  try {
    const overlay = join(directory, 'focus.cordis.yml')
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'focus-timer',
      name: pathToFileURL(join(REPO_ROOT, 'packages/desktop/focus-timer/lib/index.js')).href,
    }] }]))
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
      extraInstallAnchors: [join(REPO_ROOT, 'packages/desktop/focus-timer/package.json')] })
    cleanups.push(() => scaffold.close())
    await prepareQabasUi(scaffold, copy.locale === 'en-US' ? 'en' : 'zh')
    const browser = await chromium.launch()
    cleanups.push(() => browser.close())
    const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1100, height: 800 } })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: copy.title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: copy.title, exact: true })
    await dialog.getByRole('spinbutton').fill('25')
    await dialog.getByRole('button', { name: copy.save, exact: true }).click()
    await dialog.getByText(copy.saved, { exact: true }).waitFor()
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/focus-timer.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-focus-timer]', scaffold.workspaceCwd), webSnapshotMode())
    const screenshotDirectory = process.env.DSH_FOCUS_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `focus-timer.${copy.locale}.png`) })
    await page.clock.install()
    await dialog.getByRole('button', { name: copy.start, exact: true }).click()
    await page.clock.runFor(12_000)
    await dialog.getByRole('button', { name: copy.pause, exact: true }).click()
    expect(await dialog.getByRole('timer').textContent()).toBe('24:48')
    await dialog.getByRole('button', { name: copy.close, exact: true }).click()
    await page.clock.runFor(5000)
    await page.getByRole('button', { name: `${copy.title}${copy.locale === 'en-US' ? ': ' : '：'}24:48`, exact: true }).click()
    await dialog.getByRole('button', { name: copy.resume, exact: true }).click()
    await page.clock.runFor(1000)
    expect(await dialog.getByRole('timer').textContent()).toBe('24:47')
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: copy.title, exact: true }).click()
    await dialog.getByText(copy.saved, { exact: true }).waitFor()
    expect(await dialog.getByRole('spinbutton').inputValue()).toBe('25')
    expect(await dialog.getByRole('timer').textContent()).toBe('25:00')
    await dialog.getByRole('button', { name: copy.start, exact: true }).waitFor()
    await dialog.getByRole('button', { name: copy.clear, exact: true }).click()
    await dialog.getByText(copy.empty, { exact: true }).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.getByRole('button', { name: copy.title, exact: true }).click()
    await dialog.getByText(copy.empty, { exact: true }).waitFor()
    expect(await dialog.getByRole('spinbutton').inputValue()).toBe('')
  } finally {
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Focus timer fixture cleanup failed')
  }
})
