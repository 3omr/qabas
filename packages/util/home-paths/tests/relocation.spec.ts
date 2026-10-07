/** Original-preserving, exclusive storage relocation. */
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { relocateDataDirectory } from '../src/relocation.ts'

const fileSyncPolicy = vi.hoisted(() => ({ requiresWriteAccess: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (fileSyncPolicy.requiresWriteAccess && args[1] === 'r' && (await handle.stat()).isFile()) {
        vi.spyOn(handle, 'sync').mockRejectedValue(Object.assign(new Error('file flush requires write access'), { code: 'EPERM' }))
      }
      return handle
    },
  }
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'qabas-relocation-')) })
afterEach(async () => {
  fileSyncPolicy.requiresWriteAccess = false
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('data relocation', () => {
  it('publishes data and completion records when file flushing requires write access', async () => {
    fileSyncPolicy.requiresWriteAccess = true
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(source)
    const bytes = Buffer.from([0, 255, 13, 10])
    await writeFile(join(source, 'log'), bytes)
    await chmod(join(source, 'log'), 0o400)
    const originalMode = (await stat(join(source, 'log'))).mode
    const readOnly = await open(join(source, 'log'), 'r')
    try { await expect(readOnly.sync()).rejects.toMatchObject({ code: 'EPERM' }) } finally { await readOnly.close() }
    await relocateDataDirectory(source, destination)
    expect(await readFile(join(destination, 'log'))).toEqual(bytes)
    expect((await readdir(destination)).filter(name => name.startsWith('.qabas-copy-'))).toHaveLength(1)
    expect(await readFile(join(source, 'log'))).toEqual(bytes)
    expect((await stat(join(source, 'log'))).mode).toBe(originalMode)
    if (process.platform !== 'win32') expect((await stat(join(destination, 'log'))).mode & 0o777).toBe(0o600)
    await writeFile(join(destination, 'log'), 'later append')
    await relocateDataDirectory(source, destination)
    expect(await readFile(join(destination, 'log'), 'utf8')).toBe('later append')
  })

  it('copies exact bytes, accepts equal files and completes once without changing the source', async () => {
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    await mkdir(join(source, 'project'), { recursive: true })
    await mkdir(join(destination, 'project'), { recursive: true })
    const bytes = Buffer.from([0, 255, 13, 10])
    await writeFile(join(source, 'project', 'log'), bytes)
    await mkdir(join(source, 'project', '.qabas-relocate-abc123'))
    await writeFile(join(source, 'project', '.qabas-relocate-abc123', 'session.v1.jsonl'), bytes)
    await writeFile(join(source, 'project', 'session.v1.jsonl'), 'released generation\n')
    await writeFile(join(source, 'project', 'session.v2.jsonl.zstd'), bytes)
    await writeFile(join(destination, 'project', 'log'), bytes)
    await relocateDataDirectory(source, destination)
    expect(await readFile(join(destination, 'project', 'log'))).toEqual(bytes)
    expect(await readFile(join(destination, 'project', 'session.v1.jsonl'), 'utf8')).toBe('released generation\n')
    expect(await readFile(join(destination, 'project', 'session.v2.jsonl.zstd'))).toEqual(bytes)
    expect(await readFile(join(destination, 'project', '.qabas-relocate-abc123', 'session.v1.jsonl'))).toEqual(bytes)
    expect(await readFile(join(source, 'project', 'log'))).toEqual(bytes)
    await writeFile(join(destination, 'project', 'log'), 'later append')
    await relocateDataDirectory(source, destination)
    expect(await readFile(join(destination, 'project', 'log'), 'utf8')).toBe('later append')
  })

  it('refuses unequal collisions without replacing either file', async () => {
    await mkdir(join(root, 'source'))
    await mkdir(join(root, 'destination'))
    await writeFile(join(root, 'source', 'log'), 'original')
    await writeFile(join(root, 'destination', 'log'), 'different')
    await expect(relocateDataDirectory(join(root, 'source'), join(root, 'destination'))).rejects.toThrow('collision')
    expect(await readFile(join(root, 'source', 'log'), 'utf8')).toBe('original')
    expect(await readFile(join(root, 'destination', 'log'), 'utf8')).toBe('different')
  })

  it('refuses overlapping roots and symlink entries', async () => {
    const source = join(root, 'source')
    await mkdir(source)
    await expect(relocateDataDirectory(source, join(source, 'child'))).rejects.toThrow('overlap')
    await symlink(root, join(source, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(relocateDataDirectory(source, join(root, 'destination'))).rejects.toThrow('regular')
  })

  it('ignores an absent source without creating destination data', async () => {
    await relocateDataDirectory(join(root, 'absent'), join(root, 'destination'))
    await expect(readFile(join(root, 'destination', 'log'))).rejects.toHaveProperty('code', 'ENOENT')
  })
})
