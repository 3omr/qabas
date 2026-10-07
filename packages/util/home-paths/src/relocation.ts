/** Exclusive, original-preserving copies for app storage root changes. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, link, copyFile, chmod } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalizeWatchPath } from './index.ts'

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function publish(source: string, destination: string, stagingRoot: string): Promise<void> {
  const temporary = await mkdtemp(join(stagingRoot, '.qabas-relocate-'))
  const staged = join(temporary, 'data')
  try {
    await copyFile(source, staged)
    await chmod(staged, 0o600)
    const handle = await open(staged, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    try { await link(staged, destination) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await lstat(destination)
      if (!existing.isFile() || await digest(source) !== await digest(destination)) {
        throw new Error(`Storage relocation collision at "${destination}"; preserve both roots and resolve the conflicting file.`)
      }
    }
    await syncDirectory(dirname(destination))
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

/**
 * Copy regular files exclusively, preserving all source bytes and directory names.
 * A source-specific completion file prevents stale originals from being recopied
 * after destination writes. Missing sources are ignored; unequal existing files,
 * overlapping roots, symlink entries and special files fail without replacing originals.
 * Session-directory locks, root attachment staging and relocation records are excluded.
 * @param source - original storage root, retained after copying.
 * @param destination - new storage root.
 * @param lock - optional ownership of the supplied source/destination directories at one depth, held while copying descendants.
 * @returns completion after copied files and the completion record reach storage.
 */
export async function relocateDataDirectory(
  source: string,
  destination: string,
  lock?: (directory: string, depth: number, destinationDirectory: string) => Promise<(() => Promise<void>) | undefined>,
): Promise<void> {
  let original: string
  try { original = await realpath(source) } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const target = await canonicalizeWatchPath(resolve(destination))
  if (original === target) return
  const nested = (a: string, b: string): boolean => {
    const suffix = relative(a, b)
    return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix)
  }
  if (nested(original, target) || nested(target, original)) throw new Error('Storage relocation roots overlap.')
  const markerName = `.qabas-copy-${createHash('sha256').update(original).digest('hex')}.json`
  const marker = join(target, markerName)
  const markerBytes = JSON.stringify({ source: original }) + '\n'
  try {
    if ((await lstat(marker)).isFile() && await readFile(marker, 'utf8') === markerBytes) return
    throw new Error(`Storage relocation completion record is invalid: "${marker}".`)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const visit = async (from: string, to: string, depth: number): Promise<void> => {
    if (!(await lstat(from)).isDirectory() || relative(from, await realpath(from)) !== '') {
      throw new Error(`Storage relocation requires regular directories: "${from}".`)
    }
    await mkdir(to, { recursive: true, mode: 0o700 })
    if (!(await lstat(to)).isDirectory() || relative(to, await realpath(to)) !== '') {
      throw new Error(`Storage relocation requires regular directories: "${to}".`)
    }
    const release = await lock?.(from, depth, to)
    try {
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if (depth === 0 && entry.isDirectory() && entry.name === 'tmp'
          || depth === 2 && entry.isFile() && entry.name === 'session.lock'
          || depth === 0 && entry.isFile() && /^\.qabas-copy-[a-f0-9]{64}\.json$/.test(entry.name)
          || depth === 0 && entry.isDirectory() && /^\.qabas-relocate-[A-Za-z0-9]{6}$/.test(entry.name)) continue
        const path = join(from, entry.name)
        if (entry.isDirectory()) await visit(path, join(to, entry.name), depth + 1)
        else if (entry.isFile()) await publish(path, join(to, entry.name), target)
        else throw new Error(`Storage relocation requires regular files and directories: "${path}".`)
      }
      await syncDirectory(to)
    } finally { await release?.() }
  }
  await visit(original, target, 0)
  const temporary = await mkdtemp(join(target, '.qabas-relocate-'))
  try {
    const staged = join(temporary, 'complete')
    const handle = await open(staged, 'wx', 0o600)
    try { await handle.writeFile(markerBytes); await handle.sync() } finally { await handle.close() }
    await publish(staged, marker, target)
    let ancestor = target
    while (true) {
      await syncDirectory(ancestor)
      const parent = dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
