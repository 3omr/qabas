/** Exercise the packaged recovery document without starting a real desktop or agent. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { REPO_ROOT } from './support.ts'

it.each(['en-US'])('recovers the packaged loading page (%s)', async (locale) => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale })
    const calls: unknown[] = []
    await page.exposeFunction('fixtureInvoke', (command: string, args: unknown) => {
      calls.push({ command, args })
      return Promise.resolve()
    })
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    await page.setContent(await readFile(join(REPO_ROOT, 'apps/desktop/loading/index.html'), 'utf8'))
    const error = '<script>unsafe</script> Runtime unavailable'
    await page.evaluate(message => dispatchEvent(new CustomEvent('dsh-desktop-runtime-error', { detail: message })), error)
    expect(await page.getByRole('alert').textContent()).toBe(error)
    expect(await page.locator('#spinner').isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.locator('#diagnostics').click()
    expect(calls).toEqual([
      { command: 'desktop_recovery', args: { action: 'retry' } },
      { command: 'desktop_recovery', args: { action: 'diagnostics' } },
    ])
    await page.evaluate(() => dispatchEvent(new CustomEvent('dsh-desktop-runtime-starting', { detail: 2 })))
    expect(await page.locator('#retry').isVisible()).toBe(false)
    expect(await page.getByRole('alert').isVisible()).toBe(false)
    expect(await page.locator('#spinner').isVisible()).toBe(true)
    expect(await page.getByRole('status').textContent()).toContain('2/3')
  } finally {
    await browser.close()
  }
})

it.each(['en-US'])('checks and opts into local agents without implying a live connection (%s)', async (locale) => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale })
    const calls: unknown[] = []
    let fail = false
    const fixtureState: { saveFailure?: string } = {}
    const entries: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/loading/agents.json'), 'utf8'))
    await page.exposeFunction('fixtureInvoke', (command: string, args: unknown) => {
      calls.push({ command, args })
      if (fail) throw new Error('private credential detail must not reach the page')
      if (command === 'desktop_agent_catalog') return entries
      if (command === 'desktop_agent_preferences' && args !== undefined && fixtureState.saveFailure !== undefined) throw fixtureState.saveFailure
      if (command === 'desktop_agent_preferences') return { codex: false, claude: false }
      return [
        { id: 'codex', state: 'runnable', version: '0.149.1', executable: '/test/bundled/codex.js', auth: 'authenticated', runtimeSource: 'bundled' },
        { id: 'claude', state: 'unavailable', version: null, executable: null, auth: 'unchecked', runtimeSource: 'bundled' },
        { id: 'kimi', state: 'runnable', version: '1.0.0', executable: '/test/bin/kimi', auth: 'manual-auth', runtimeSource: 'local-cli' },
        { id: 'qoder', state: 'missing', version: null, executable: null, auth: 'unchecked', runtimeSource: 'local-cli' },
      ]
    })
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    await page.setContent(await readFile(join(REPO_ROOT, 'apps/desktop/loading/extensions.html'), 'utf8'))
    await expect.poll(() => page.locator('#check').isEnabled()).toBe(true)
    expect(await page.locator('#save').isEnabled()).toBe(false)
    expect(calls).toEqual([{ command: 'desktop_agent_catalog', args: undefined }, { command: 'desktop_agent_preferences', args: undefined }])
    await page.locator('#check').click()
    await expect.poll(() => page.locator('article').first().textContent()).toContain('0.149.1')
    await page.getByRole('article', { name: 'Codex', exact: true }).locator('summary').click()
    await expect(await page.locator('main').ariaSnapshot()).toMatchFileSnapshot(join(REPO_ROOT, `apps/web/tests/expected/desktop-extensions.${locale}.aria.txt`))
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).check()
    const callsBeforeFiltering = calls.length
    await page.locator('#category').selectOption('acp')
    expect(await page.locator('article:visible').count()).toBe(2)
    await page.locator('#search').fill('kImI')
    expect(await page.locator('article:visible').count()).toBe(1)
    await page.getByRole('checkbox', { name: 'Kimi Code', exact: true }).check()
    await page.locator('#search').fill('no-such-extension')
    expect(await page.locator('#empty').isVisible()).toBe(true)
    await page.locator('#clear').click()
    expect(await page.locator('article:visible').count()).toBe(4)
    await page.locator('#selected').click()
    expect(await page.locator('article:visible').count()).toBe(2)
    expect(calls.length).toBe(callsBeforeFiltering)
    await page.locator('#save').click()
    await expect.poll(() => page.locator('#saved').textContent()).toContain('Saved')
    expect(calls.at(-1)).toEqual({ command: 'desktop_agent_preferences', args: { value: { codex: true, claude: false, kimi: true, qoder: false } } })
    expect(await page.locator('#save').isEnabled()).toBe(false)
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck()
    fixtureState.saveFailure = 'agent-not-installed:kimi'
    await page.locator('#save').click()
    await expect.poll(() => page.locator('#saved').textContent()).toContain('install the selected')
    expect(await page.getByRole('checkbox', { name: 'Kimi Code', exact: true }).isChecked()).toBe(true)
    expect(await page.locator('#save').isEnabled()).toBe(true)
    await page.locator('#reset').click()
    expect(await page.getByRole('checkbox', { name: 'Codex', exact: true }).isChecked()).toBe(true)
    expect(await page.locator('#save').isEnabled()).toBe(false)
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck()
    fail = true
    await page.locator('#check').click()
    await expect.poll(() => page.getByRole('alert').isVisible()).toBe(true)
    expect(await page.getByRole('alert').textContent()).not.toContain('private')
    expect(await page.locator('#check').isEnabled()).toBe(true)
    expect(await page.locator('#save').isEnabled()).toBe(true)
  } finally {
    await browser.close()
  }
})

it('does not overwrite preferences after an unreadable configuration', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const entries: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/loading/agents.json'), 'utf8'))
    const calls: string[] = []
    await page.exposeFunction('fixtureInvoke', (command: string) => {
      calls.push(command)
      if (command === 'desktop_agent_catalog') return entries
      throw new Error('private configuration detail')
    })
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    await page.setContent(await readFile(join(REPO_ROOT, 'apps/desktop/loading/extensions.html'), 'utf8'))
    await expect.poll(() => page.locator('#saved').textContent()).toContain('Could not load saved choices')
    expect(await page.locator('#save').isEnabled()).toBe(false)
    expect(await page.getByRole('checkbox', { name: 'Kimi Code', exact: true }).isEnabled()).toBe(false)
    expect(calls).toEqual(['desktop_agent_catalog', 'desktop_agent_preferences'])
    expect(await page.locator('main').textContent()).not.toContain('private configuration')
  } finally { await browser.close() }
})

it('preserves selected drafts during checks and reloads saved opt-outs', async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 580, height: 760 }, colorScheme: 'dark' })
    const entries: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/loading/agents.json'), 'utf8'))
    let preferences: Record<string, boolean> = { codex: true, kimi: true }
    const pending = Promise.withResolvers<unknown[]>()
    const calls: string[] = []
    await page.exposeFunction('fixtureInvoke', (command: string, args?: { value: Record<string, boolean> }) => {
      calls.push(command)
      if (command === 'desktop_agent_catalog') return entries
      if (command === 'desktop_agent_preferences') {
        if (args !== undefined) preferences = args.value
        return preferences
      }
      return pending.promise
    })
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    const html = await readFile(join(REPO_ROOT, 'apps/desktop/loading/extensions.html'), 'utf8')
    await page.setContent(html)
    await expect.poll(() => page.locator('#check').isEnabled()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'Codex', exact: true }).isChecked()).toBe(true)
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).uncheck()
    await page.locator('#check').click()
    await expect.poll(() => calls.at(-1)).toBe('desktop_local_agents')
    expect(await page.locator('#save').isEnabled()).toBe(false)
    expect(await page.locator('#reset').isEnabled()).toBe(false)
    expect(await page.getByRole('checkbox', { name: 'Kimi Code', exact: true }).isEnabled()).toBe(false)
    pending.resolve([{ id: 'codex', state: 'runnable', version: '0.149.1', executable: '/test/bin/codex',
      auth: 'authenticated', runtimeSource: 'bundled' }])
    await expect.poll(() => page.locator('#save').isEnabled()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'Codex', exact: true }).isChecked()).toBe(false)
    await page.locator('#category').selectOption('sdk')
    await page.locator('#save').click()
    await expect.poll(() => page.locator('#save').isEnabled()).toBe(false)
    expect(preferences).toEqual({ codex: false, claude: false, kimi: true, qoder: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.reload()
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    await page.setContent(html)
    await expect.poll(() => page.locator('#check').isEnabled()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'Codex', exact: true }).isChecked()).toBe(false)
    expect(await page.getByRole('checkbox', { name: 'Kimi Code', exact: true }).isChecked()).toBe(true)
    expect(await page.locator('#save').isEnabled()).toBe(false)
  } finally { await browser.close() }
})

it.each(['en-US'])('reviews a pinned Skill before installation and confirms removal (%s)', async (locale) => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale })
    const calls: { command: string; args: unknown }[] = []
    const entries = JSON.parse(await readFile(join(REPO_ROOT, 'apps/desktop/loading/skills.json'), 'utf8')) as Record<string, unknown>[]
    const fixture = { state: 'not-installed', failInstall: true }
    await page.exposeFunction('fixtureInvoke', (command: string, args?: { action: string }) => {
      calls.push({ command, args })
      if (command === 'desktop_agent_catalog') return []
      if (command === 'desktop_agent_preferences') return {}
      if (command === 'desktop_skill_catalog') return entries.map(entry => ({ ...entry, state: fixture.state }))
      if (args?.action === 'preview') return { state: fixture.state, content: { 'SKILL.md': 'Reviewed fixture <img src=x onerror=alert(1)>', 'LICENSE.txt': 'Fixture license', 'THIRD_PARTY_NOTICES.md': 'Fixture notices' } }
      if (args?.action === 'install') {
        if (fixture.failInstall) throw new Error('private network details')
        fixture.state = 'installed'
        return { state: fixture.state }
      }
      fixture.state = 'not-installed'
      return { state: fixture.state, recovery: '/test/home/desktop-skill-recovery/removed-123/frontend-design' }
    })
    await page.evaluate(() => {
      const invoke: unknown = Reflect.get(window, 'fixtureInvoke')
      Object.assign(window, { __TAURI__: { core: { invoke } } })
    })
    await page.setContent(await readFile(join(REPO_ROOT, 'apps/desktop/loading/extensions.html'), 'utf8'))
    await expect.poll(() => page.locator('#check').isEnabled()).toBe(true)
    expect(calls.map(call => call.command)).toEqual(['desktop_agent_catalog', 'desktop_agent_preferences'])
    await page.locator('#skills-tab').click()
    const card = page.getByRole('article', { name: 'Frontend Design', exact: true })
    await card.getByRole('button', { name: 'Review download', exact: true }).click()
    const consent = card.getByRole('checkbox')
    await consent.waitFor()
    const install = card.getByRole('button', { name: 'Install reviewed version', exact: true })
    expect(await install.isVisible()).toBe(false)
    expect(await card.locator('img').count()).toBe(0)
    await consent.check()
    const beforeNavigation = calls.slice()
    await page.evaluate(await readFile(join(REPO_ROOT, 'apps/desktop/loading/show-agents.js'), 'utf8'))
    expect(await page.locator('#agent-view').isVisible()).toBe(true)
    expect(await page.locator('#agents-tab').getAttribute('aria-pressed')).toBe('true')
    expect(calls).toEqual(beforeNavigation)
    await page.locator('#skills-tab').click()
    expect(await consent.isChecked()).toBe(true)
    expect(calls).toEqual(beforeNavigation)
    await expect(await page.locator('main').ariaSnapshot()).toMatchFileSnapshot(join(REPO_ROOT, `apps/web/tests/expected/desktop-skills.${locale}.aria.txt`))
    await install.click()
    await expect.poll(() => card.getByRole('status').textContent()).toContain('Operation failed')
    expect(await card.textContent()).not.toContain('private network')
    expect(await consent.isChecked()).toBe(true)
    fixture.failInstall = false
    await install.click()
    const remove = card.getByRole('button', { name: 'Uninstall', exact: true })
    await remove.waitFor()
    assert(entries[0] !== undefined)
    expect(calls.at(-1)).toEqual({ command: 'desktop_skill_action', args: { id: entries[0].id, revision: entries[0].revision, action: 'install' } })
    expect(await card.getByRole('checkbox').count()).toBe(0)
    const count = calls.length
    await remove.click()
    await card.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(calls.length).toBe(count)
    await remove.click()
    await card.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await expect.poll(() => card.getByRole('status').textContent()).toContain('/desktop-skill-recovery/')
    expect(await remove.isVisible()).toBe(false)
    expect(fixture.state).toBe('not-installed')
    await page.locator('#skill-refresh').click()
    await expect.poll(() => page.locator('#skill-refresh').isEnabled()).toBe(true)
    expect(await card.getByRole('button', { name: 'Uninstall', exact: true }).isVisible()).toBe(false)
  } finally { await browser.close() }
})
