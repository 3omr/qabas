/** Archive rejection happens without extraction or package execution. */
import { gzipSync } from 'node:zlib'
import { Header, type HeaderData } from 'tar'
import { describe, expect, it } from 'vitest'
import { inspectArchive, portablePath } from '../src/archive.ts'
import type { InstallerConfig, ReviewedBundle } from '../src/types.ts'

const limits: InstallerConfig = { nodeExecutable: process.execPath, packageManagerEntry: '/fixture', packageManagerVersion: '11.7.0',
  timeoutMs: 1000, graceMs: 100, maxOutputBytes: 1024, maxExpandedBytes: 1024 * 1024, maxArchiveEntries: 100, maxManifestBytes: 4096 }
const review = { packageName: '@example/plugin', version: '1.0.0' } as ReviewedBundle
const manifest = JSON.stringify({ name: review.packageName, version: review.version, dsh: { bundle: { patch: './cordis.patch.yml' } } })

function archive(entries: (HeaderData & { body?: string })[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = new Header({ ...entry, size: body.length, mode: 0o600, type: entry.type ?? 'File' })
    const block = Buffer.alloc(512)
    header.encode(block)
    blocks.push(block, body, Buffer.alloc((512 - body.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const valid = [{ path: 'package/', type: 'Directory' as const }, { path: 'package/package.json', body: manifest }, { path: 'package/cordis.patch.yml', body: '[]' }]

describe('archive inspection', () => {
  it('accepts a complete Bundle and a contained patch without a dot prefix', async () => {
    await expect(inspectArchive(archive(valid), review, limits)).resolves.toBeUndefined()
    await expect(inspectArchive(archive(valid.map(entry => entry.path === 'package/package.json' ? { ...entry, body: manifest.replace('./cordis.patch.yml', 'cordis.patch.yml') } : entry)), review, limits)).resolves.toBeUndefined()
  })
  it.each(['../x', '/x', 'a\\b', 'C:x', 'x\0y', 'a//b', '.', 'CON.txt', 'aux', 'a.', 'b ', '<x', 'x>', 'x"', 'x|', 'x?', 'x*'])('rejects nonportable path %s', (path) => {
    expect(portablePath(path)).toBe(false)
  })
  it.each([
    { path: 'package/../escape' }, { path: 'outside' }, { path: 'package/PACKAGE.JSON' },
    { path: 'package/link', type: 'SymbolicLink' as const, linkpath: '/outside' },
  ])('rejects unsafe archive entries %#', async (extra) => {
    await expect(inspectArchive(archive([...valid, extra]), review, limits)).rejects.toThrow('unsupported')
  })
  it('rejects entry, expansion, and manifest budget overflow', async () => {
    await expect(inspectArchive(archive(valid), review, { ...limits, maxArchiveEntries: 1 })).rejects.toThrow('expansion limits')
    await expect(inspectArchive(archive(valid), review, { ...limits, maxExpandedBytes: 100 })).rejects.toThrow()
    await expect(inspectArchive(archive(valid), review, { ...limits, maxManifestBytes: 1 })).rejects.toThrow('manifest')
  })
  it('rejects malformed gzip, mismatched identity and missing or escaping patches', async () => {
    await expect(inspectArchive(Buffer.from('bad'), review, limits)).rejects.toThrow()
    await expect(inspectArchive(gzipSync(Buffer.from('not a tar')), review, limits)).rejects.toThrow()
    await expect(inspectArchive(archive(valid), { ...review, version: '2.0.0' }, limits)).rejects.toThrow('identity')
    await expect(inspectArchive(archive(valid.slice(0, 2)), review, limits)).rejects.toThrow('patch')
    const escaping = valid.map(entry => entry.path === 'package/package.json' ? { ...entry, body: manifest.replace('./cordis.patch.yml', '../outside') } : entry)
    await expect(inspectArchive(archive(escaping), review, limits)).rejects.toThrow('patch')
  })
})
