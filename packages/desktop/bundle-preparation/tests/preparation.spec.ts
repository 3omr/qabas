/** Reviewed-byte preparation uses private temporary roots and real Cordis disposal. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BundlePreparation, { type BundleCatalogId, type Config } from '../src/index.ts'
import { parseCatalog } from '../src/catalog.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, open: vi.fn(real.open), writeFile: vi.fn(real.writeFile) }
})
const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.mocked(open).mockReset().mockImplementation(realFs.open)
  vi.mocked(writeFile).mockReset().mockImplementation(realFs.writeFile)
})
const bytes = Buffer.from('reviewed fixture bytes')
const entry = {
  id: 'example', packageName: '@example/plugin', version: '1.0.0', title: 'Example',
  publisher: 'Example', source: 'https://example.com/plugin', details: null, harnessVersions: ['fixture-host'],
  platforms: [`${process.platform}-${process.arch}`],
  artifact: { file: 'example.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
}
function catalog(entries: unknown[] = [entry]): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, entries }))
}
async function fixture(overrides: Partial<Config> = {}, records: Buffer = catalog()) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bundle-preparation-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = BundlePreparation.Config({
    catalogFile: join(root, 'catalog.json'), artifactDirectory: join(root, 'artifacts'),
    stagingDirectory: join(root, 'staged'), hostVersion: 'fixture-host',
    maxCatalogBytes: 1024 * 1024, maxArtifactBytes: 50 * 1024 * 1024, ...overrides,
  })
  await mkdir(config.artifactDirectory)
  await writeFile(config.catalogFile, records)
  await writeFile(join(config.artifactDirectory, entry.artifact.file), bytes)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  return { root, config, ctx, mount: () => ctx.plugin(BundlePreparation, config) }
}

describe('review catalog', () => {
  it('preserves complete bilingual guidance as inert data and rejects partial or undeclared fields', async () => {
    const guide = { summary: '<script>text only</script>', accounts: 'No account', access: 'Local settings', setup: 'Open the panel' }
    const details = { license: 'MIT', en: guide, ar: { summary: 'الغرض', accounts: 'من غير حساب', access: 'إعدادات محلية', setup: 'افتح اللوحة' } }
    const record = { ...entry, details }
    expect(parseCatalog(catalog([record]))).toEqual([record])
    for (const invalid of [undefined, {}, { ...details, en: null }, { ...details, ar: undefined },
      { ...details, license: ' ' }, { ...details, en: { ...guide, access: '' } },
      { ...details, en: { ...guide, execute: 'command' } }, { ...details, grantPermissions: true }]) {
      expect(() => parseCatalog(catalog([{ ...entry, details: invalid }]))).toThrow()
    }
    const f = await fixture({}, catalog([{ ...entry, details: { ...details, ar: undefined } }]))
    await expect(f.mount().await()).rejects.toThrow()
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('parses review records without interpreting their bytes as executable packages', () => {
    expect(parseCatalog(catalog())).toEqual([entry])
    expect(parseCatalog(catalog([]))).toEqual([])
  })
  it.each([
    { ...entry, id: '../escape' },
    { ...entry, packageName: 'file:../escape' },
    { ...entry, source: 'http://example.com' },
    { ...entry, source: 'https://user:secret@example.com' },
    { ...entry, harnessVersions: [] },
    { ...entry, platforms: ['unknown'] },
    { ...entry, artifact: { ...entry.artifact, file: '../escape.tgz' } },
    { ...entry, artifact: { ...entry.artifact, file: 'folder\\escape.tgz' } },
    { ...entry, artifact: { ...entry.artifact, size: 0 } },
    { ...entry, artifact: { ...entry.artifact, sha256: 'bad' } },
    { ...entry, unexpected: true },
  ])('rejects invalid review metadata %#', (record) => {
    expect(() => parseCatalog(catalog([record]))).toThrow()
  })
  it('rejects duplicates, unsupported formats and malformed UTF-8/JSON', () => {
    expect(() => parseCatalog(catalog([entry, { ...entry, artifact: { ...entry.artifact, file: 'other.tgz' } }]))).toThrow('duplicate id')
    expect(() => parseCatalog(catalog([entry, { ...entry, id: 'other' }]))).toThrow('duplicate artifact')
    expect(() => parseCatalog(Buffer.from('{'))).toThrow()
    expect(() => parseCatalog(Buffer.from([0xff]))).toThrow()
    expect(() => parseCatalog(Buffer.from('{"schemaVersion":2,"entries":[]}'))).toThrow()
  })
})

describe('Bundle preparation', () => {
  it('requires configured history and rejects history reads after disposal', async () => {
    const f = await fixture()
    const fiber = await f.mount()
    const service = f.ctx.bundlePreparation
    await expect(service.listOperations()).rejects.toThrow('not configured')
    await expect(service.profileBundles('web' as never)).rejects.toThrow('not configured')
    await fiber.dispose()
    await expect(service.listOperations()).rejects.toThrow('disposed')
    await expect(service.profileBundles('web' as never)).rejects.toThrow('disposed')
  })
  it('keeps successful and failed observations across service recreation without activating a Profile', async () => {
    const f = await fixture()
    f.config.journal = { directory: join(f.root, 'history'), maxEntries: 100, maxRecordBytes: 65_536 }
    const fiber = await f.mount()
    const service = f.ctx.bundlePreparation
    expect(await service.listOperations()).toEqual([])
    await expect(service.prepare('unknown' as BundleCatalogId)).rejects.toThrow('unknown')
    expect(await service.listOperations()).toEqual([])
    const prepared = await service.prepare(entry.id as BundleCatalogId)
    await writeFile(join(f.config.artifactDirectory, entry.artifact.file), 'altered')
    await expect(service.prepare(entry.id as BundleCatalogId)).rejects.toThrow('does not match')
    const before = await service.listOperations()
    expect(before.map(item => item.state).sort()).toEqual(['failed', 'prepared'])
    expect(before.find(item => item.state === 'prepared')).toMatchObject({ kind: 'artifact', preparedState: 'prepared-not-enabled' })
    await fiber.dispose()
    await f.mount()
    expect(await f.ctx.bundlePreparation.listOperations()).toEqual(before)
    expect(await readFile(prepared.artifactPath)).toEqual(bytes)
    await expect(readdir(join(f.root, 'profiles'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('only identifies its own active operation while another live service reports it unsettled', async () => {
    const f = await fixture()
    f.config.journal = { directory: join(f.root, 'history'), maxEntries: 100, maxRecordBytes: 65_536 }
    await f.mount()
    const observer = new Context()
    cleanups.push(() => observer.fiber.dispose())
    await observer.plugin(BundlePreparation, f.config)
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      await realFs.writeFile(path, data, options)
      if (typeof path === 'string' && path.endsWith('prepared.json')) { reached.resolve(undefined); await release.promise }
    })
    const pending = f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)
    try {
      await reached.promise
      expect(await f.ctx.bundlePreparation.listOperations()).toMatchObject([{ state: 'preparing' }])
      expect(await observer.bundlePreparation.listOperations()).toMatchObject([{ state: 'unsettled' }])
    } finally { release.resolve(undefined); await pending }
    expect(await observer.bundlePreparation.listOperations()).toMatchObject([{ state: 'prepared' }])
  })
  it('rejects relative and overlapping journal directories', async () => {
    const f = await fixture()
    for (const directory of ['relative', f.config.stagingDirectory, join(f.config.stagingDirectory, 'history'), f.root]) {
      await expect(f.ctx.plugin(BundlePreparation, { ...f.config,
        journal: { directory, maxEntries: 100, maxRecordBytes: 65_536 },
      })).rejects.toThrow(directory === 'relative' ? 'absolute' : 'overlap')
    }
  })
  it('records exact reviewed bytes without mutating a profile or Session, and removes its service on disposal', async () => {
    const f = await fixture()
    const profile = join(f.root, 'package.json')
    const session = join(f.root, 'session.v2.jsonl')
    await writeFile(profile, '{"dsh":{"profile":{"bundles":[]}}}\n')
    await writeFile(session, 'session sentinel\n')
    const before = await Promise.all([readFile(profile), readFile(session)])
    const fiber = await f.mount()
    const service = f.ctx.bundlePreparation
    expect(service.list().map(({ entry, issues }) => ({ entry, issues }))).toEqual([{ entry, issues: [] }])
    expect(service.list()[0]!.reviewToken).toMatch(/^[a-f0-9]{64}$/)
    const receipt = await service.prepare(service.list()[0]!.entry.id)
    expect(receipt.state).toBe('prepared-not-enabled')
    expect(await readFile(receipt.artifactPath)).toEqual(bytes)
    expect(JSON.parse(await readFile(receipt.receiptPath, 'utf8'))).toEqual(receipt)
    expect(await Promise.all([readFile(profile), readFile(session)])).toEqual(before)
    await fiber.dispose()
    expect(f.ctx.get('bundlePreparation')).toBeUndefined()
    await expect(service.prepare(entry.id as BundleCatalogId)).rejects.toThrow('disposed')
    expect(await readFile(receipt.artifactPath)).toEqual(bytes)
  })
  it('reports every mismatch and refuses preparation before reading the artifact', async () => {
    const f = await fixture({ hostVersion: 'other-host', maxArtifactBytes: 1 })
    // Select a declared platform different from this host without mutating process.platform.
    const otherPlatform = process.platform === 'linux' && process.arch === 'x64' ? 'darwin-arm64' : 'linux-x64'
    await writeFile(f.config.catalogFile, catalog([{ ...entry, platforms: [otherPlatform] }]))
    await rm(join(f.config.artifactDirectory, entry.artifact.file))
    await f.mount()
    expect(f.ctx.bundlePreparation.list()[0]?.issues).toEqual(['harness-version', 'platform', 'artifact-size'])
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow('incompatible')
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([Buffer.from('wrong'), Buffer.alloc(bytes.length, 1), Buffer.alloc(bytes.length + 1)])('rejects altered/oversized bytes %# before creating staging', async (replacement) => {
    const f = await fixture()
    await f.mount()
    await writeFile(join(f.config.artifactDirectory, entry.artifact.file), replacement)
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow()
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects unknown entries and overlapping operations; a later attempt gets its own directory', async () => {
    const f = await fixture()
    await f.mount()
    const service = f.ctx.bundlePreparation
    await expect(service.prepare('unknown' as BundleCatalogId)).rejects.toThrow('unknown')
    const first = service.prepare(entry.id as BundleCatalogId)
    await expect(service.prepare(entry.id as BundleCatalogId)).rejects.toThrow('in progress')
    const result = await first
    const next = await service.prepare(entry.id as BundleCatalogId)
    expect(result.artifactPath).not.toBe(next.artifactPath)
  })
  it('drains an in-flight read during disposal without publishing a preparation', async () => {
    const f = await fixture()
    const fiber = await f.mount()
    const running = f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)
    const rejected = expect(running).rejects.toThrow('disposed')
    await fiber.dispose()
    await rejected
    await expect(readdir(f.config.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a non-file artifact and a catalog over its complete byte cap', async () => {
    const f = await fixture()
    await f.mount()
    const artifact = join(f.config.artifactDirectory, entry.artifact.file)
    await rm(artifact)
    await mkdir(artifact)
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow('regular file')
    const tooSmall = await fixture({ maxCatalogBytes: 1 })
    await expect(tooSmall.mount()).rejects.toThrow('byte limit')
  })
  it.skipIf(process.platform === 'win32')('rejects symbolic-link artifacts (POSIX symlink creation)', async () => {
    const f = await fixture()
    await f.mount()
    const artifact = join(f.config.artifactDirectory, entry.artifact.file)
    await rm(artifact)
    await symlink(f.config.catalogFile, artifact)
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow('regular file')
  })
  it('requires absolute deployment paths', async () => {
    const f = await fixture()
    await expect(f.ctx.plugin(BundlePreparation, { ...f.config, stagingDirectory: 'relative' })).rejects.toThrow('absolute')
  })
  it('rejects a file replaced by a non-file between inspection and opening', async () => {
    const f = await fixture()
    await f.mount()
    const handle = await realFs.open(join(f.config.artifactDirectory, entry.artifact.file), 'r')
    const changed = vi.spyOn(handle, 'stat').mockResolvedValue(await stat(f.config.artifactDirectory))
    vi.mocked(open).mockResolvedValueOnce(handle)
    try {
      await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow('regular file')
      await expect(handle.read(Buffer.alloc(1))).rejects.toThrow('closed')
    } finally { changed.mockRestore(); await handle.close() }
  })
  it('cleans only its operation directory after a write failure and permits retry', async () => {
    const f = await fixture()
    await f.mount()
    await mkdir(f.config.stagingDirectory)
    const keep = join(f.config.stagingDirectory, 'existing-receipt.json')
    await writeFile(keep, 'keep')
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'))
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).rejects.toThrow('disk full')
    expect(await readdir(f.config.stagingDirectory)).toEqual(['existing-receipt.json'])
    expect(await readFile(keep, 'utf8')).toBe('keep')
    await expect(f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)).resolves.toMatchObject({ state: 'prepared-not-enabled' })
  })
  it('waits for a pending receipt write on disposal, then removes the uncommitted directory', async () => {
    const f = await fixture()
    const fiber = await f.mount()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    // The barrier places disposal after the receipt write, not after a scheduler delay.
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      await realFs.writeFile(path, data, options)
      if (typeof path === 'string' && path.endsWith('prepared.json')) { reached.resolve(undefined); await release.promise }
    })
    const running = f.ctx.bundlePreparation.prepare(entry.id as BundleCatalogId)
    const rejected = expect(running).rejects.toThrow('disposed')
    await reached.promise
    let settled = false
    const disposal = fiber.dispose().then(() => { settled = true })
    try { expect(settled).toBe(false) } finally { release.resolve(undefined) }
    await disposal
    await rejected
    expect(await readdir(f.config.stagingDirectory)).toEqual([])
  })
})
