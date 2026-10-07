/** Legacy storage relocation preserves physical generations and kernel writer exclusion. */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it } from 'vitest'
import JsonlSessionPersistence from '../src/index.ts'
import { logPath, sessionDir } from '../src/format.ts'
import { LEASE_FILENAME, SessionWriteLease } from '../src/lease.ts'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'qabas-session-relocation-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const backend = (path: string, migrateFrom?: string): JsonlSessionPersistence =>
  new JsonlSessionPersistence(new Context(), { root: path, compression: 'none', ...(migrateFrom === undefined ? {} : { migrateFrom }) })

it('opens a copied session with unchanged project metadata and exact generation bytes', async () => {
  const source = join(root, 'legacy')
  const destination = join(root, 'library')
  const header = meta('legacy-chat', join(root, 'old-project'))
  const old = backend(source)
  const writer = await old.create(header)
  await writer.append(oneTurnLog())
  await writer.close()
  const originalPath = logPath(source, header.cwd, header.id, 'none')
  const bytes = await readFile(originalPath)
  const moved = backend(destination, source)
  expect((await moved.list()).map(item => item.header.id)).toEqual([header.id])
  const reader = await moved.open(header.id, 'read')
  try {
    expect(reader.header).toEqual({ ...header, delegationDepth: 0 })
    expect((await reader.read()).events).toEqual(oneTurnLog())
  } finally { await reader.close() }
  expect(await readFile(logPath(destination, header.cwd, header.id, 'none'))).toEqual(bytes)
  expect(await readFile(originalPath)).toEqual(bytes)
})

it('refuses a live legacy writer and retries after its release', async () => {
  const source = join(root, 'legacy')
  const destination = join(root, 'library')
  const header = meta('busy-chat')
  const writer = await backend(source).create(header)
  await writer.append(oneTurnLog())
  await writer.flush()
  try { await expect(backend(destination, source).list()).rejects.toThrow('owned') }
  finally { await writer.close() }
  expect(await backend(destination, source).list()).toHaveLength(1)
})

it('refuses an active writer in an existing destination session', async () => {
  const source = join(root, 'legacy')
  const destination = join(root, 'library')
  const header = meta('destination-chat')
  const original = await backend(source).create(header)
  await original.append(oneTurnLog())
  await original.close()
  const target = await backend(destination).create(header)
  await target.append(oneTurnLog())
  await target.flush()
  try { await expect(backend(destination, source).list()).rejects.toThrow('owned') }
  finally { await target.close() }
  expect(await backend(destination, source).list()).toHaveLength(1)
})

it.skipIf(process.platform === 'win32').each(['source', 'destination'])(
  'refuses a %s lock symlink without changing its released generation target', async (side) => {
    const source = join(root, 'legacy')
    const destination = join(root, 'library')
    const header = meta('linked-lock')
    const writer = await backend(source).create(header)
    await writer.append(oneTurnLog())
    await writer.close()
    const originalPath = logPath(source, header.cwd, header.id, 'none')
    const bytes = await readFile(originalPath)
    const directory = sessionDir(side === 'source' ? source : destination, header.cwd, header.id)
    await mkdir(directory, { recursive: true })
    const lockPath = join(directory, LEASE_FILENAME)
    await rm(lockPath, { force: true })
    await symlink(originalPath, lockPath)

    await expect(SessionWriteLease.acquireForRelocation(directory, header.id)).rejects.toHaveProperty('code', 'ELOOP')
    await expect(backend(destination, source).list()).rejects.toThrow('regular lock files')
    expect(await readFile(originalPath)).toEqual(bytes)
  },
)

it.each(['project', 'session'])(
  'refuses a destination %s directory symlink before creating an outside lock', async (level) => {
    const source = join(root, 'legacy')
    const destination = join(root, 'library')
    const outside = join(root, 'outside')
    const header = meta('linked-directory')
    const writer = await backend(source).create(header)
    await writer.append(oneTurnLog())
    await writer.close()
    const originalPath = logPath(source, header.cwd, header.id, 'none')
    const bytes = await readFile(originalPath)
    const targetSession = sessionDir(destination, header.cwd, header.id)
    const linkedDirectory = level === 'session' ? targetSession : dirname(targetSession)
    await mkdir(dirname(linkedDirectory), { recursive: true })
    await mkdir(outside)
    await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(backend(destination, source).list()).rejects.toThrow('regular directories')
    expect(await readdir(outside)).toEqual([])
    expect(await readFile(originalPath)).toEqual(bytes)
  },
)
