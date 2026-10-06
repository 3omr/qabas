/** Real reviewed artifact, Cordis Remote and browser flow; only the native process boundary is simulated. */
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { create } from 'tar'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, prepareQabasUi, webSnapshotMode } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import type { DesktopProfileSelection, DesktopProfileCandidate } from '@deepseek-ai/dsh-desktop/types'

const copies = [
  { locale: 'en-US', settings: 'Settings', plugins: 'Plugins', tab: 'Marketplace', review: 'Review installation',
    search: 'Search Bundles', noMatches: 'No Bundles match this search.', updates: 'Version changes', history: 'Operation history', prepared: 'Preparation receipt verified; activation is not confirmed',
    configureAgents: 'Configure local agents', agentsUnconfirmed: 'Could not confirm that agent settings opened. Check for the Extensions window, or open Extensions from the application menu.',
    confirm: 'Install for next launch', pending: 'Waiting for app restart', cancel: 'Cancel pending activation',
    refresh: 'Refresh status', remove: 'Review removal', removeConfirm: 'Remove for next launch',
    replace: 'Review version change', replaceConfirm: 'Replace for next launch',
    offline: 'Waiting for a connection. Installation state is not confirmed.', installed: 'Installed', discover: 'Discover', version: 'Package version: 1.0.0' },
  { locale: 'zh-CN', settings: '设置', plugins: '插件', tab: '插件市场', review: '查看安装详情',
    search: '搜索组合包', noMatches: '没有符合搜索条件的组合包。', updates: '版本变更', history: '操作记录', prepared: '准备凭据已校验，尚未确认启用',
    configureAgents: '配置本地智能体', agentsUnconfirmed: '无法确认智能体设置是否已打开。请检查扩展窗口，或从应用菜单打开扩展。',
    confirm: '安装并等待下次启动', pending: '等待应用重启', cancel: '取消待启用组合',
    refresh: '刷新状态', remove: '查看卸载详情', removeConfirm: '卸载并等待下次启动',
    replace: '查看版本变更', replaceConfirm: '替换并等待下次启动',
    offline: '等待连接，安装状态尚未确认。', installed: '已安装', discover: '发现', version: '包版本: 1.0.0' },
] as const

it.each(copies.flatMap(copy => [false, true].map(replacement => ({ ...copy, replacement }))))('queues a reviewed Bundle in $locale (replacement=$replacement)', async (copy) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-web-'))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(root, { recursive: true, force: true })]
  try {
    const home = join(root, 'home')
    const profileDir = join(home, 'profiles/web')
    const packageDir = join(root, 'package')
    await mkdir(profileDir, { recursive: true })
    await mkdir(packageDir)
    const original = JSON.stringify({ private: true,
      dependencies: copy.replacement ? { 'marketplace-web-fixture': '0.9.0' } : {},
      dsh: { profile: { bundles: copy.replacement ? ['marketplace-web-fixture'] : [], patchReload: 'startup' } } })
    await writeFile(join(profileDir, 'package.json'), original)
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'marketplace-web-fixture', version: '1.0.0',
      type: 'module', exports: './host.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(packageDir, 'host.mjs'), 'export function apply() {}\n')
    await writeFile(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: market-fixture\n      name: marketplace-web-fixture\n')
    const oldPackage = join(profileDir, 'node_modules/marketplace-web-fixture')
    if (copy.replacement) {
      await cp(packageDir, oldPackage, { recursive: true })
      const old = JSON.parse(await readFile(join(oldPackage, 'package.json'), 'utf8')) as Record<string, unknown>
      await writeFile(join(oldPackage, 'package.json'), JSON.stringify({ ...old, version: '0.9.0' }))
    }
    const artifactFile = 'fixture.tgz'
    await create({ cwd: root, file: join(root, artifactFile), gzip: true, portable: true }, ['package'])
    const bytes = await readFile(join(root, artifactFile))
    const managerRoot = dirname(createRequire(join(REPO_ROOT, 'apps/desktop/package.json')).resolve('pnpm'))
    const manifest = JSON.parse(await readFile(join(managerRoot, 'package.json'), 'utf8')) as { version: string }
    const hostVersion = (JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version
    const catalogFile = join(root, 'catalog.json')
    await writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, entries: [{ id: 'example', title: 'Reviewed example',
      packageName: 'marketplace-web-fixture', version: '1.0.0', publisher: 'Qabas tests',
      details: null,
      source: 'https://github.com/Bestbbb/deepseek-harness-desktop', harnessVersions: [hostVersion],
      platforms: [`${process.platform}-${process.arch}`],
      artifact: { file: artifactFile, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }] }))
    let selection = { schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null } as DesktopProfileSelection
    const queued: DesktopProfileCandidate[] = []
    let agentWindows = 0
    const bridge = createServer((request, response) => {
      if (request.headers['x-dsh-desktop-bridge-token'] !== 'marketplace-test-token') { response.writeHead(403).end(); return }
      response.setHeader('content-type', 'application/json')
      if (request.method === 'POST' && request.url === '/v1/local-agents') {
        agentWindows++
        response.writeHead(agentWindows === 1 ? 500 : 200).end('{"ok":true}')
        return
      }
      if (request.url === '/v1/profile-selection') { response.end(JSON.stringify({ ok: true, selection })); return }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        if (request.url === '/v1/profile-queue') {
          const candidate = JSON.parse(body) as DesktopProfileCandidate
          queued.push(candidate)
          selection = { ...selection, pending: candidate }
        } else if (request.url === '/v1/profile-cancel') {
          const input = JSON.parse(body) as { profile: string }
          if (input.profile !== selection.pending?.profile) { response.writeHead(400).end(); return }
          selection = { ...selection, pending: null }
        } else { response.writeHead(404).end(); return }
        response.end('{"ok":true}')
      })
    })
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      bridge.close((error) => { if (error) reject(error); else resolve() })
      bridge.closeAllConnections()
    }))
    bridge.listen(0, '127.0.0.1')
    await once(bridge, 'listening')
    const address = bridge.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture bridge did not bind TCP')
    const entry = (name: string) => pathToFileURL(join(REPO_ROOT, 'packages/desktop', name, 'lib/index.js')).href
    const overlay = join(root, 'marketplace.patch.yml')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'marketplace-settings', name: '@deepseek-ai/dsh-client-ui-settings-plugins' },
      { id: 'market-native', name: entry('desktop-native'), config: { endpoint: `http://127.0.0.1:${String(address.port)}`, token: 'marketplace-test-token' } },
      { id: 'market-preparation', name: entry('bundle-preparation'), config: {
        catalogFile, artifactDirectory: root, stagingDirectory: join(root, 'staged'), hostVersion,
        remote: { url: 'https://marketplace.example.invalid/catalog.signed.json', channel: 'fixture',
          publicKeys: [generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()],
          cacheFile: join(root, 'remote-cache.json'), allowedOrigins: ['https://marketplace.example.invalid'],
          timeoutMs: 1000, lockWaitMs: 1000, maxEnvelopeBytes: 1_048_576, maxValidityMs: 86_400_000, clockSkewMs: 1000 },
        journal: { directory: join(root, 'operations'), maxEntries: 100, maxRecordBytes: 1_048_576 },
        installer: { nodeExecutable: process.execPath, packageManagerEntry: join(managerRoot, 'bin/pnpm.mjs'),
          packageManagerVersion: manifest.version, timeoutMs: 60_000, graceMs: 1000, maxOutputBytes: 65_536,
          maxExpandedBytes: 16_777_216, maxArchiveEntries: 1000, maxManifestBytes: 1_048_576 },
        composition: { harnessHome: home, profileName: 'web', dshEntry: join(REPO_ROOT, 'apps/cli/lib/bin.js'),
          maxProfileBytes: 16_777_216, maxProfileEntries: 1000 },
      } },
      { id: 'marketplace', name: entry('bundle-marketplace') },
    ] }]))
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
      extraInstallAnchors: ['desktop-native', 'bundle-preparation', 'bundle-marketplace'].map(name => join(REPO_ROOT, 'packages/desktop', name, 'package.json')) })
    cleanups.push(() => scaffold.close())
    await prepareQabasUi(scaffold, copy.locale === 'en-US' ? 'en' : 'zh')
    const browser = await chromium.launch()
    cleanups.push(() => browser.close())
    const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1100, height: 800 } })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push(message.text()) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    try { await page.getByRole('button', { name: copy.settings, exact: true }).click() } catch (error) {
      throw new Error(JSON.stringify({ pageErrors, body: await page.locator('body').innerText() }), { cause: error })
    }
    const dialog = page.getByRole('dialog', { name: copy.settings })
    const snapshotResponse = page.waitForResponse('**/api/bundleMarketplace/snapshot')
    await dialog.getByRole('button', { name: copy.plugins, exact: true }).click()
    await dialog.getByRole('tab', { name: copy.tab, exact: true }).click()
    const snapshotBody = await snapshotResponse.then(response => response.text(), async (error: unknown) => {
      throw new Error(JSON.stringify({ pageErrors, body: await page.locator('body').innerText() }), { cause: error })
    })
    expect(snapshotBody, JSON.stringify(pageErrors)).not.toContain('"ok":false')
    await dialog.getByText('Reviewed example', { exact: true }).waitFor()
    const agentHelp = dialog.locator('section > details').filter({ has: page.locator('summary') })
    await agentHelp.locator('summary').click()
    await expect.poll(() => agentHelp.locator('p').isVisible()).toBe(true)
    await agentHelp.locator('summary').click()
    expect(agentWindows).toBe(0)
    await dialog.getByRole('button', { name: copy.configureAgents, exact: true }).click()
    await dialog.getByText(copy.agentsUnconfirmed, { exact: true }).waitFor()
    expect(agentWindows).toBe(1)
    const opening = page.waitForResponse('**/api/bundleMarketplace/openLocalAgents')
    await dialog.getByRole('button', { name: copy.configureAgents, exact: true }).click()
    await opening
    await dialog.getByText(copy.agentsUnconfirmed, { exact: true }).waitFor({ state: 'hidden' })
    expect(agentWindows).toBe(2)
    expect(queued).toHaveLength(0)
    expect(await readFile(join(profileDir, 'package.json'), 'utf8')).toBe(original)
    await dialog.getByRole('searchbox', { name: copy.search }).fill('no-such-bundle')
    await dialog.getByText(copy.noMatches, { exact: true }).waitFor()
    expect(await dialog.getByText('Reviewed example', { exact: true }).count()).toBe(0)
    await dialog.getByRole('searchbox', { name: copy.search }).fill('QABAS TESTS')
    await dialog.getByText('Reviewed example', { exact: true }).waitFor()
    await dialog.getByRole('searchbox', { name: copy.search }).fill('')
    if (copy.replacement) await dialog.getByRole('button', { name: copy.updates, exact: true }).click()
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/${copy.replacement ? 'bundle-replacement' : 'bundle-marketplace'}.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
    const screenshotDirectory = process.env.DSH_MARKETPLACE_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) {
      await page.screenshot({ path: join(screenshotDirectory, `marketplace.${copy.locale}.png`) })
    }
    await dialog.getByRole('button', { name: copy.replacement ? copy.replace : copy.review }).click()
    if (copy.replacement) {
      await dialog.getByText('0.9.0 → 1.0.0', { exact: true }).waitFor()
      const confirmBox = await dialog.getByRole('button', { name: copy.replaceConfirm, exact: true }).boundingBox()
      const reviewDialogBox = await dialog.boundingBox()
      if (confirmBox === null || reviewDialogBox === null) throw new Error('Version confirmation is not rendered')
      expect(confirmBox.y + confirmBox.height).toBeLessThan(reviewDialogBox.y + reviewDialogBox.height)
      await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/bundle-replacement-review.${copy.locale}.aria.txt`),
        await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
      if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `replacement-review.${copy.locale}.png`) })
    }
    expect(queued).toHaveLength(0)
    await dialog.getByRole('button', { name: copy.replacement ? copy.replaceConfirm : copy.confirm }).click()
    await dialog.getByText(copy.pending, { exact: true }).waitFor({ timeout: 60_000 })
    expect(queued).toHaveLength(1)
    const candidate = queued[0]!
    const prepared = await readFile(join(home, 'profiles', candidate.profile, 'package.json'))
    expect(createHash('sha256').update(prepared).digest('hex')).toBe(candidate.manifestSha256)
    expect(await readFile(join(profileDir, 'package.json'), 'utf8')).toBe(original)
    if (copy.replacement) {
      expect(JSON.parse(await readFile(join(oldPackage, 'package.json'), 'utf8'))).toMatchObject({ version: '0.9.0' })
    }
    await dialog.getByRole('button', { name: copy.history, exact: true }).click()
    await dialog.getByText(copy.prepared, { exact: true }).waitFor()
    expect(queued).toHaveLength(1)
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/${copy.replacement ? 'bundle-replacement-history' : 'bundle-marketplace-history'}.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
    await dialog.getByRole('button', { name: copy.installed, exact: true }).click()
    await dialog.getByText(copy.version, { exact: true }).waitFor()
    // Multiple Profile inventories can exceed one screen; the selected version must remain reachable.
    await dialog.getByText(copy.version, { exact: true }).scrollIntoViewIfNeeded()
    const versionBox = await dialog.getByText(copy.version, { exact: true }).boundingBox()
    const dialogBox = await dialog.boundingBox()
    if (versionBox === null || dialogBox === null) throw new Error('Installed version is not rendered')
    expect(versionBox.y + versionBox.height).toBeLessThan(dialogBox.y + dialogBox.height)
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/${copy.replacement ? 'bundle-replacement-installed' : 'bundle-installed'}.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `installed.${copy.locale}.png`) })
    await dialog.getByRole('button', { name: copy.discover, exact: true }).click()
    await page.context().setOffline(true)
    await dialog.getByText(copy.offline, { exact: true }).waitFor()
    expect(await dialog.getByRole('button', { name: copy.cancel }).count()).toBe(0)
    await page.context().setOffline(false)
    await dialog.getByText(copy.pending, { exact: true }).waitFor()
    expect(queued).toHaveLength(1)
    await dialog.getByRole('button', { name: copy.cancel }).click()
    await expect.poll(() => selection.pending).toBeNull()
    await dialog.getByRole('button', { name: copy.replacement ? copy.replace : copy.review }).waitFor({ state: 'visible' })
    expect(await readFile(join(home, 'profiles', candidate.profile, 'package.json'))).toEqual(prepared)
    // Only native selection is simulated here; packaged acceptance boots both resulting Profiles.
    selection = { ...selection, activeProfile: candidate.profile, previousProfile: 'web' as DesktopProfileSelection['activeProfile'] }
    const refreshed = page.waitForResponse('**/api/bundleMarketplace/snapshot')
    await dialog.getByRole('button', { name: copy.refresh, exact: true }).click()
    await refreshed
    await dialog.getByRole('button', { name: copy.installed, exact: true }).click()
    await dialog.getByRole('button', { name: copy.remove, exact: true }).click()
    expect(queued).toHaveLength(1)
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/bundle-removal.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-bundle-marketplace]', scaffold.workspaceCwd), webSnapshotMode())
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `removal.${copy.locale}.png`) })
    await dialog.getByRole('button', { name: copy.removeConfirm, exact: true }).click()
    await dialog.getByRole('button', { name: copy.cancel, exact: true }).waitFor({ timeout: 60_000 })
    expect(queued).toHaveLength(2)
    const removal = queued[1]!
    expect(removal.previousProfile).toBe(candidate.profile)
    const removed = JSON.parse(await readFile(join(home, 'profiles', removal.profile, 'package.json'), 'utf8')) as { dependencies: object; dsh: { profile: { bundles: string[] } } }
    expect(removed.dependencies).toEqual({})
    expect(removed.dsh.profile.bundles).toEqual([])
    expect(await readFile(join(home, 'profiles', candidate.profile, 'package.json'))).toEqual(prepared)
    await expect(readFile(join(home, 'profiles', removal.profile, 'node_modules/marketplace-web-fixture/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => { failures.push(error) })
    if (failures.length > 0) throw new AggregateError(failures, 'Marketplace fixture cleanup failed')
  }
})
