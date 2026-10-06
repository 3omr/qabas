/** The shipping desktop overlay records installed-app guidance in a real Web round trip. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  fixtureUserPrompts, launchWebScaffold, readPersistedEvents, type WebScaffold,
  captureStableAria, compareOrRefreshGolden, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT } from './support.ts'

const FIXTURE = join(REPO_ROOT, 'snapshots/web/desktop-context/session.v2.jsonl')

describe('desktop context in the shipped Web composition', () => {
  let root: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let bridge: Server | undefined
  const notifications: unknown[] = []
  const startupAttempts: unknown[] = []
  const startupToken = 'c'.repeat(32)
  const readyListeners = new Set<() => void>()
  let startupCommitted = false
  let selectionReads = 0

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-desktop-context-'))
    await writeFile(join(root, 'catalog.json'), JSON.stringify({ schemaVersion: 1, entries: [] }))
    await mkdir(join(root, 'profiles/web'), { recursive: true })
    await writeFile(join(root, 'profiles/web/package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    bridge = createServer((request, response) => {
      if (request.headers['x-dsh-desktop-bridge-token'] !== 'desktop-context-fixture-token') {
        response.writeHead(403).end()
        return
      }
      if (request.method === 'GET' && request.url === '/v1/profile-selection') {
        selectionReads += 1
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ ok: true, selection: {
          schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null,
        } }))
        return
      }
      if (request.method !== 'POST' || (request.url !== '/v1/notify' && request.url !== '/v1/runtime-ready')) {
        response.writeHead(404).end()
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        if (request.url === '/v1/runtime-ready') startupAttempts.push(JSON.parse(body))
        else notifications.push(JSON.parse(body))
        response.setHeader('content-type', 'application/json')
        response.end('{"ok":true}')
      })
    })
    bridge.listen(0, '127.0.0.1')
    await once(bridge, 'listening')
    const address = bridge.address()
    if (address === null || typeof address === 'string') throw new Error('bridge did not bind TCP')
    const source = await readFile(join(REPO_ROOT, 'apps/desktop/runtime/desktop.cordis.yml'), 'utf8')
    let overlay = source
      .replaceAll('__DSH_DESKTOP_NATIVE_ENTRY__', JSON.stringify(pathToFileURL(
        join(REPO_ROOT, 'packages/desktop/desktop-native/lib/index.js'),
      ).href))
      .replaceAll('!!js process.env.DSH_DESKTOP_BRIDGE_URL', JSON.stringify(`http://127.0.0.1:${String(address.port)}`))
      .replaceAll('!!js process.env.DSH_DESKTOP_BRIDGE_TOKEN', JSON.stringify('desktop-context-fixture-token'))
      .replaceAll('!!js process.env.DSH_DESKTOP_STARTUP_TOKEN', JSON.stringify(startupToken))
    const manager = dirname(createRequire(join(REPO_ROOT, 'apps/desktop/package.json')).resolve('pnpm'))
    const managerVersion = (JSON.parse(await readFile(join(manager, 'package.json'), 'utf8')) as { version: string }).version
    const harnessVersion = (JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    for (const [placeholder, value] of Object.entries({
      __DSH_BUNDLE_PREPARATION_ENTRY__: pathToFileURL(join(REPO_ROOT, 'packages/desktop/bundle-preparation/lib/index.js')).href,
      __DSH_BUNDLE_MARKETPLACE_ENTRY__: pathToFileURL(join(REPO_ROOT, 'packages/desktop/bundle-marketplace/lib/index.js')).href,
      __DSH_BUNDLE_CATALOG__: join(root, 'catalog.json'),
      __DSH_BUNDLE_ARTIFACTS__: root,
      __DSH_BUNDLE_STAGING__: join(root, 'bundle-marketplace/staging'),
      __DSH_BUNDLE_JOURNAL__: join(root, 'bundle-marketplace/operations'),
      __DSH_BUNDLE_HOME__: root,
      __DSH_BUNDLE_DSH_ENTRY__: join(REPO_ROOT, 'apps/cli/lib/bin.js'),
      __DSH_BUNDLE_PNPM_ENTRY__: join(manager, 'bin/pnpm.mjs'),
      __DSH_BUNDLE_PNPM_VERSION__: managerVersion,
      __DSH_HARNESS_VERSION__: harnessVersion,
    })) overlay = overlay.replaceAll(placeholder, JSON.stringify(value))
    expect(overlay).not.toMatch(/__DSH_[A-Z_]+__/u)
    // Qabas omits the generic plugin settings section; this marketplace scenario opts into it.
    overlay += '\n- insert:\n    - id: desktop-marketplace-settings\n      name: "@deepseek-ai/dsh-client-ui-settings-plugins"\n'
    const patchPath = join(root, 'desktop.cordis.yml')
    await writeFile(patchPath, overlay)
    scaffold = await launchWebScaffold({
      appReady: { onReady(listener) {
        if (startupCommitted) { listener(); return () => {} }
        readyListeners.add(listener)
        return () => { readyListeners.delete(listener) }
      } },
      replayFixture: FIXTURE, compareReplaySession: true,
      extraOverlayPath: patchPath,
      preserveDirectoryPicker: true,
      extraInstallAnchors: ['desktop-native', 'bundle-preparation', 'bundle-marketplace'].map(name =>
        join(REPO_ROOT, 'packages/desktop', name, 'package.json')),
    })
    await scaffold.ctx.settings.mutate('locale', [{ op: 'set', path: ['preference'], value: 'en' }])
    // This replay owns desktop context and marketplace behavior, after first-run setup.
    await scaffold.ctx.settings.mutate('ui-onboarding', [{
      op: 'set', path: ['completedSteps'],
      value: ['welcome-notice', 'pi-ai-provider', 'transcriber-engine', 'qabas-library'],
    }])
    startupCommitted = true
    for (const listener of readyListeners) listener()
    readyListeners.clear()
    browser = await chromium.launch()
    // The fixture persists clientTimeZone; the browser must not inherit the runner's zone.
    page = await browser.newPage({
      viewport: { width: 1680, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Taipei',
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (bridge !== undefined) {
      await new Promise<void>((resolve, reject) => {
        bridge!.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        bridge!.closeAllConnections()
      }).catch((error: unknown) => failures.push(error))
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'desktop context teardown failed')
  })

  it('persists desktop orientation without Web development instructions or private bridge credentials', async () => {
    await expect.poll(() => startupAttempts).toEqual([{ attempt: startupToken }])
    if (scaffold === undefined) throw new Error('desktop scaffold did not start')
    const prompts = fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    if (prompt === undefined) throw new Error('desktop fixture has no user prompt')
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(prompt)
    await input.press('Enter')
    const sessionId = await settled
    const events = await readPersistedEvents(scaffold, sessionId)
    const system = events.find(event => event.type === 'system/message')
    if (system?.type !== 'system/message') throw new Error('desktop turn did not persist its system message')
    const systemText = system.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(systemText).toContain('Qabas, a desktop application built on DeepSeek Harness')
    expect(systemText).not.toMatch(/pnpm run dev:web|DSH_WEB_URL|implementation checkout is at/)
    expect(JSON.stringify(events)).not.toMatch(/desktop-context-fixture-token|127\.0\.0\.1:9/)
    expect(JSON.stringify(events)).not.toContain(startupToken)
    await expect.poll(() => page.getByText('DONE', { exact: true }).count()).toBeGreaterThan(0)
    await expect.poll(() => notifications.length).toBe(1)
    expect(notifications[0]).toEqual({
      title: 'Qabas', body: 'Task finished. Open Qabas to review.', backgroundOnly: true,
    })
  })

  it('renders an empty deployment catalog without reading selection before discovery', async () => {
    expect(selectionReads).toBe(0)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    await expect.poll(() => selectionReads).toBeGreaterThan(0)
    await dialog.getByText('No reviewed Bundles are available in this catalog.', { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: 'Review installation' }).count()).toBe(0)
    if (scaffold === undefined) throw new Error('desktop scaffold did not start')
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/desktop-marketplace-empty.en-US.aria.txt'),
      await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
  })
})
