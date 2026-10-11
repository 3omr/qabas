/** Built optional Bundle through the real Web composition; only the external agent result is controlled. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-jobs'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, REPO_ROOT } from './support.ts'

it.each([
  { locale: 'en-US', title: 'Delegate task', provider: 'Agent provider', task: 'Task', send: 'Start delegation', close: 'Close',
    read: 'Read result', cancel: 'Cancel task', confirm: 'Confirm cancel', stopping: 'Stopping — waiting for cleanup', killed: 'Canceled' },
])('delegates a reviewed task in the built $locale UI and collects its owned job', async (copy) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-delegation-browser-'))
  const cleanups: (() => Promise<unknown>)[] = [() => rm(directory, { recursive: true, force: true })]
  try {
    const overlay = join(directory, 'delegation.cordis.yml')
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'delegation-launcher',
      name: pathToFileURL(join(REPO_ROOT, 'packages/desktop/delegation-launcher/lib/index.js')).href,
    }] }]))
    const scaffold = await launchWebScaffold({ extraOverlayPath: overlay,
      extraInstallAnchors: [join(REPO_ROOT, 'packages/desktop/delegation-launcher/package.json')] })
    cleanups.push(() => scaffold.close())
    const results: ReturnType<typeof Promise.withResolvers<SubagentResult>>[] = []
    const releases: ReturnType<typeof Promise.withResolvers<undefined>>[] = []
    cleanups.push(async () => { for (const release of releases) release.resolve(undefined) })
    const dispose = vi.fn()
    const start = vi.fn(async (request: ResolvedSubagentStartRequest) => {
      const result = Promise.withResolvers<SubagentResult>()
      const release = Promise.withResolvers<undefined>()
      results.push(result)
      releases.push(release)
      request.signal.addEventListener('abort', () => { result.resolve({ stopReason: 'aborted', output: [] }) }, { once: true })
      return { id: SessionId(`fixture-child-${results.length}`), localAgent: undefined, result: result.promise,
        dispose: async () => { dispose(); await release.promise } }
    })
    scaffold.ctx.subagents.registerProvider({ name: 'fixture', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, start })
    const browser = await chromium.launch()
    cleanups.push(() => browser.close())
    const page = await browser.newPage({ locale: copy.locale, viewport: { width: 1100, height: 800 } })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: copy.title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: copy.title, exact: true })
    await dialog.getByRole('combobox', { name: copy.provider }).selectOption('fixture')
    await dialog.getByRole('textbox', { name: copy.task }).fill('Inspect the fixture workspace')
    expect(start).not.toHaveBeenCalled()
    expect(await dialog.getByRole('button', { name: copy.send, exact: true }).isDisabled()).toBe(true)
    await dialog.getByRole('checkbox').check()
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/delegation-launcher.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-delegation-launcher]', scaffold.workspaceCwd), webSnapshotMode())
    const screenshotDirectory = process.env.DSH_DELEGATION_SCREENSHOT_DIR
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `delegation.${copy.locale}.png`) })
    await dialog.getByRole('button', { name: copy.send, exact: true }).click()
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    const request = start.mock.calls[0]![0]
    expect(request.prompt).toEqual([{ type: 'text', text: 'Inspect the fixture workspace' }])
    const parent = request.parent
    const jobs = scaffold.ctx.jobs.list(parent)
    expect(jobs).toHaveLength(1)
    // A real waiting consumer claims the result, so the completion reporter does not wake a parent model.
    const settled = scaffold.ctx.jobs.wait(jobs[0]!.id, 10_000, parent)
    results[0]!.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Fixture delegation result' }] })
    releases[0]!.resolve(undefined)
    expect((await settled).status).toBe('completed')
    await dialog.getByRole('button', { name: copy.read, exact: true }).click()
    await dialog.getByText('Fixture delegation result', { exact: true }).waitFor()
    expect(dispose).toHaveBeenCalledOnce()
    const events = parent.session.snapshotEvents()
    expect(events.find(event => event.type === 'command/run')).toMatchObject({ data: {
      name: 'delegate-task', args: ` ${JSON.stringify({ provider: 'fixture', task: 'Inspect the fixture workspace' })}`,
    } })
    expect(events.find(event => event.type === 'command/done')).toMatchObject({ data: { kind: 'success' } })
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
    await dialog.getByText(/Delegation queued as/).waitFor()
    await dialog.getByRole('textbox', { name: copy.task }).fill('Cancel the second fixture task')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('button', { name: copy.send, exact: true }).click()
    await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(2) })
    await dialog.getByRole('button', { name: copy.cancel, exact: true }).click()
    expect(start.mock.calls[1]![0].signal.aborted).toBe(false)
    await dialog.getByRole('button', { name: copy.confirm, exact: true }).click()
    await dialog.getByText(copy.stopping, { exact: true }).waitFor()
    expect(start.mock.calls[1]![0].signal.aborted).toBe(true)
    releases[1]!.resolve(undefined)
    await dialog.getByText(copy.killed, { exact: true }).waitFor()
    expect(dispose).toHaveBeenCalledTimes(2)
    await compareOrRefreshGolden(join(REPO_ROOT, `apps/web/tests/expected/delegation-tasks.${copy.locale}.aria.txt`),
      await captureStableAria(page, '[data-delegation-launcher]', scaffold.workspaceCwd), webSnapshotMode())
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `delegation-result.${copy.locale}.png`) })
    await page.setViewportSize({ width: 640, height: 480 })
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(480)
    for (const control of [dialog.getByRole('heading', { name: copy.title, exact: true }), dialog.getByRole('button', { name: copy.close, exact: true })]) {
      const bounds = await control.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.y).toBeGreaterThanOrEqual(box!.y)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(box!.y + box!.height)
    }
    if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `delegation-narrow.${copy.locale}.png`) })
    await dialog.getByRole('button', { name: copy.close, exact: true }).click()
  } finally {
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => failures.push(error))
    if (failures.length > 0) throw new AggregateError(failures, 'Delegation fixture cleanup failed')
  }
})
