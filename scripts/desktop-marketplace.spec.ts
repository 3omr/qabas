/** Catalog publication owns only generated paths; pnpm itself is exercised by the packaged smoke. */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { parseCatalog } from '../packages/desktop/bundle-preparation/src/catalog.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-pack-'))
  roots.push(root)
  const script = join(root, 'apps/desktop/scripts/runtime-marketplace.mjs')
  const pkg = join(root, 'packages/desktop/focus-timer')
  const output = join(root, 'generated')
  const manager = join(root, 'manager.mjs')
  await mkdir(join(root, 'apps/desktop/scripts'), { recursive: true })
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await copyFile(new URL('../apps/desktop/scripts/runtime-marketplace.mjs', import.meta.url), script)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-focus-timer', version: '1.0.0', license: 'MIT' }))
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) await writeFile(join(pkg, file), 'built')
  for (const id of ['notification-controls', 'delegation-launcher']) {
    const directory = join(root, 'packages/desktop', id)
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/dsh-${id}`, version: '1.0.0', license: 'MIT' }))
    for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) await writeFile(join(directory, file), 'built')
  }
  const module = await import(pathToFileURL(script).href) as {
    prepareMarketplace: (output: string, node: string, manager: string, platform: string, arch: string) => Promise<void>
  }
  return { root, pkg, output, manager, prepare: () => module.prepareMarketplace(output, process.execPath, manager, 'darwin', 'arm64') }
}

const fakePack = `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
assert.equal(process.env.npm_config_ignore_scripts, 'true');
assert.equal(process.env.npm_config_manage_package_manager_versions, 'false');
assert.ok(process.argv.includes('--config.node-linker=hoisted'));
const output = process.argv[process.argv.indexOf('--pack-destination') + 1];
await writeFile(join(output, 'focus.tgz'), 'reviewed fixture bytes');
`

it('publishes exact artifact bytes before its catalog, reuses content identity, and keeps old catalog on failure', async () => {
  const b = await fixture()
  await writeFile(b.manager, fakePack)
  await b.prepare()
  const before = await readFile(join(b.output, 'catalog.json'))
  const reviewed = parseCatalog(before)
  for (const item of reviewed) {
    expect(item.details?.license).toBe('MIT')
    expect(item.details?.en.summary).not.toBe(item.details?.ar.summary)
    expect(item.details?.en.setup).toContain('After restarting')
  }
  const parsed = JSON.parse(before.toString()) as {
    entries: { id: string; artifact: { sha256: string; size: number; file: string }; platforms: string[]; harnessVersions: string[] }[]
  }
  expect(parsed.entries.map(entry => entry.id)).toEqual(['focus-timer', 'notification-controls', 'delegation-launcher'])
  const entry = parsed.entries[0]!
  const bytes = await readFile(join(b.output, entry.artifact.file))
  expect(entry.artifact.size).toBe(bytes.length)
  expect(entry.artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(entry.platforms).toEqual(['darwin-arm64'])
  expect(entry.harnessVersions).toEqual(['1.0.0'])
  await b.prepare()
  expect(await readFile(join(b.output, 'catalog.json'))).toEqual(before)
  await writeFile(b.manager, 'process.exitCode = 1')
  await expect(b.prepare()).rejects.toThrow('packaging failed')
  expect(await readFile(join(b.output, 'catalog.json'))).toEqual(before)
  expect((await readdir(b.output)).sort()).toEqual(['catalog.json', ...parsed.entries.map(item => item.artifact.file)].sort())
})

it('refuses a mismatched version or missing build before publishing a catalog', async () => {
  const b = await fixture()
  await writeFile(join(b.root, 'package.json'), '{"version":"2.0.0"}')
  await expect(b.prepare()).rejects.toThrow('reviewed Harness version')
  await writeFile(join(b.root, 'package.json'), '{"version":"1.0.0"}')
  const manifestPath = join(b.pkg, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  for (const license of [undefined, '', 1]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, license }))
    await expect(b.prepare()).rejects.toThrow('declare a Bundle license')
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(join(b.pkg, 'lib/client.js'), '')
  await expect(b.prepare()).rejects.toThrow('build output is empty')
  await rm(join(b.pkg, 'lib/client.js'))
  await expect(b.prepare()).rejects.toThrow()
  await expect(readFile(join(b.output, 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['notification-controls', 'delegation-launcher'])('keeps the catalog when %s fails identity or packaging checks', async (id) => {
  const b = await fixture()
  await writeFile(b.manager, fakePack)
  await b.prepare()
  const before = await readFile(join(b.output, 'catalog.json'))
  const manifest = join(b.root, 'packages/desktop', id, 'package.json')
  const original = await readFile(manifest)
  await writeFile(manifest, JSON.stringify({ name: '@unexpected/package', version: '1.0.0' }))
  await expect(b.prepare()).rejects.toThrow('reviewed Harness version')
  expect(await readFile(join(b.output, 'catalog.json'))).toEqual(before)
  await writeFile(manifest, original)
  await writeFile(b.manager, `if (process.cwd().endsWith('${id}')) process.exit(1);\n${fakePack}`)
  await expect(b.prepare()).rejects.toThrow('packaging failed')
  expect(await readFile(join(b.output, 'catalog.json'))).toEqual(before)
  expect((await readdir(b.output)).some(file => file.startsWith('.'))).toBe(false)
})

it.each([0, 2])('rejects a pack result with %s archives and cleans private staging', async (count) => {
  const b = await fixture()
  await writeFile(b.manager, `import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const output = process.argv[process.argv.indexOf('--pack-destination') + 1];
for (let i = 0; i < ${count}; i++) await writeFile(join(output, i + '.tgz'), 'fixture');`)
  await expect(b.prepare()).rejects.toThrow('one tarball')
  expect(await readdir(b.output)).toEqual([])
})
