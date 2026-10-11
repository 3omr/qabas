/** Publication checks own temporary bytes; malicious lifecycle code is never imported or installed. */
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { create } from 'tar'
import { afterEach, expect, it } from 'vitest'
import { verifyMarketplaceCatalog } from './verify-marketplace-catalog.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const limits = { maxCatalogBytes: 65536, maxArtifactBytes: 65536, maxExpandedBytes: 65536, maxArchiveEntries: 100, maxManifestBytes: 16384 }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-review-'))
  roots.push(root)
  const packageDir = join(root, 'package')
  await mkdir(packageDir)
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0',
    scripts: { postinstall: 'exit 99' }, dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(packageDir, 'cordis.patch.yml'), '[]\n')
  await create({ cwd: root, file: join(root, 'bundle.tgz'), gzip: true, portable: true }, ['package'])
  const bytes = await readFile(join(root, 'bundle.tgz'))
  const guide = { summary: 'Test', accounts: 'None', access: 'Host access', setup: 'Open the test' }
  const entry = { id: 'test', packageName: 'test-bundle', version: '1.0.0', title: 'Test', publisher: 'Tests', source: 'https://example.com/source',
    details: { license: 'MIT', en: guide, ar: guide }, harnessVersions: ['1.0.0'], platforms: ['darwin-arm64'],
    artifact: { file: 'bundle.tgz', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  const catalog = { schemaVersion: 1, entries: [entry] }
  const save = () => writeFile(join(root, 'catalog.json'), JSON.stringify(catalog))
  await save()
  return { root, entry, catalog, save }
}

it('verifies all artifacts without installing code or altering input files', async () => {
  const b = await fixture()
  const before = await readFile(join(b.root, 'catalog.json'))
  await expect(verifyMarketplaceCatalog(b.root, limits)).resolves.toBe(1)
  expect(await readFile(join(b.root, 'catalog.json'))).toEqual(before)
  expect((await readdir(b.root)).sort()).toEqual(['bundle.tgz', 'catalog.json', 'package'])
})

it.each(['empty', 'guidance', 'checksum', 'size', 'identity', 'missing', 'oversized', 'expansion'] as const)('rejects %s before publication', async (kind) => {
  const b = await fixture()
  if (kind === 'empty') b.catalog.entries = []
  if (kind === 'guidance') Object.assign(b.entry, { details: null })
  if (kind === 'checksum') b.entry.artifact.sha256 = '0'.repeat(64)
  if (kind === 'size') b.entry.artifact.size++
  if (kind === 'identity') b.entry.version = '2.0.0'
  if (kind === 'missing') await rm(join(b.root, 'bundle.tgz'))
  await b.save()
  await expect(verifyMarketplaceCatalog(b.root, { ...limits,
    ...(kind === 'oversized' ? { maxArtifactBytes: 1 } : {}),
    ...(kind === 'expansion' ? { maxExpandedBytes: 1 } : {}),
  })).rejects.toThrow()
})
