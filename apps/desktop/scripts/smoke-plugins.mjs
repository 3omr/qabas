/** Exercise offline external Bundle install, browser activation, and removal with the packaged CLI. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(desktop, '../..')
const { chromium } = createRequire(join(root, 'apps/web/package.json'))('playwright')
const runtime = resolve(process.env.DSH_DESKTOP_RUNTIME_OUTPUT ?? join(desktop, 'resources/runtime'))
const node = join(runtime, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const entry = join(runtime, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js')
const name = '@deepseek-ai/dsh-desktop-plugin-fixture'
const temporary = await mkdtemp(join(tmpdir(), 'dsh-desktop-plugins-'))
const home = join(temporary, 'home')
const fixture = join(temporary, 'fixture')
const children = new Set()
let browser

// A clean PATH proves the installer does not borrow the developer's Node or pnpm.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LANG|LC_ALL)$/iu.test(key))),
  PATH: join(runtime, 'node'),
  HOME: temporary,
  USERPROFILE: temporary,
  XDG_CONFIG_HOME: join(temporary, 'config'),
  XDG_CACHE_HOME: join(temporary, 'cache'),
  XDG_DATA_HOME: join(temporary, 'data'),
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_DESKTOP_SMOKE_LLM_KEY: 'smoke-no-real-provider-key',
  CI: 'true',
  npm_config_update_notifier: 'false',
  npm_config_manage_package_manager_versions: 'false',
  npm_config_ignore_scripts: 'true',
  npm_config_ignore_pnpmfile: 'true',
  npm_config_offline: 'true',
  npm_config_registry: 'http://127.0.0.1:1',
  npm_config_store_dir: join(temporary, 'store'),
  npm_config_cache_dir: join(temporary, 'cache'),
  npm_config_state_dir: join(temporary, 'state'),
}

function start(args, cwd = temporary, harnessHome = home) {
  const child = spawn(node, args, {
    cwd, env: { ...env, DSH_HOME: harnessHome }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  children.add(child)
  const result = { child, output: '', error: undefined, timedOut: false }
  const collect = chunk => {
    result.output = (result.output + chunk.toString().replace(/([?&]token=)[^\s&#]+/gu, '$1<redacted>')).slice(-16_384)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', error => { result.error = error })
  result.closed = new Promise(resolveClosed => child.once('close', (code, signal) => {
    children.delete(child)
    resolveClosed({ code, signal })
  }))
  return result
}

function terminate(child, signal) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
    assert(systemRoot, 'Windows process cleanup requires SYSTEMROOT')
    const result = spawnSync(join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 10_000,
    })
    if (result.error) throw result.error
    // taskkill also reports a nonzero status if the tree exited before it reached the PID.
    child.kill('SIGKILL')
    return
  }
  try { process.kill(-child.pid, signal) } catch (error) {
    // ESRCH means the owned process group already reached quiescence.
    if (error.code !== 'ESRCH') throw error
  }
}

async function stop(run) {
  if (!children.has(run.child)) return
  terminate(run.child, 'SIGTERM')
  const force = setTimeout(() => terminate(run.child, 'SIGKILL'), 5_000)
  try { await run.closed } finally { clearTimeout(force) }
}

async function command(args, expected = 0, cwd = temporary) {
  const run = start(args, cwd)
  const deadline = setTimeout(() => { run.timedOut = true; terminate(run.child, 'SIGKILL') }, 60_000)
  try {
    const { code, signal } = await run.closed
    assert.equal(run.error, undefined)
    assert.equal(run.timedOut, false, 'Packaged CLI timed out')
    assert.equal(signal, null, 'Packaged CLI was terminated')
    assert.equal(code, expected, run.output)
    return run.output
  } finally { clearTimeout(deadline); await stop(run) }
}

async function startWeb(extra = [], harnessHome = home, profileName = 'web') {
  const run = start([entry, '--profile', profileName, ...extra, '--port', '0', '--no-open'], temporary, harnessHome)
  const url = await new Promise((resolveUrl, reject) => {
    let text = ''
    const timeout = setTimeout(() => finish(new Error('Plugin Web readiness timed out\n' + run.output)), 60_000)
    const onData = chunk => {
      text = (text + chunk.toString()).slice(-16_384)
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/u.exec(text)
      if (match) finish(undefined, match[1])
    }
    const onClose = () => finish(new Error('Plugin Web exited before readiness\n' + run.output))
    function finish(error, value) {
      clearTimeout(timeout)
      run.child.stdout.off('data', onData)
      run.child.off('close', onClose)
      if (error) reject(error)
      else resolveUrl(value)
    }
    run.child.stdout.on('data', onData)
    run.child.once('close', onClose)
  }).catch(async error => { await stop(run); throw error })
  return { run, url }
}

async function openBrowser(url) {
  const page = await browser.newPage({ locale: 'en-US' })
  try {
    // The CLI prints its origin before the HTTP listener finishes binding.
    const deadline = Date.now() + 30_000
    for (;;) {
      try { await page.goto(url); break } catch (error) {
        if (Date.now() >= deadline || !String(error).includes('ERR_CONNECTION_REFUSED')) throw error
        await new Promise(resolveRetry => setTimeout(resolveRetry, 50))
      }
    }
    // The private home's seeded settings select English and acknowledge first-run setup.
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('dialog').count(), 0)
    return page
  } catch (error) { await page.close(); throw error }
}

async function inspectBrowser(url, installed) {
  const page = await openBrowser(url)
  try {
    if (installed) {
      await page.getByTestId('desktop-plugin-fixture').waitFor({ state: 'visible' })
      assert.equal(await page.getByTestId('desktop-plugin-fixture').textContent(), 'External plugin ready')
    } else {
      assert.equal(await page.getByTestId('desktop-plugin-fixture').count(), 0)
    }
  } finally { await page.close() }
}

async function inspectMarketplace({ replace = false, kind = 'focus-timer' } = {}) {
  const controls = kind === 'notification-controls'
  const delegation = kind === 'delegation-launcher'
  const packageName = `@deepseek-ai/dsh-${kind}`
  const notifications = []
  const notificationAddress = join(temporary, 'notification-fixture-address.json')
  const delegationAddress = join(temporary, 'delegation-fixture-address.json')
  let selection = { schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null }
  const queued = []
  let agentWindows = 0
  const bridge = createServer((request, response) => {
    if (request.headers['x-dsh-desktop-bridge-token'] !== 'marketplace-smoke-token') { response.writeHead(403).end(); return }
    response.setHeader('content-type', 'application/json')
    if (request.method === 'POST' && request.url === '/v1/local-agents') { agentWindows++; response.end('{"ok":true}'); return }
    if (request.method === 'GET' && request.url === '/v1/profile-selection') { response.end(JSON.stringify({ ok: true, selection })); return }
    if (request.method === 'POST' && request.url === '/v1/runtime-ready') { response.end('{"ok":true}'); return }
    if (request.method !== 'POST' || !['/v1/profile-queue', '/v1/notify'].includes(request.url)) { response.writeHead(404).end(); return }
    let body = ''
    request.on('error', () => { response.destroy() })
    request.on('data', chunk => { body += chunk.toString(); if (body.length > 4096) request.destroy() })
    request.on('end', () => {
      try {
        const candidate = JSON.parse(body)
        if (request.url === '/v1/notify') { notifications.push(candidate); response.end('{"ok":true}'); return }
        assert.equal(candidate.previousProfile, selection.activeProfile)
        assert.equal(selection.pending, null)
        queued.push(candidate)
        selection = { ...selection, pending: candidate }
        response.end('{"ok":true}')
      } catch { response.writeHead(400).end() }
    })
  })
  let active
  let page
  try {
    bridge.listen(0, '127.0.0.1')
    await once(bridge, 'listening')
    const manifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'))
    const marketplace = await mkdtemp(join(temporary, 'marketplace-'))
    await cp(join(runtime, 'marketplace'), marketplace, { recursive: true })
    const catalogPath = join(marketplace, 'catalog.json')
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
    const timerEntry = catalog.entries.find(item => item.packageName === packageName)
    assert(timerEntry)
    const sourcePackage = join(home, 'profiles/web/node_modules', packageName, 'package.json')
    let sourcePackageBytes
    if (replace) {
      // A private versioned copy exercises replacement without changing the shipped catalog or artifact.
      await command([entry, 'plugin', '--profile', 'web', 'add', `file:${join(marketplace, timerEntry.artifact.file)}`,
        '--offline', '--ignore-scripts', '--ignore-pnpmfile'])
      sourcePackageBytes = await readFile(sourcePackage)
      const updatedPackage = join(marketplace, 'replacement-package')
      await cp(await realpath(join(home, 'profiles/web/node_modules/@deepseek-ai/dsh-focus-timer')), updatedPackage, { recursive: true })
      const nextVersion = '9.9.9-smoke-test'
      await writeFile(join(updatedPackage, 'package.json'), JSON.stringify({ ...JSON.parse(sourcePackageBytes.toString('utf8')), version: nextVersion }))
      await command([join(runtime, 'tools/pnpm/bin/pnpm.mjs'), 'pack', '--config.node-linker=hoisted', '--pack-destination', marketplace], 0, updatedPackage)
      const file = `deepseek-ai-dsh-focus-timer-${nextVersion}.tgz`
      const artifact = await readFile(join(marketplace, file))
      timerEntry.version = nextVersion
      timerEntry.artifact = { file, size: artifact.length, sha256: createHash('sha256').update(artifact).digest('hex') }
      await writeFile(catalogPath, JSON.stringify(catalog))
    }
    const packages = join(runtime, 'app/node_modules/@deepseek-ai')
    const overlay = join(temporary, 'marketplace.patch.yml')
    let text = await readFile(join(runtime, 'desktop.cordis.yml'), 'utf8')
    for (const [placeholder, value] of Object.entries({
      __DSH_DESKTOP_NATIVE_ENTRY__: pathToFileURL(join(packages, 'dsh-desktop-native/lib/index.js')).href,
      __DSH_BUNDLE_PREPARATION_ENTRY__: pathToFileURL(join(packages, 'dsh-bundle-preparation/lib/index.js')).href,
      __DSH_BUNDLE_MARKETPLACE_ENTRY__: pathToFileURL(join(packages, 'dsh-bundle-marketplace/lib/index.js')).href,
      __DSH_BUNDLE_CATALOG__: catalogPath, __DSH_BUNDLE_ARTIFACTS__: marketplace,
      __DSH_BUNDLE_STAGING__: join(home, 'bundle-marketplace/staging'), __DSH_BUNDLE_JOURNAL__: join(home, 'bundle-marketplace/operations'),
      __DSH_BUNDLE_HOME__: home, __DSH_BUNDLE_DSH_ENTRY__: entry,
      __DSH_BUNDLE_PNPM_ENTRY__: join(runtime, 'tools/pnpm/bin/pnpm.mjs'), __DSH_BUNDLE_PNPM_VERSION__: manifest.pnpmVersion,
      __DSH_HARNESS_VERSION__: manifest.harnessVersion,
      '!!js process.env.DSH_DESKTOP_BRIDGE_URL': `http://127.0.0.1:${bridge.address().port}`,
      '!!js process.env.DSH_DESKTOP_BRIDGE_TOKEN': 'marketplace-smoke-token',
      '!!js process.env.DSH_DESKTOP_STARTUP_TOKEN': 'a'.repeat(32),
    })) text = text.replaceAll(placeholder, JSON.stringify(value))
    assert.doesNotMatch(text, /__DSH_[A-Z_]+__/u)
    // Marketplace verification opts into its parent section, which Qabas omits from the default roster.
    text += `\n- insert:\n    - id: ui-settings-plugins\n      name: ${JSON.stringify(pathToFileURL(join(packages, 'dsh-client-ui-settings-plugins/lib/index.js')).href)}\n`
    if (controls) text += `\n- insert:\n    - id: notification-fixture\n      name: ${JSON.stringify(pathToFileURL(join(desktop, 'tests/fixtures/notification-events.mjs')).href)}\n      config:\n        resultFile: ${JSON.stringify(notificationAddress)}\n        bridgeEndpoint: ${JSON.stringify(`http://127.0.0.1:${bridge.address().port}`)}\n`
    if (delegation) {
      // The transcription preset omits generic job tools; delegation needs a controller in its test composition.
      text += `\n- insert:\n    - id: marketplace-jobs-controller\n      name: ${JSON.stringify(pathToFileURL(join(packages, 'dsh-tool-jobs/lib/index.js')).href)}\n`
      text += `\n- insert:\n    - id: delegation-fixture\n      name: ${JSON.stringify(pathToFileURL(join(desktop, 'tests/fixtures/delegation-provider.mjs')).href)}\n      config:\n        resultFile: ${JSON.stringify(delegationAddress)}\n`
    }
    await writeFile(overlay, text)
    const original = await readFile(join(home, 'profiles/web/package.json'))
    active = await startWeb(['--patch', overlay])
    page = await openBrowser(active.url)
    assert.equal(await page.getByRole('button', { name: 'Focus timer', exact: true }).count(), replace ? 1 : 0)
    if (delegation) assert.equal(await page.getByRole('button', { name: 'Delegate task', exact: true }).count(), 0)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    await dialog.getByText('Focus Timer', { exact: true }).waitFor()
    assert.equal(agentWindows, 0)
    const openedAgents = page.waitForResponse('**/api/bundleMarketplace/openLocalAgents')
    await dialog.getByRole('button', { name: 'Configure local agents', exact: true }).click()
    await openedAgents
    assert.equal(agentWindows, 1)
    assert.equal(queued.length, 0)
    await dialog.getByRole('listitem').filter({ hasText: packageName })
      .getByRole('button', { name: replace ? 'Review version change' : 'Review installation', exact: true }).click()
    if (replace) await dialog.getByText(`${manifest.harnessVersion} → ${timerEntry.version}`, { exact: true }).waitFor()
    assert.equal(queued.length, 0)
    await dialog.getByRole('button', { name: replace ? 'Replace for next launch' : 'Install for next launch', exact: true }).click()
    await page.waitForFunction(() => {
      const market = document.querySelector('[data-bundle-marketplace]')
      return market !== null && (market.textContent?.includes('Waiting for app restart') || market.querySelector('[role="alert"]') !== null)
    }, undefined, { timeout: 60_000 })
    assert.equal(await dialog.getByText('Waiting for app restart', { exact: true }).isVisible(), true,
      'The reviewed artifact must install offline and reach pending activation, not an unconfirmed outcome')
    assert.equal(queued.length, 1)
    assert.deepEqual(await readFile(join(home, 'profiles/web/package.json')), original)
    if (replace) assert.deepEqual(await readFile(sourcePackage), sourcePackageBytes)
    const candidate = queued[0]
    const bytes = await readFile(join(home, 'profiles', candidate.profile, 'package.json'))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.manifestSha256)
    const profileDirectory = join(home, 'profiles', candidate.profile)
    const resolvedBundle = JSON.parse(await command(['--input-type=module', '-e', `
      import { resolveBundleDir } from ${JSON.stringify(pathToFileURL(join(packages, 'dsh-app-boot/lib/index.js')).href)};
      console.log(JSON.stringify(resolveBundleDir('smoke', ${JSON.stringify(packageName)},
        ${JSON.stringify(join(packages, 'dsh/package.json'))}, ${JSON.stringify(profileDirectory)})));
    `]))
    assert.equal(await realpath(resolvedBundle), await realpath(join(profileDirectory, 'node_modules', packageName)),
      'The boot resolver must load the reviewed Profile artifact, not an installation-owned copy')
    await page.close(); page = undefined
    await stop(active.run); active = undefined
    if (controls) await rm(notificationAddress, { force: true })
    if (delegation) await rm(delegationAddress, { force: true })
    // Native selection/recovery is covered by the Rust packaged test. Here only that boundary is simulated.
    selection = { ...selection, activeProfile: candidate.profile, previousProfile: 'web', pending: null }
    active = await startWeb(['--patch', overlay], home, candidate.profile)
    page = await openBrowser(active.url)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    let installedSettings = page.getByRole('dialog', { name: 'Settings' })
    await installedSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await installedSettings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    const included = installedSettings.getByRole('listitem').filter({ hasText: packageName })
      .getByRole('button', { name: 'In selected combination', exact: true })
    await included.waitFor()
    assert.equal(await included.isDisabled(), true)
    await installedSettings.getByRole('button', { name: 'Installed', exact: true }).click()
    const installedTimer = installedSettings.getByRole('listitem').filter({ hasText: packageName })
    await installedTimer.getByText(`Package version: ${timerEntry.version}`, { exact: true }).waitFor()
    if (delegation) {
      await inspectDelegation(page, installedSettings, installedTimer, active.run, delegationAddress)
    } else if (controls) {
      const editor = installedTimer.locator('[data-notification-controls]')
      await editor.getByText('Configure notifications', { exact: true }).click()
      const completed = editor.getByRole('checkbox', { name: 'Notify when a task finishes', exact: true })
      const failed = editor.getByRole('checkbox', { name: 'Notify when a task fails', exact: true })
      await completed.waitFor()
      const layout = await installedTimer.evaluate(card => {
        const editor = card.querySelector('[data-notification-controls]').getBoundingClientRect()
        const button = [...card.querySelectorAll('button')].find(item => item.textContent === 'Review removal').getBoundingClientRect()
        const bounds = card.getBoundingClientRect()
        return { configurationBelowRemoval: editor.top >= button.bottom, fullWidth: editor.width >= bounds.width - 40 }
      })
      assert.deepEqual(layout, { configurationBelowRemoval: true, fullWidth: true })
      assert.equal(await completed.isChecked(), true)
      assert.equal(await failed.isChecked(), true)
      const emit = async (kind) => {
        const address = await readConsumerResult(active.run, notificationAddress)
        const response = await fetch(`${address.url}/${kind}`, { method: 'POST', headers: { 'x-notification-fixture': 'private-test' } })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { committed: true })
      }
      await emit('completed')
      assert.equal(notifications.length, 1)
      await completed.click()
      await page.waitForFunction(() => document.querySelector('[data-notification-controls] input')?.checked === false)
      await emit('completed')
      assert.equal(notifications.length, 1)
      await emit('error')
      assert.equal(notifications.length, 2)
      await failed.click()
      await page.waitForFunction(() => [...document.querySelectorAll('[data-notification-controls] input')].every(input => !input.checked))
      await emit('error'); await emit('child'); await emit('restored'); await emit('aborted')
      assert.equal(notifications.length, 2)
      assert.deepEqual(notifications, [
        { title: 'Qabas', body: 'Task finished. Open Qabas to review.', backgroundOnly: true },
        { title: 'Qabas', body: 'Task failed. Open Qabas to review.', backgroundOnly: true },
      ])
      const expected = join(desktop, 'tests/expected/notification-controls.aria.txt')
      const aria = `${await editor.ariaSnapshot()}\n`
      if (process.env.DSH_DESKTOP_RECORD_EXPECTED === '1') await writeFile(expected, aria)
      else assert.equal(aria, await readFile(expected, 'utf8'))
      if (process.env.DSH_DESKTOP_CAPTURE_PREVIEW === '1') {
        const preview = await mkdtemp(join(tmpdir(), 'dsh-notifications-preview-'))
        await installedSettings.screenshot({ path: join(preview, 'notification-controls.png') })
        console.log(`Notification Controls preview: ${preview}`)
      }
      await page.close(); page = undefined
      await stop(active.run); active = undefined
      await rm(notificationAddress, { force: true })
      active = await startWeb(['--patch', overlay], home, candidate.profile)
      page = await openBrowser(active.url)
      await emit('completed'); await emit('error')
      assert.equal(notifications.length, 2)
      installedSettings = page.getByRole('dialog', { name: 'Settings' })
    } else {
      assert.equal(`${await installedTimer.getByRole('button', { name: 'Open timer', exact: true }).ariaSnapshot()}\n`,
        await readFile(join(desktop, 'tests/expected/focus-timer-action.aria.txt'), 'utf8'))
      await installedTimer.getByRole('button', { name: 'Open timer', exact: true }).click()
      await installedSettings.waitFor({ state: 'hidden' })
      const timer = page.getByRole('dialog', { name: 'Focus timer', exact: true })
      await timer.waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
      await timer.getByText(/^(No saved duration|Saved duration:)/u).waitFor()
      const clearPreference = timer.getByRole('button', { name: 'Clear saved duration', exact: true })
      if (await clearPreference.isEnabled()) {
        await clearPreference.click()
        await timer.getByText('No saved duration', { exact: true }).waitFor()
      }
      await timer.getByRole('spinbutton').fill('1')
      await timer.getByRole('button', { name: 'Save this duration', exact: true }).click()
      await timer.getByText('Saved duration: 1 min', { exact: true }).waitFor()
      await timer.getByRole('button', { name: 'Start', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[data-focus-timer] [role="timer"]')?.textContent?.startsWith('0:'), undefined, { timeout: 10_000 })
      await timer.getByRole('button', { name: 'Pause', exact: true }).click()
      assert.equal(await timer.getByRole('status').textContent(), 'Paused')
      const remaining = await timer.getByRole('timer').textContent()
      await page.keyboard.press('Escape')
      await timer.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      await installedSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
      await installedSettings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
      await installedSettings.getByRole('button', { name: 'Installed', exact: true }).click()
      await installedTimer.getByRole('button', { name: 'Open timer', exact: true }).click()
      await installedSettings.waitFor({ state: 'hidden' })
      await timer.waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
      assert.equal(await timer.getByRole('timer').textContent(), remaining)
      assert.equal(await timer.getByRole('status').textContent(), 'Paused')
      await timer.getByRole('button', { name: 'Reset', exact: true }).click()
      assert.equal(await timer.getByRole('timer').textContent(), '1:00')
      await page.keyboard.press('Escape')
      await timer.waitFor({ state: 'hidden' })
      await page.close(); page = undefined
      await stop(active.run); active = undefined
      active = await startWeb(['--patch', overlay], home, candidate.profile)
      page = await openBrowser(active.url)
      await page.getByRole('button', { name: 'Focus timer', exact: true }).click()
      const restoredTimer = page.getByRole('dialog', { name: 'Focus timer', exact: true })
      await restoredTimer.getByText('Saved duration: 1 min', { exact: true }).waitFor()
      assert.equal(await restoredTimer.getByRole('spinbutton').inputValue(), '1')
      assert.equal(await restoredTimer.getByRole('timer').textContent(), '1:00')
      assert.equal(await restoredTimer.getByRole('status').textContent(), 'Choose a duration')
      await page.keyboard.press('Escape')
      await restoredTimer.waitFor({ state: 'hidden' })
      installedSettings = page.getByRole('dialog', { name: 'Settings' })
    }
    const preferenceBytes = await readFile(join(home, 'settings.yaml'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await installedSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await installedSettings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    await installedSettings.getByRole('button', { name: 'Installed', exact: true }).click()
    await installedSettings.getByRole('listitem').filter({ hasText: packageName })
      .getByRole('button', { name: 'Review removal', exact: true }).click()
    assert.equal(queued.length, 1)
    const originalInstalled = await readFile(join(profileDirectory, 'package.json'))
    await installedSettings.getByRole('button', { name: 'Remove for next launch', exact: true }).click()
    await installedSettings.getByRole('button', { name: 'Cancel pending activation', exact: true }).waitFor({ timeout: 60_000 })
    assert.equal(queued.length, 2)
    const removal = queued[1]
    assert.equal(removal.previousProfile, candidate.profile)
    assert.deepEqual(await readFile(join(profileDirectory, 'package.json')), originalInstalled)
    assert.equal(JSON.parse(await readFile(join(profileDirectory, 'node_modules', packageName, 'package.json'), 'utf8')).version,
      timerEntry.version)
    await page.close(); page = undefined
    await stop(active.run); active = undefined
    if (controls) await rm(notificationAddress, { force: true })
    if (delegation) await rm(delegationAddress, { force: true })
    selection = { ...selection, activeProfile: removal.profile, previousProfile: candidate.profile, pending: null }
    active = await startWeb(['--patch', overlay], home, removal.profile)
    page = await openBrowser(active.url)
    if (delegation) assert.equal(await page.getByRole('button', { name: 'Delegate task', exact: true }).count(), 0)
    else if (!controls) assert.equal(await page.getByRole('button', { name: 'Focus timer', exact: true }).count(), 0)
    else {
      const address = await readConsumerResult(active.run, notificationAddress)
      for (const kind of ['completed', 'error']) {
        const response = await fetch(`${address.url}/${kind}`, { method: 'POST', headers: { 'x-notification-fixture': 'private-test' } })
        assert.equal(response.status, 200)
      }
      assert.equal(notifications.length, 4)
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const removedSettings = page.getByRole('dialog', { name: 'Settings' })
    await removedSettings.getByRole('button', { name: 'Plugins', exact: true }).click()
    await removedSettings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
    const reinstall = removedSettings.getByRole('listitem').filter({ hasText: packageName })
      .getByRole('button', { name: 'Review installation', exact: true })
    await reinstall.waitFor()
    assert.equal(await reinstall.isEnabled(), true)
    await removedSettings.getByRole('button', { name: 'Installed', exact: true }).click()
    assert.equal(await removedSettings.getByRole('listitem').filter({ hasText: packageName }).count(), 0)
    assert.deepEqual(await readFile(join(home, 'settings.yaml')), preferenceBytes)
    assert.deepEqual(await readFile(join(home, 'profiles/web/package.json')), original)
  } catch (error) {
    // This fixture owns a private, credential-free home; process output already redacts startup URL tokens.
    console.error(await page?.locator('[data-bundle-marketplace]').innerText({ timeout: 1000 }).catch(() => 'Marketplace unavailable'))
    console.error(await page?.locator('body').ariaSnapshot({ timeout: 1000 }).catch(() => 'Browser state unavailable'))
    if (active !== undefined) console.error(active.run.output)
    throw error
  } finally {
    await page?.close()
    if (active !== undefined) await stop(active.run)
    if (bridge.listening) {
      const closed = once(bridge, 'close')
      bridge.close(); bridge.closeAllConnections()
      await closed
    }
  }
}

/** Exercise the installed Bundle's own action and task controls with only the external provider controlled. */
async function inspectDelegation(page, settings, card, run, addressFile) {
  const address = await readConsumerResult(run, addressFile)
  const control = async (path, method = 'GET') => {
    const response = await fetch(`${address.url}/${path}`, { method, headers: { 'x-delegation-fixture': 'private-test' } })
    assert.equal(response.status, 200)
    return response.json()
  }
  assert.deepEqual(await control('state'), [], 'Installing and browsing must not start a provider')
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  const workspace = join(temporary, 'delegation-workspace')
  await mkdir(workspace)
  await page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' }).click()
  await page.getByRole('textbox', { name: 'Choose workspace', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory', exact: true })
  await picker.getByRole('button', { name: 'Edit path', exact: true }).click()
  const path = picker.getByRole('textbox', { name: 'Edit path', exact: true })
  await path.fill(workspace); await path.press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await picker.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await settings.getByRole('button', { name: 'Plugins', exact: true }).click()
  await settings.getByRole('tab', { name: 'Marketplace', exact: true }).click()
  await settings.getByRole('button', { name: 'Installed', exact: true }).click()
  await card.getByRole('button', { name: 'Delegate a task', exact: true }).click()
  await settings.waitFor({ state: 'hidden' })
  const panel = page.getByRole('dialog', { name: 'Delegate task', exact: true })
  await panel.waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  await panel.getByRole('combobox', { name: 'Agent provider', exact: true }).selectOption('marketplace-fixture')
  const task = panel.getByRole('textbox', { name: 'Task', exact: true })
  const send = panel.getByRole('button', { name: 'Start delegation', exact: true })
  await task.fill('Inspect the packaged fixture workspace')
  assert.equal(await send.isDisabled(), true)
  await panel.getByRole('checkbox').check()
  await send.click()
  await panel.getByText(/Delegation queued as subagent-1/u).waitFor()
  const started = await control('state')
  assert.equal(started.length, 1)
  assert.deepEqual(started[0].prompt, [{ type: 'text', text: 'Inspect the packaged fixture workspace' }])
  await control('complete', 'POST')
  await panel.getByRole('button', { name: 'Read result', exact: true }).click()
  await panel.getByText('Packaged delegation result', { exact: true }).waitFor()
  await task.fill('Cancel the packaged fixture task')
  await panel.getByRole('checkbox').check()
  await send.click()
  await panel.getByText(/Delegation queued as subagent-2/u).waitFor()
  await panel.getByRole('button', { name: 'Cancel task', exact: true }).click()
  assert.equal((await control('state'))[1].aborted, false)
  await panel.getByRole('button', { name: 'Confirm cancel', exact: true }).click()
  await panel.getByText('Stopping — waiting for cleanup', { exact: true }).waitFor()
  const stopping = await control('state')
  assert.equal(stopping[1].aborted, true)
  assert.equal(stopping[1].disposed, false)
  assert.equal(stopping[0].owner, stopping[1].owner)
  await control('cleanup', 'POST')
  await panel.getByText('Canceled', { exact: true }).waitFor()
  assert.equal((await control('state'))[1].disposed, true)
  const aria = `${await panel.locator('[data-delegation-launcher]').ariaSnapshot()}\n`
    .replaceAll(await realpath(temporary), '{{temporary}}').replaceAll(temporary, '{{temporary}}')
  const expected = join(desktop, `tests/expected/delegation-tasks${process.platform === 'win32' ? '.windows' : ''}.aria.txt`)
  if (process.env.DSH_DESKTOP_RECORD_EXPECTED === '1') await writeFile(expected, aria)
  else assert.equal(aria, await readFile(expected, 'utf8'))
  if (process.env.DSH_DESKTOP_CAPTURE_PREVIEW === '1') {
    const preview = await mkdtemp(join(tmpdir(), 'dsh-delegation-market-preview-'))
    await panel.screenshot({ path: join(preview, 'delegation.png') })
    console.log(`Delegation marketplace preview: ${preview}`)
  }
  await panel.getByRole('button', { name: 'Close', exact: true }).click()
  await panel.waitFor({ state: 'hidden' })
}

async function readConsumerResult(run, file) {
  const deadline = Date.now() + 30_000
  for (;;) {
    try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline || !children.has(run.child)) throw error
      await new Promise(resolveRetry => setTimeout(resolveRetry, 50))
    }
  }
}

try {
  await mkdir(home)
  // Qabas selects Arabic and walks its first-run steps on a fresh home; the
  // smoke drives the English UI past that sequence, whose step ids and notice
  // version mirror packages/client/ui-settings-models, ui-settings-transcriber-engine and ui-setup.
  await writeFile(join(home, 'settings.yaml'), [
    'locale:',
    '  preference: en',
    'llm-pi-ai:',
    '  providers:',
    '    deepseek:',
    '      apiKeyEnv: DSH_DESKTOP_SMOKE_LLM_KEY',
    '      baseURL: http://127.0.0.1:1',
    'agent-default-model:',
    '  provider: deepseek',
    '  model: deepseek-v4-flash',
    'ui-onboarding:',
    '  welcomeNoticeVersion: 2026-08-13.1',
    '  completedSteps:',
    '    - welcome-notice',
    '    - pi-ai-provider',
    '    - transcriber-engine',
    '    - qabas-library',
    '',
  ].join('\n'))
  await cp(join(desktop, 'tests/fixtures/plugin-bundle'), fixture, { recursive: true })
  const dependency = join(fixture, 'node_modules/dsh-fixture-dependency')
  await mkdir(dependency, { recursive: true })
  await writeFile(join(dependency, 'package.json'), JSON.stringify({
    name: 'dsh-fixture-dependency', version: '1.0.0', main: 'index.js',
    scripts: { postinstall: 'node -e "process.exit(74)"' },
  }))
  await writeFile(join(dependency, 'index.js'), "module.exports = 'ready\\n'\n")
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name, version: '1.0.0', type: 'module',
    dependencies: { 'dsh-fixture-dependency': '1.0.0' },
    bundledDependencies: ['dsh-fixture-dependency'],
    exports: { '.': './host.mjs', './client': './client.js' },
    scripts: { postinstall: 'node -e "process.exit(73)"' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar'] } },
  }))
  await writeFile(join(fixture, 'cordis.patch.yml'), `- insert:\n    - id: desktop-plugin-fixture\n      name: '${name}'\n`)
  const manager = join(runtime, 'tools/pnpm/bin/pnpm.mjs')
  const version = (await command([manager, '--version'])).trim()
  const manifest = JSON.parse(await readFile(join(runtime, 'runtime-manifest.json'), 'utf8'))
  assert.equal(version, manifest.pnpmVersion)
  const artifacts = join(temporary, 'artifacts')
  await mkdir(artifacts)
  await command([manager, 'pack', '--config.node-linker=hoisted', '--pack-destination', artifacts], 0, fixture)
  const artifactFile = 'deepseek-ai-dsh-desktop-plugin-fixture-1.0.0.tgz'
  const artifactBytes = await readFile(join(artifacts, artifactFile))
  const missingFixture = join(temporary, 'missing-dependency')
  await mkdir(missingFixture)
  const missingName = 'dsh-missing-dependency-fixture'
  await writeFile(join(missingFixture, 'package.json'), JSON.stringify({
    name: missingName, version: '1.0.0', dependencies: { 'dsh-unavailable-fixture-dependency': '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(missingFixture, 'cordis.patch.yml'), '[]\n')
  await command([manager, 'pack', '--pack-destination', artifacts], 0, missingFixture)
  const missingFile = `${missingName}-1.0.0.tgz`
  const missingBytes = await readFile(join(artifacts, missingFile))
  const hostVersion = JSON.parse(await readFile(join(runtime, 'app/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version
  const catalogFile = join(temporary, 'catalog.json')
  const stagingDirectory = join(temporary, 'prepared')
  const resultFile = join(temporary, 'preparation-result.json')
  const overlay = join(temporary, 'prepare.patch.yml')
  await writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, entries: [{
    id: 'fixture', packageName: name, version: '1.0.0', title: 'Packaged fixture', publisher: 'Local test', details: null,
    source: 'https://github.com/Bestbbb/deepseek-harness-desktop', harnessVersions: [hostVersion],
    platforms: [`${process.platform}-${process.arch}`],
    artifact: { file: artifactFile, size: artifactBytes.length, sha256: createHash('sha256').update(artifactBytes).digest('hex') },
  }, {
    id: 'missing-dependency', packageName: missingName, version: '1.0.0', title: 'Missing dependency', publisher: 'Local test', details: null,
    source: 'https://github.com/Bestbbb/deepseek-harness-desktop', harnessVersions: [hostVersion],
    platforms: [`${process.platform}-${process.arch}`],
    artifact: { file: missingFile, size: missingBytes.length, sha256: createHash('sha256').update(missingBytes).digest('hex') },
  }] }))
  // JSON is a YAML subset; paths remain literal on Windows as well as POSIX.
  const preparationOverlay = [{ insert: [
    { id: 'bundle-preparation', name: pathToFileURL(join(runtime, 'app/node_modules/@deepseek-ai/dsh-bundle-preparation/lib/index.js')).href, config: {
      catalogFile, artifactDirectory: artifacts, stagingDirectory, hostVersion,
      installer: { nodeExecutable: node, packageManagerEntry: manager, packageManagerVersion: version,
        timeoutMs: 20_000, graceMs: 1_000, maxOutputBytes: 65_536, maxExpandedBytes: 134_217_728,
        maxArchiveEntries: 10_000, maxManifestBytes: 1_048_576 },
      composition: { harnessHome: home, profileName: 'web', dshEntry: entry,
        maxProfileBytes: 536_870_912, maxProfileEntries: 100_000 },
      journal: { directory: join(temporary, 'history'), maxEntries: 100, maxRecordBytes: 1_048_576 },
    } },
    { id: 'prepare-consumer', name: pathToFileURL(join(desktop, 'tests/fixtures/prepare-bundle.mjs')).href,
      config: { id: 'fixture', failureId: 'missing-dependency', stagingDirectory, resultFile } },
  ] }]
  await writeFile(overlay, JSON.stringify(preparationOverlay))
  const preparation = await startWeb(['--patch', overlay])
  let composition
  try {
    composition = await readConsumerResult(preparation.run, resultFile)
  } finally { await stop(preparation.run) }
  const historyFile = join(temporary, 'history-result.json')
  preparationOverlay[0].insert[1].config = { historyOnly: true, resultFile: historyFile }
  await writeFile(overlay, JSON.stringify(preparationOverlay))
  const restarted = await startWeb(['--patch', overlay])
  try {
    const history = await readConsumerResult(restarted.run, historyFile)
    assert.equal(history.length, 2)
    assert(history.some(item => item.state === 'prepared' && item.preparedState === 'composition-checked-not-enabled'))
    assert(history.some(item => item.state === 'failed' && item.kind === 'dependencies'))
    await assert.rejects(readFile(join(home, 'plugin-activated')), { code: 'ENOENT' })
  } finally { await stop(restarted.run) }
  assert.equal(composition.state, 'composition-checked-not-enabled')
  const receipt = composition.candidate
  assert.equal(receipt.state, 'dependencies-prepared-not-enabled')
  assert.deepEqual(await readFile(receipt.prepared.artifactPath), artifactBytes)
  assert((await readFile(receipt.lockfilePath)).length > 0)
  assert.equal(JSON.parse(await readFile(join(receipt.candidateDirectory, 'package.json'), 'utf8')).dsh, undefined)
  const dependencyPath = createRequire(join(receipt.packageDirectory, 'package.json')).resolve('dsh-fixture-dependency')
  assert.equal(await readFile(dependencyPath, 'utf8'), "module.exports = 'ready\\n'\n")
  const beforeInstall = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
  assert(!beforeInstall.dependencies?.[name])
  assert(!beforeInstall.dsh.profile.bundles.includes(name))
  await assert.rejects(readFile(join(home, 'plugin-activated')), { code: 'ENOENT' })
  browser = await chromium.launch()
  // Composition probes have their own home; the browser smoke uses the same declared UI preferences.
  await writeFile(join(composition.harnessHome, 'settings.yaml'), await readFile(join(home, 'settings.yaml')))
  const candidateWeb = await startWeb([], composition.harnessHome, composition.profileName)
  try {
    await inspectBrowser(candidateWeb.url, true)
    assert.equal(await readFile(join(composition.harnessHome, 'plugin-activated'), 'utf8'), 'ready\n')
    await assert.rejects(readFile(join(home, 'plugin-activated')), { code: 'ENOENT' })
  } finally { await stop(candidateWeb.run) }
  await command([entry, 'plugin', '--profile', 'web', 'add', `file:${receipt.prepared.artifactPath}`, '--offline', '--ignore-scripts', '--ignore-pnpmfile'])
  const profilePath = join(home, 'profiles/web/package.json')
  let profile = JSON.parse(await readFile(profilePath, 'utf8'))
  assert(profile.dsh.profile.bundles.includes(name))
  assert(profile.dependencies[name])
  let active = await startWeb()
  try {
    await inspectBrowser(active.url, true)
    assert.equal(await readFile(join(home, 'plugin-activated'), 'utf8'), 'ready\n')
  } finally { await stop(active.run) }
  const before = await readFile(profilePath, 'utf8')
  await command([entry, 'plugin', '--profile', 'web', 'add', `file:${join(temporary, 'missing-package')}`, '--offline', '--ignore-scripts', '--ignore-pnpmfile'], 1)
  assert.equal(await readFile(profilePath, 'utf8'), before)
  await command([entry, 'plugin', '--profile', 'web', 'remove', name])
  profile = JSON.parse(await readFile(profilePath, 'utf8'))
  assert(!profile.dsh.profile.bundles.includes(name))
  assert(!profile.dependencies?.[name])
  await rm(join(home, 'plugin-activated'))
  active = await startWeb()
  try {
    await inspectBrowser(active.url, false)
    await assert.rejects(readFile(join(home, 'plugin-activated')), { code: 'ENOENT' })
  } finally { await stop(active.run) }
  await inspectMarketplace()
  await inspectMarketplace({ kind: 'notification-controls' })
  await inspectMarketplace({ kind: 'delegation-launcher' })
  await inspectMarketplace({ replace: true })
  console.log('Packaged plugins: isolated dependencies, candidate Host + UI, reviewed Focus Timer, Notification Controls and Delegate Tasks installation, task controls, saved preferences, notification filtering, version replacement, removal and restart passed')
} finally {
  await browser?.close()
  for (const child of children) {
    const closed = once(child, 'close')
    terminate(child, 'SIGKILL')
    await closed
  }
  await rm(temporary, { recursive: true, force: true })
}
