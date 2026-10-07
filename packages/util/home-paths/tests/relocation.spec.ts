/** Original-preserving, exclusive storage relocation. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relocateDataDirectory } from '../src/relocation.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'qabas-relocation-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('data relocation', () => {
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
