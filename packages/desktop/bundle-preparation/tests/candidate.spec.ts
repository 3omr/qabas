/** Real managed child processes pin isolated install failure and disposal behavior. */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { create } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { DesktopHost, type DesktopProfileCandidate, type DesktopProfileName, type DesktopProfileSelection } from '@deepseek-ai/dsh-desktop'
import BundlePreparation, { type BundleCatalogId, type CompositionConfig, type InstallerConfig } from '../src/index.ts'
import { installerEnvironment, runManaged } from '../src/installer.ts'
import { now, publication, remoteConfig, remoteEntry, signed } from './remote-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, cp: vi.fn(real.cp), lstat: vi.fn(real.lstat), stat: vi.fn(real.stat), writeFile: vi.fn(real.writeFile) }
})
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally {
    vi.unstubAllEnvs(); vi.restoreAllMocks()
    vi.mocked(cp).mockReset().mockImplementation(realFs.cp)
    vi.mocked(lstat).mockReset().mockImplementation(realFs.lstat)
    vi.mocked(stat).mockReset().mockImplementation(realFs.stat)
    vi.mocked(writeFile).mockReset().mockImplementation(realFs.writeFile)
  }
})
const id = 'example' as BundleCatalogId
const web = 'web' as DesktopProfileName

it.each([false, true])('reports child startup failure with cancellation=%s and joins drainage', async (cancelled) => {
  const f = await fixture()
  const abort = new AbortController()
  const providerFailure = new Error('bootstrap rejected')
  const cancellation = new Error('operation timed out')
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  const draining = Promise.withResolvers<undefined>()
  const drained = Promise.withResolvers<boolean>()
  const terminate = vi.fn()
  vi.spyOn(f.ctx.subprocess, 'spawn').mockReturnValue({
    stdin: undefined, stdout: undefined, stderr: undefined, collected: {},
    done: outcome.promise, terminate,
    waitForExit: () => { draining.resolve(undefined); return drained.promise },
  })
  let settled = false
  const result = runManaged(f.ctx.subprocess, f.config.installer, ['fixture.mjs'], f.root, {}, abort.signal, 'fixture')
    .then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
  try {
    if (cancelled) abort.abort(cancellation)
    outcome.reject(providerFailure)
    await draining.promise
    expect(terminate).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    drained.resolve(true)
    expect(await result).toBe(cancelled ? cancellation : providerFailure)
  } finally {
    outcome.reject(providerFailure)
    drained.resolve(true)
    await result
  }
})

async function fixture(mode = 'success', overrides: Partial<InstallerConfig> = {}, provider = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dependency-candidate-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const artifacts = join(root, 'artifacts')
  const pkg = join(root, 'package')
  await mkdir(artifacts)
  await mkdir(pkg)
  await mkdir(join(root, 'outside'))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@example/plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(pkg, 'cordis.patch.yml'), '[]')
  await create({ cwd: root, file: join(artifacts, 'example.tgz'), gzip: true, portable: true }, ['package'])
  const bytes = await readFile(join(artifacts, 'example.tgz'))
  const catalogFile = join(root, 'catalog.json')
  await writeFile(catalogFile, JSON.stringify({ schemaVersion: 1, entries: [{ id, packageName: '@example/plugin', version: '1.0.0',
    title: 'Example', publisher: 'Test', source: 'https://example.com', details: null, harnessVersions: ['fixture'], platforms: [`${process.platform}-${process.arch}`],
    artifact: { file: 'example.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  }] }))
  const manager = join(root, 'manager.mjs')
  await cp(fileURLToPath(new URL('./fixtures/manager.mjs', import.meta.url)), manager)
  const started = join(root, 'started.json')
  await writeFile(join(root, 'manager.json'), JSON.stringify({ mode, started, outside: join(root, 'outside') }))
  const installer: InstallerConfig = { nodeExecutable: process.execPath, packageManagerEntry: manager, packageManagerVersion: '11.7.0',
    timeoutMs: 30_000, graceMs: 1000, maxOutputBytes: 1024, maxExpandedBytes: 1024 * 1024,
    maxManifestBytes: 4096, maxArchiveEntries: 100, ...overrides }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  if (provider) await ctx.plugin(LocalSubprocess)
  const config = { catalogFile, artifactDirectory: artifacts, stagingDirectory: join(root, 'staged'), hostVersion: 'fixture',
    maxCatalogBytes: 1024 * 1024, maxArtifactBytes: 1024 * 1024, installer }
  const fiber = await ctx.plugin(BundlePreparation, config)
  return { root, ctx, fiber, config, bytes, started }
}

async function compositionFixture(overrides: Partial<CompositionConfig> = {}) {
  const f = await fixture()
  await f.fiber.dispose()
  const home = join(f.root, 'source-home')
  const profile = join(home, 'profiles/web')
  await mkdir(profile, { recursive: true })
  const manifest = { private: true, custom: 'preserved', dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'live' } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(home, 'session.v2.jsonl'), 'unchanged session\n')
  const composition = { harnessHome: home, profileName: 'web',
    dshEntry: fileURLToPath(new URL('./fixtures/dump.mjs', import.meta.url)),
    maxProfileBytes: 1024 * 1024, maxProfileEntries: 1000, ...overrides }
  const fiber = await f.ctx.plugin(BundlePreparation, { ...f.config, composition })
  return { ...f, fiber, home, profile: await realpath(profile), manifest, composition }
}

class TestDesktop extends DesktopHost {
  selection: DesktopProfileSelection = { schemaVersion: 1, activeProfile: 'web' as DesktopProfileName,
    previousProfile: null, pending: null, trial: null, lastFailure: null }
  status = () => Promise.resolve({ available: true as const })
  show = () => Promise.resolve()
  openLocalAgents = () => Promise.resolve()
  notify = () => Promise.resolve()
  setAutostart = () => Promise.resolve()
  profileSelection = () => Promise.resolve(this.selection)
  queueProfile = vi.fn<(candidate: DesktopProfileCandidate) => Promise<void>>().mockResolvedValue(undefined)
  cancelProfile = () => Promise.resolve()
  startNotebookLmAuth = () => Promise.reject(new Error('not used'))
  pollNotebookLmAuth = () => Promise.reject(new Error('not used'))
  writeNotebookLmAuth = () => Promise.reject(new Error('not used'))
  cancelNotebookLmAuth = () => Promise.resolve()
}

describe('native activation queue', () => {
  it('refuses native dispatch when signed consent expires during candidate preparation', async () => {
    const f = await compositionFixture()
    const entry = { ...f.ctx.bundlePreparation.list()[0]!.entry, details: remoteEntry.details }
    await f.fiber.dispose()
    const remote = remoteConfig(join(f.root, 'signed-cache.json'))
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await writeFile(remote.cacheFile, signed({ ...publication, catalog: { schemaVersion: 1, entries: [entry] } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (url !== 'https://example.com/bundles/example.tgz') throw new Error('Unexpected fixture request')
      return new Response(new Uint8Array(f.bytes))
    })
    await f.ctx.plugin(BundlePreparation, { ...f.config, composition: f.composition, remote })
    await f.ctx.plugin(TestDesktop)
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      await realFs.writeFile(path, data, options)
      if (typeof path === 'string' && path.endsWith('composition.json')) vi.mocked(Date.now).mockReturnValue(now + 120_000)
    })
    const token = f.ctx.bundlePreparation.list()[0]!.reviewToken
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, token)).rejects.toThrow('changed or expired')
    expect((f.ctx.desktop as TestDesktop).queueProfile).not.toHaveBeenCalled()
    expect(await readFile(join(f.profile, 'package.json'), 'utf8')).toBe(JSON.stringify(f.manifest))
  })

  async function oldBundle() {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const directory = join(f.profile, 'node_modules/@example/plugin')
    await mkdir(directory, { recursive: true })
    const packageFile = join(directory, 'package.json')
    const old = { name: '@example/plugin', version: '0.9.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }
    await writeFile(packageFile, JSON.stringify(old))
    await writeFile(join(directory, 'cordis.patch.yml'), '[]')
    await writeFile(join(directory, 'old.txt'), 'keep the original package')
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ ...f.manifest,
      dependencies: { '@example/plugin': '0.9.0' }, dsh: { profile: { bundles: ['@example/plugin'] } } }))
    return { ...f, packageFile, old, desktop: f.ctx.desktop as TestDesktop }
  }

  it('replaces only the confirmed old version and preserves original package bytes', async () => {
    const f = await oldBundle()
    const before = await readFile(f.packageFile)
    const queued = await f.ctx.bundlePreparation.queueActivation(id, web, '0.9.0', f.ctx.bundlePreparation.list()[0]!.reviewToken)
    expect(await f.ctx.bundlePreparation.profileBundles(queued.profile)).toEqual([
      { packageName: '@example/plugin', version: '1.0.0', removable: true },
    ])
    expect(await readFile(f.packageFile)).toEqual(before)
    expect(await readFile(join(dirname(f.packageFile), 'old.txt'), 'utf8')).toBe('keep the original package')
    await expect(readFile(join(f.home, 'profiles', queued.profile, 'node_modules/@example/plugin/old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([null, '0.8.0', '1.0.0'])('refuses a stale or duplicate version confirmation %s', async (version) => {
    const f = await oldBundle()
    const token = f.ctx.bundlePreparation.list()[0]!.reviewToken
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, version, token)).rejects.toThrow()
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
  })

  it('does not treat unreadable listed packages or a switched Profile as a new install', async () => {
    const f = await oldBundle()
    await writeFile(f.packageFile, '{}')
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('observed Bundle version changed')
    f.desktop.selection = { ...f.desktop.selection, activeProfile: 'other' as DesktopProfileName }
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, '0.9.0', f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('observed active Profile changed')
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
  })

  it.each(['copied', 'source'] as const)('rejects a version changed in the %s package during copying', async (target) => {
    const f = await oldBundle()
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      await realFs.cp(from, to, options)
      if (from === f.profile) {
        const packageFile = target === 'source' ? f.packageFile : join(String(to), 'node_modules/@example/plugin/package.json')
        await writeFile(packageFile, JSON.stringify({ ...f.old, version: '0.8.0' }))
      }
    })
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, '0.9.0', f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('observed Bundle version changed')
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })

  it('rechecks the source after receipt publication without discarding the prepared generation', async () => {
    const f = await oldBundle()
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      await realFs.writeFile(path, data, options)
      if (typeof path === 'string' && path.endsWith('composition.json')) {
        await realFs.writeFile(f.packageFile, JSON.stringify({ ...f.old, version: '0.8.0' }))
      }
    })
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, '0.9.0', f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('observed Bundle version changed')
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect(await readdir(join(f.home, 'profiles'))).toHaveLength(2)
    expect(JSON.parse(await readFile(f.packageFile, 'utf8'))).toMatchObject({ version: '0.8.0' })
  })

  it('refuses installation-owned Bundle shadowing without queueing or changing the source', async () => {
    const f = await compositionFixture()
    await f.fiber.dispose()
    const installation = join(f.root, 'installation')
    const dshEntry = join(installation, 'dsh/lib/bin.js')
    await mkdir(dirname(dshEntry), { recursive: true })
    await cp(f.composition.dshEntry, dshEntry)
    const bundled = join(installation, 'node_modules/@example/plugin')
    await mkdir(bundled, { recursive: true })
    const bundledManifest = JSON.stringify({ name: '@example/plugin', version: '0.9.0' })
    await writeFile(join(bundled, 'package.json'), bundledManifest)
    await f.ctx.plugin(BundlePreparation, { ...f.config, composition: { ...f.composition, dshEntry } })
    await f.ctx.plugin(TestDesktop)
    const before = await readFile(join(f.profile, 'package.json'))
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('installation-owned Bundle shadows')
    expect((f.ctx.desktop as TestDesktop).queueProfile).not.toHaveBeenCalled()
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
    expect(await readFile(join(f.profile, 'package.json'))).toEqual(before)
    expect(await readFile(join(bundled, 'package.json'), 'utf8')).toBe(bundledManifest)
  })

  it('rejects a redirected Profiles root without creating a generation there', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const redirected = join(f.root, 'redirected-profiles')
    await realFs.rename(join(f.home, 'profiles'), redirected)
    await symlink(redirected, join(f.home, 'profiles'), 'junction')
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('Profiles root must be a real directory')
    expect(await readdir(redirected)).toEqual(['web'])
  })

  it('cleans an unqueued generation when its composition receipt cannot be written', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      if (typeof path === 'string' && path.endsWith('composition.json')) throw new Error('receipt write denied')
      return realFs.writeFile(path, data, options)
    })
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('receipt write denied')
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
    expect((f.ctx.desktop as TestDesktop).queueProfile).not.toHaveBeenCalled()
  })

  it('holds the operation reservation and drains native dispatch during disposal', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const desktop = f.ctx.desktop as TestDesktop
    desktop.queueProfile.mockImplementation(() => { entered.resolve(undefined); return release.promise })
    const pending = f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)
    let disposal: Promise<unknown> | undefined
    try {
      await entered.promise
      await expect(f.ctx.bundlePreparation.prepare(id)).rejects.toThrow('in progress')
      let settled = false
      disposal = f.fiber.dispose().then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve(undefined)
      const queued = await pending
      await disposal
      expect((await stat(join(f.home, 'profiles', queued.profile, 'package.json'))).isFile()).toBe(true)
    } finally { release.resolve(undefined); await pending; await disposal }
  })

  it('prepares into the original home, preserves source files and queues exact manifest bytes', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const desktop = f.ctx.desktop as TestDesktop
    await writeFile(join(f.home, 'cordis.patch.yml'), '[]\n')
    const before = await readFile(join(f.profile, 'package.json'))
    const queued = await f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)
    expect(queued.previousProfile).toBe('web')
    expect(await f.ctx.bundlePreparation.profileBundles(queued.profile)).toEqual([{ packageName: '@example/plugin', version: '1.0.0', removable: true }])
    expect(queued.profile).toMatch(/^desktop-[a-f0-9-]{36}$/u)
    const directory = join(f.home, 'profiles', queued.profile)
    expect(queued.manifestSha256).toBe(createHash('sha256').update(await readFile(join(directory, 'package.json'))).digest('hex'))
    expect(desktop.queueProfile).toHaveBeenCalledExactlyOnceWith(queued)
    expect(await readFile(join(f.profile, 'package.json'))).toEqual(before)
    expect(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(await readFile(join(f.home, 'session.v2.jsonl'), 'utf8')).toBe('unchanged session\n')
    expect(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))).toMatchObject({ custom: 'preserved' })
  })

  it('uses the current native predecessor rather than the deployment default Profile', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const desktop = f.ctx.desktop as TestDesktop
    const active = 'desktop-00000000-0000-4000-8000-000000000001' as DesktopProfileName
    const activeDirectory = join(f.home, 'profiles', active)
    await cp(f.profile, activeDirectory, { recursive: true })
    await writeFile(join(activeDirectory, 'package.json'), JSON.stringify({ ...f.manifest, custom: 'active generation' }))
    desktop.selection = { ...desktop.selection, activeProfile: active }
    const queued = await f.ctx.bundlePreparation.queueActivation(id, active, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)
    expect(queued.previousProfile).toBe(active)
    expect(JSON.parse(await readFile(join(f.home, 'profiles', queued.profile, 'package.json'), 'utf8'))).toMatchObject({ custom: 'active generation' })
  })

  it('retains complete prepared files when the native queue reply is lost', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const desktop = f.ctx.desktop as TestDesktop
    desktop.queueProfile.mockRejectedValue(new Error('reply lost after queue commit'))
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('reply lost')
    const queued = desktop.queueProfile.mock.calls[0]![0]
    expect((await stat(join(f.home, 'profiles', queued.profile, 'package.json'))).isFile()).toBe(true)
    const staged = await readdir(f.config.stagingDirectory)
    expect(staged).toHaveLength(1)
    expect((await stat(join(f.config.stagingDirectory, staged[0]!, 'composition.json'))).isFile()).toBe(true)
  })

  it('rejects missing native support and an existing queued or trial selection', async () => {
    const missing = await fixture()
    await expect(missing.ctx.bundlePreparation.queueActivation(id, web, null, missing.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('composition is not configured')
    const f = await compositionFixture()
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('native desktop host')
    await f.ctx.plugin(TestDesktop)
    const desktop = f.ctx.desktop as TestDesktop
    const pending: DesktopProfileCandidate = { profile: 'desktop-00000000-0000-4000-8000-000000000001' as DesktopProfileName,
      previousProfile: 'web' as DesktopProfileName, manifestSha256: 'a'.repeat(64) }
    for (const phase of ['pending', 'trial'] as const) {
      desktop.selection = { ...desktop.selection, pending: null, trial: null, [phase]: pending }
      await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('pending or starting')
    }
    expect(desktop.queueProfile).not.toHaveBeenCalled()
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
  })

  it('removes its failed generated Profile without queueing it', async () => {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ ...f.manifest, failDump: true }))
    await expect(f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)).rejects.toThrow('Profile composition failed')
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
    expect((f.ctx.desktop as TestDesktop).queueProfile).not.toHaveBeenCalled()
  })
})

describe('native removal queue', () => {
  async function installed(journal = true, installer: Partial<InstallerConfig> = {}) {
    const f = await compositionFixture()
    await f.ctx.plugin(TestDesktop)
    const first = await f.ctx.bundlePreparation.queueActivation(id, web, null, f.ctx.bundlePreparation.list()[0]!.reviewToken)
    const desktop = f.ctx.desktop as TestDesktop
    desktop.selection = { ...desktop.selection, activeProfile: first.profile }
    const active = join(f.home, 'profiles', first.profile)
    const manifest = JSON.parse(await readFile(join(active, 'package.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(active, 'package.json'), JSON.stringify({ ...manifest, expectRemoved: true }))
    await f.fiber.dispose()
    const fiber = await f.ctx.plugin(BundlePreparation, { ...f.config,
      installer: { ...f.config.installer, ...installer }, composition: f.composition,
      journal: journal ? { directory: join(f.root, 'history'), maxEntries: 100, maxRecordBytes: 65_536 } : false })
    desktop.queueProfile.mockClear()
    return { ...f, fiber, desktop, first, active }
  }

  it.each([true, false])('queues a fresh removal composition and retains source packages and data (journal=%s)', async (journal) => {
    const f = await installed(journal)
    const before = await readFile(join(f.active, 'package.json'))
    const packageBefore = await readFile(join(f.active, 'node_modules/@example/plugin/package.json'))
    const queued = await f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')
    expect(f.desktop.queueProfile).toHaveBeenCalledExactlyOnceWith(queued)
    expect(queued.previousProfile).toBe(f.first.profile)
    const directory = join(f.home, 'profiles', queued.profile)
    const bytes = await readFile(join(directory, 'package.json'))
    expect(queued.manifestSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(JSON.parse(bytes.toString())).toMatchObject({ custom: 'preserved', dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } })
    await expect(lstat(join(directory, 'node_modules/@example/plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.active, 'package.json'))).toEqual(before)
    expect(await readFile(join(f.active, 'node_modules/@example/plugin/package.json'))).toEqual(packageBefore)
    expect(await readFile(join(f.home, 'session.v2.jsonl'), 'utf8')).toBe('unchanged session\n')
    if (journal) expect(await f.ctx.bundlePreparation.listOperations()).toMatchObject([{ kind: 'removal', state: 'prepared',
      removed: { packageName: '@example/plugin', version: '1.0.0' }, preparedState: 'removal-checked-not-enabled' }])
  })

  it('rejects stale selection, pending or trial startup, changed versions, absent packages and unsafe names', async () => {
    const f = await installed()
    for (const selection of [{ activeProfile: 'web' as DesktopProfileName }, { pending: f.first }, { trial: f.first }]) {
      f.desktop.selection = { ...f.desktop.selection, ...selection }
      await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('selection changed')
      f.desktop.selection = { ...f.desktop.selection, activeProfile: f.first.profile, pending: null, trial: null }
    }
    for (const [name, version] of [['@example/plugin', 'other'], ['missing', '1'], ['../escape', '1']]) {
      await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, name!, version!)).rejects.toThrow('observed version')
    }
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect((await readdir(join(f.home, 'profiles'))).sort()).toEqual([f.first.profile, 'web'].sort())
  })

  it('rejects a copied package changed during preparation and cleans only the new generation', async () => {
    const f = await installed()
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      await realFs.cp(from, to, options)
      if (from === await realpath(f.active)) await writeFile(join(String(to), 'node_modules/@example/plugin/package.json'), '{}')
    })
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('changed during')
    expect((await readdir(join(f.home, 'profiles'))).sort()).toEqual([f.first.profile, 'web'].sort())
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
  })

  it('cleans a completed removal when receipt publication fails', async () => {
    const f = await installed()
    vi.mocked(writeFile).mockImplementation(async (path, bytes, options) => {
      if (typeof path === 'string' && path.endsWith('removal.json')) throw new Error('receipt denied')
      return realFs.writeFile(path, bytes, options)
    })
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('receipt denied')
    expect((await readdir(join(f.home, 'profiles'))).sort()).toEqual([f.first.profile, 'web'].sort())
    expect(await f.ctx.bundlePreparation.listOperations()).toMatchObject([{ kind: 'removal', state: 'failed' }])
  })

  it('retains the removal candidate after an uncertain native commit', async () => {
    const f = await installed()
    f.desktop.queueProfile.mockRejectedValueOnce(new Error('reply lost'))
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('reply lost')
    const candidate = f.desktop.queueProfile.mock.calls[0]![0]
    expect(await f.ctx.bundlePreparation.profileBundles(candidate.profile)).toEqual([])
    expect(await f.ctx.bundlePreparation.listOperations()).toMatchObject([{ kind: 'removal', state: 'prepared' }])
  })

  it('holds one reservation through native dispatch and drains it before disposal', async () => {
    const f = await installed()
    const service = f.ctx.bundlePreparation
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.desktop.queueProfile.mockImplementation(() => { entered.resolve(undefined); return release.promise })
    const pending = f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')
    let disposal: Promise<unknown> | undefined
    try {
      await entered.promise
      await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('in progress')
      await expect(f.ctx.bundlePreparation.prepare(id)).rejects.toThrow('in progress')
      let disposed = false
      disposal = f.fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
    } finally { release.resolve(undefined); await pending; await disposal }
    await expect(service.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('disposed')
  })

  it('requires deployment configuration and both host services', async () => {
    const f = await fixture()
    await expect(f.ctx.bundlePreparation.queueRemoval('web' as DesktopProfileName, 'x', '1')).rejects.toThrow('configured composition')
    const c = await compositionFixture()
    await expect(c.ctx.bundlePreparation.queueRemoval('web' as DesktopProfileName, 'x', '1')).rejects.toThrow('providers')
  })

  it.each(['version', 'hang'])('rejects removal with a %s package manager and drains its children', async (mode) => {
    const f = await installed(true, { timeoutMs: 1000 })
    const managerPath = join(f.root, 'manager.json')
    const managerConfig = JSON.parse(await readFile(managerPath, 'utf8')) as Record<string, unknown>
    await writeFile(managerPath, JSON.stringify({ ...managerConfig, mode }))
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0'))
      .rejects.toThrow(mode === 'version' ? 'package manager version mismatch' : 'removal timed out')
    expect((await readdir(join(f.home, 'profiles'))).sort()).toEqual([f.first.profile, 'web'].sort())
    for (const result of spawn.mock.results) if (result.type === 'return') expect(await result.value.waitForExit()).toBe(true)
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
  })

  it('denies direct service removal when the listed package is not a direct Profile dependency', async () => {
    const f = await installed()
    const path = join(f.active, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...manifest, dependencies: {} }))
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('Profile-owned Bundle')
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ dsh: { profile: { bundles: ['@example/plugin'] } } })
  })

  it('denies removal of installation-owned code even when the Profile declares the same direct dependency', async () => {
    const f = await installed()
    const installation = join(f.root, 'installation')
    const bundled = join(installation, 'node_modules/@example/plugin')
    await mkdir(bundled, { recursive: true })
    await cp(join(f.active, 'node_modules/@example/plugin/package.json'), join(bundled, 'package.json'))
    await f.fiber.dispose()
    await f.ctx.plugin(BundlePreparation, { ...f.config, composition: { ...f.composition, dshEntry: join(installation, 'lib/bin.js') } })
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('Profile-owned Bundle')
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
    expect((await readdir(join(f.home, 'profiles'))).sort()).toEqual([f.first.profile, 'web'].sort())
    expect(JSON.parse(await readFile(join(bundled, 'package.json'), 'utf8'))).toMatchObject({ version: '1.0.0' })
  })

  it('preserves unrelated direct dependencies and refuses an invalid remaining composition', async () => {
    const f = await installed()
    const path = join(f.active, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { dependencies: Record<string, string> }
    await writeFile(path, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, other: '2.0.0' } }))
    const queued = await f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')
    expect(JSON.parse(await readFile(join(f.home, 'profiles', queued.profile, 'package.json'), 'utf8')))
      .toMatchObject({ dependencies: { other: '2.0.0' } })
    f.desktop.queueProfile.mockClear()
    await writeFile(path, JSON.stringify({ ...manifest, failDump: true }))
    const before = await readdir(join(f.home, 'profiles'))
    await expect(f.ctx.bundlePreparation.queueRemoval(f.first.profile, '@example/plugin', '1.0.0')).rejects.toThrow('Profile composition failed')
    expect(await readdir(join(f.home, 'profiles'))).toEqual(before)
    expect(f.desktop.queueProfile).not.toHaveBeenCalled()
  })
})

describe('candidate Profile composition', () => {
  it('keeps operation history outside the configured source Profile', async () => {
    const f = await compositionFixture()
    await f.fiber.dispose()
    for (const directory of [join(f.home, 'profiles/web'), join(f.home, 'profiles/web/history'), f.home]) {
      await expect(f.ctx.plugin(BundlePreparation, { ...f.config, composition: f.composition,
        journal: { directory, maxEntries: 100, maxRecordBytes: 65_536 },
      })).rejects.toThrow('overlap')
    }
    await f.ctx.plugin(BundlePreparation, { ...f.config, composition: f.composition,
      journal: { directory: join(f.root, 'history'), maxEntries: 100, maxRecordBytes: 65_536 },
    })
    await f.ctx.bundlePreparation.prepareComposition(id)
    expect(await f.ctx.bundlePreparation.listOperations()).toMatchObject([{ state: 'prepared', kind: 'composition' }])
  })
  it('copies configuration and dependencies without mutating or launching the source Profile', async () => {
    const f = await compositionFixture()
    const linked = join(f.root, 'existing-package')
    await mkdir(linked)
    await writeFile(join(linked, 'value.txt'), 'original')
    await mkdir(join(f.profile, 'node_modules'))
    await symlink(linked, join(f.profile, 'node_modules/existing'), 'junction')
    await writeFile(join(f.home, 'cordis.patch.yml'), '[]\n')
    const before = await readFile(join(f.profile, 'package.json'))
    const receipt = await f.ctx.bundlePreparation.prepareComposition(id)
    expect(receipt.state).toBe('composition-checked-not-enabled')
    expect(JSON.parse(await readFile(receipt.receiptPath, 'utf8'))).toEqual(receipt)
    expect(JSON.parse(await readFile(receipt.candidate.receiptPath, 'utf8'))).toEqual(receipt.candidate)
    expect(JSON.parse(await readFile(join(receipt.profileDirectory, 'package.json'), 'utf8'))).toMatchObject({
      custom: 'preserved', dsh: { profile: { bundles: ['@example/plugin'], patchReload: 'startup' } },
    })
    expect(await readFile(join(receipt.harnessHome, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(await readFile(receipt.dumpPath, 'utf8')).toBe('[]')
    expect((await lstat(join(receipt.profileDirectory, 'node_modules/existing'))).isSymbolicLink()).toBe(false)
    await writeFile(join(linked, 'value.txt'), 'later change')
    expect(await readFile(join(receipt.profileDirectory, 'node_modules/existing/value.txt'), 'utf8')).toBe('original')
    expect(await readFile(join(f.profile, 'package.json'))).toEqual(before)
    expect(await readFile(join(f.home, 'session.v2.jsonl'), 'utf8')).toBe('unchanged session\n')
    expect(await readdir(join(f.home, 'profiles'))).toEqual(['web'])
  })
  it('keeps bundle order and replaces only the copied package when upgrading', async () => {
    const f = await compositionFixture()
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@example/plugin', 'other'] } } }))
    await mkdir(join(f.profile, 'node_modules/@example/plugin'), { recursive: true })
    await writeFile(join(f.profile, 'node_modules/@example/plugin/old.txt'), 'retain in source')
    const receipt = await f.ctx.bundlePreparation.prepareComposition(id)
    expect(JSON.parse(await readFile(join(receipt.profileDirectory, 'package.json'), 'utf8')))
      .toMatchObject({ dsh: { profile: { bundles: ['@example/plugin', 'other'] } } })
    await expect(readFile(join(receipt.profileDirectory, 'node_modules/@example/plugin/old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(f.profile, 'node_modules/@example/plugin/old.txt'), 'utf8')).toBe('retain in source')
  })
  it('preserves internal package links so isolated-layout dependencies still resolve', async () => {
    const f = await compositionFixture()
    const stored = join(f.profile, 'node_modules/.store/first/node_modules')
    await mkdir(join(stored, 'first'), { recursive: true })
    await mkdir(join(stored, 'second'))
    await writeFile(join(stored, 'first/index.cjs'), "module.exports = require('second')\n")
    await writeFile(join(stored, 'second/index.js'), "module.exports = 'retained'\n")
    await symlink(join(stored, 'first'), join(f.profile, 'node_modules/first'), 'junction')
    const receipt = await f.ctx.bundlePreparation.prepareComposition(id)
    const original = await realpath(join(f.profile, 'node_modules/first'))
    const copied = await realpath(join(receipt.profileDirectory, 'node_modules/first'))
    expect(copied).not.toBe(original)
    expect(await readFile(join(dirname(copied), 'second/index.js'), 'utf8')).toContain('retained')
    await writeFile(join(stored, 'second/index.js'), "module.exports = 'source changed'\n")
    expect(createRequire(join(receipt.profileDirectory, 'package.json'))('first/index.cjs')).toBe('retained')
  })
  it.skipIf(process.platform === 'win32')('retargets internal file symlinks (POSIX file-link creation)', async () => {
    const f = await compositionFixture()
    await writeFile(join(f.profile, 'settings.txt'), 'retained')
    await symlink(join(f.profile, 'settings.txt'), join(f.profile, 'settings-link.txt'))
    const receipt = await f.ctx.bundlePreparation.prepareComposition(id)
    expect(await realpath(join(receipt.profileDirectory, 'settings-link.txt')))
      .toBe(await realpath(join(receipt.profileDirectory, 'settings.txt')))
  })
  it.each([{ maxProfileBytes: 1 }, { maxProfileEntries: 1 }])('cleans its candidate when the copy budget is exceeded %j', async (limit) => {
    const f = await compositionFixture(limit)
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('copy exceeds')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
    expect(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))).toEqual(f.manifest)
  })
  it('cleans a failed CLI composition without touching source configuration', async () => {
    const f = await compositionFixture()
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ ...f.manifest, failDump: true }))
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('Profile composition failed')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
    expect(JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'))).toMatchObject({ failDump: true })
  })
  it('rejects a dsh entry from a different Harness version', async () => {
    const f = await compositionFixture()
    await writeFile(join(f.profile, 'package.json'), JSON.stringify({ ...f.manifest, wrongVersion: true }))
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('Harness version mismatch')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
  it('rejects unconfigured composition, invalid deployment paths and missing source Profiles', async () => {
    const f = await fixture()
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('not configured')
    const configured = await compositionFixture({ profileName: 'missing' })
    await expect(configured.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow()
    await configured.fiber.dispose()
    await expect(configured.ctx.plugin(BundlePreparation, { ...configured.config,
      composition: { ...configured.composition, dshEntry: 'relative' } })).rejects.toThrow('absolute paths')
  })
  it('accepts a source manifest without dsh metadata and no user patch', async () => {
    const f = await compositionFixture()
    await writeFile(join(f.profile, 'package.json'), '{}')
    await rm(join(f.profile, 'cordis.patch.yml'))
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).resolves.toMatchObject({ state: 'composition-checked-not-enabled' })
  })
  it('rejects a missing source manifest and staging within the source Profile', async () => {
    const f = await compositionFixture()
    await rm(join(f.profile, 'package.json'))
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow()
    await f.fiber.dispose()
    await writeFile(join(f.profile, 'package.json'), '{}')
    await f.ctx.plugin(BundlePreparation, { ...f.config, composition: f.composition, stagingDirectory: join(f.profile, 'staged') })
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('outside the source')
  })
  it('refuses unreadable source configuration and unreadable replacement targets', async () => {
    const f = await compositionFixture()
    const blocked = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (args[0] === join(f.profile, 'package.json')) throw blocked
      return realFs.lstat(...args)
    })
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('permission denied')
    vi.mocked(lstat).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith(join('profiles', 'candidate', 'node_modules', '@example', 'plugin'))) throw blocked
      return realFs.lstat(...args)
    })
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('permission denied')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
  it('refuses special files during a Profile copy', async () => {
    const f = await compositionFixture()
    const ordinary = await realFs.stat(f.profile)
    vi.spyOn(ordinary, 'isFile').mockReturnValue(false)
    vi.spyOn(ordinary, 'isDirectory').mockReturnValue(false)
    vi.mocked(stat).mockResolvedValue(ordinary)
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('unsupported Profile file')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
  it('unlinks a replacement target changed to a link without deleting its destination', async () => {
    const f = await compositionFixture()
    const outside = join(f.root, 'retained')
    await mkdir(outside)
    await writeFile(join(outside, 'keep.txt'), 'keep')
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      await realFs.cp(from, to, options)
      if (from === f.profile) {
        await mkdir(join(String(to), 'node_modules/@example'), { recursive: true })
        await symlink(outside, join(String(to), 'node_modules/@example/plugin'), 'junction')
      }
    })
    await f.ctx.bundlePreparation.prepareComposition(id)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('rejects configuration edited while the copy is in flight', async () => {
    const f = await compositionFixture()
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      await realFs.cp(from, to, options)
      if (from === f.profile) await writeFile(join(f.home, 'cordis.patch.yml'), '[]\n')
    })
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('configuration changed')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
    expect(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  })
  it('checks the completed copy size when a file grows after inspection', async () => {
    const f = await compositionFixture({ maxProfileBytes: 4096 })
    await writeFile(join(f.profile, 'growing.txt'), 'small')
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      await realFs.cp(from, to, options)
      if (from === f.profile) await writeFile(join(String(to), 'growing.txt'), Buffer.alloc(8192))
    })
    await expect(f.ctx.bundlePreparation.prepareComposition(id)).rejects.toThrow('copy exceeds')
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
  it('drains a cancelled copy before cleaning its candidate', async () => {
    const f = await compositionFixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.mocked(cp).mockImplementation(async (from, to, options) => {
      if (from === f.profile) { reached.resolve(undefined); await release.promise }
      await realFs.cp(from, to, options)
    })
    const pending = f.ctx.bundlePreparation.prepareComposition(id)
    const rejected = expect(pending).rejects.toThrow('disposed')
    await reached.promise
    const disposal = f.fiber.dispose()
    release.resolve(undefined)
    await disposal
    await rejected
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
})

describe('offline dependency candidates', () => {
  it('publishes a distinct receipt without changing a Profile, Session, or another prepared artifact', async () => {
    const f = await fixture()
    vi.stubEnv('DSH_FAKE_SECRET', 'synthetic-test-value')
    vi.stubEnv('NODE_OPTIONS', '--require=/not-a-real-module')
    vi.stubEnv('FAKE_AMBIENT', 'must-not-reach-manager')
    const active = join(f.root, 'active-profile.json')
    const session = join(f.root, 'session.v2.jsonl')
    await writeFile(active, '{"bundles":[]}')
    await writeFile(session, 'untouched session')
    const before = await Promise.all([readFile(active), readFile(session)])
    const original = await f.ctx.bundlePreparation.prepare(id)
    const receipt = await f.ctx.bundlePreparation.prepareDependencies(id)
    expect(receipt.state).toBe('dependencies-prepared-not-enabled')
    expect(await readFile(receipt.prepared.artifactPath)).toEqual(f.bytes)
    expect(await readFile(original.artifactPath)).toEqual(f.bytes)
    expect(JSON.parse(await readFile(receipt.receiptPath, 'utf8'))).toEqual(receipt)
    expect(await readFile(receipt.lockfilePath, 'utf8')).toContain('lockfileVersion')
    expect(await Promise.all([readFile(active), readFile(session)])).toEqual(before)
    expect(await readFile(join(receipt.candidateDirectory, 'package.json'), 'utf8')).not.toContain('dsh.profile')
    await f.fiber.dispose()
    expect(await readFile(receipt.receiptPath, 'utf8')).toContain('dependencies-prepared-not-enabled')
  })
  it.each(['version', 'output', 'fail', 'identity', 'escape'])('removes failed candidate %s and retains earlier prepared bytes', async (mode) => {
    const f = await fixture(mode)
    const earlier = await f.ctx.bundlePreparation.prepare(id)
    await expect(f.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow()
    expect(await readFile(earlier.artifactPath)).toEqual(f.bytes)
    expect(await readdir(f.config.stagingDirectory)).toEqual([dirname(earlier.artifactPath).split(/[\\/]/u).at(-1)])
  })
  it('rejects missing installer configuration and absent subprocess provider', async () => {
    const f = await fixture('success', {}, false)
    await expect(f.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow('local subprocess')
    await f.fiber.dispose()
    await f.ctx.plugin(BundlePreparation, { ...f.config, installer: false })
    await expect(f.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow('not configured')
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects missing executables and bounds an unresponsive package manager', async () => {
    const missing = await fixture('success', { nodeExecutable: join(tmpdir(), 'dsh-nonexistent-node-executable') })
    await expect(missing.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow()
    expect(await readdir(missing.config.stagingDirectory)).toEqual([])
    const hanging = await fixture('hang', { timeoutMs: 1000 })
    await expect(hanging.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow('timed out')
    expect(await readdir(hanging.config.stagingDirectory)).toEqual([])
  })
  it('rejects concurrent requests and awaits the running process tree when disposed', async () => {
    const f = await fixture('hang')
    const spawn = vi.spyOn(f.ctx.subprocess, 'spawn')
    const running = f.ctx.bundlePreparation.prepareDependencies(id)
    const rejected = expect(running).rejects.toThrow('disposed')
    // Readiness includes the version probe and installer spawn, both bounded by the installer budget.
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(f.started, 'utf8')) as number[] }
      catch { return [] }
    }, { timeout: f.config.installer.timeoutMs }).toHaveLength(2)
    await expect(f.ctx.bundlePreparation.prepare(id)).rejects.toThrow('in progress')
    await f.fiber.dispose()
    await rejected
    for (const result of spawn.mock.results) {
      if (result.type === 'return') expect(await result.value.waitForExit()).toBe(true)
    }
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
  it('rejects a changed source before beginning a candidate and rejects relative installer paths', async () => {
    const f = await fixture()
    await writeFile(join(f.config.artifactDirectory, 'example.tgz'), 'changed')
    await expect(f.ctx.bundlePreparation.prepareDependencies(id)).rejects.toThrow()
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.fiber.dispose()
    await expect(f.ctx.plugin(BundlePreparation, { ...f.config, installer: { ...f.config.installer, packageManagerEntry: 'relative' } })).rejects.toThrow('absolute')
  })
  it('preserves only Windows OS paths while removing ordinary inherited configuration', () => {
    vi.stubEnv('SYSTEMROOT', 'synthetic-system-root')
    vi.stubEnv('FAKE_AMBIENT', 'synthetic-value')
    const env = installerEnvironment('/private-operation', '/packaged/node')
    expect(env.SYSTEMROOT).toBe('synthetic-system-root')
    expect(env.FAKE_AMBIENT).toBeUndefined()
    expect(env.HOME).toBe('/private-operation')
  })
})
