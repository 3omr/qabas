/** Workspace-file containment, bounded reads, conflicts, and replacement failures. */

import * as disk from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, TranscriberEngine } from '../src/index.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof disk>() }))

let root: string
let workspace: string
let endpoint: TranscriberEngine
const signal = (): AbortSignal => new AbortController().signal

beforeEach(async () => {
  root = await disk.mkdtemp(join(tmpdir(), 'qabas-files-'))
  workspace = join(root, 'workspace')
  await disk.mkdir(join(workspace, 'Figures'), { recursive: true })
  await disk.writeFile(join(workspace, 'lecture.md'), 'أب')
  await disk.writeFile(join(workspace, 'Figures', 'page.png'), Buffer.from([1, 2, 3, 4]))
  await disk.writeFile(join(root, 'outside.md'), 'private')
  endpoint = new TranscriberEngine(new Context(), {
    environment: { TRANSCRIBER_WORKSPACE: workspace }, maxTextBytes: 4, maxImageBytes: 4,
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await disk.rm(root, { recursive: true, force: true })
})

describe('session-free workspace files', () => {
  it('reads exact-cap UTF-8 and related image bytes with matching stat versions', async () => {
    const text = await endpoint.readFile({ path: 'lecture.md' }, signal())
    expect(text).toMatchObject({ absolutePath: await disk.realpath(join(workspace, 'lecture.md')), text: 'أب' })
    expect(await endpoint.stat({ path: text.absolutePath })).toEqual({ absolutePath: text.absolutePath, version: text.version, bytes: 4 })
    const image = await endpoint.readFileBytes({ path: './Figures/page.png', relativeTo: 'lecture.md' }, signal())
    expect(image.bytes).toBe('AQIDBA==')
    expect(await endpoint.readFileBytes({ path: image.absolutePath }, signal())).toEqual(image)
    await expect(endpoint.readFile({ path: 'Figures/page.png' }, signal())).resolves.toMatchObject({ text: '\u0001\u0002\u0003\u0004' })
  })

  it.each(['readFile', 'readFileBytes', 'stat', 'writeFile'] as const)('rejects traversal, absolute escapes and outside symlinks for %s', async (method) => {
    await disk.symlink(join(root, 'outside.md'), join(workspace, 'escape.md'))
    await disk.symlink(root, join(workspace, 'escape-dir'), 'junction')
    for (const path of ['../outside.md', join(root, 'outside.md'), 'escape.md', 'escape-dir/outside.md', '../absent.md']) {
      await expect(endpoint[method]({ path, text: 'x', expectedVersion: 'stale' }, signal()))
        .rejects.toMatchObject({ code: 'transcriber-engine/path-outside-workspace' })
    }
  })

  it('confines the relativeTo file and resolves a symlinked workspace and inside target', async () => {
    await expect(endpoint.readFileBytes({ path: 'outside.md', relativeTo: '../outside.md' }, signal()))
      .rejects.toMatchObject({ code: 'transcriber-engine/path-outside-workspace' })
    await disk.symlink(workspace, join(root, 'workspace-link'), 'junction')
    await disk.symlink(join(workspace, 'lecture.md'), join(workspace, 'alias.md'))
    const linked = new TranscriberEngine(new Context(), { environment: { TRANSCRIBER_WORKSPACE: join(root, 'workspace-link') } })
    expect((await linked.readFile({ path: 'alias.md' }, signal())).absolutePath).toBe(await disk.realpath(join(workspace, 'lecture.md')))
    expect((await linked.readFile({ path: join(root, 'workspace-link', 'lecture.md') }, signal())).text).toBe('أب')
  })

  it('replaces an existing Markdown file atomically and rejects stale versions', async () => {
    const before = await endpoint.readFile({ path: 'lecture.md' }, signal())
    const saved = await endpoint.writeFile({ path: 'lecture.md', text: 'new', expectedVersion: before.version }, signal())
    expect(saved.version).not.toBe(before.version)
    expect(await endpoint.readFile({ path: 'lecture.md' }, signal())).toEqual({ ...saved, text: 'new' })
    await expect(endpoint.writeFile({ path: 'lecture.md', text: 'lost', expectedVersion: before.version }, signal()))
      .rejects.toMatchObject({ code: 'transcriber-engine/file-conflict', details: { expectedVersion: before.version, actualVersion: saved.version } })
    expect(await disk.readdir(workspace)).toEqual(['Figures', 'lecture.md'])
  })

  it('allows only one simultaneous write using the same observed version', async () => {
    const { version } = await endpoint.stat({ path: 'lecture.md' })
    const results = await Promise.allSettled(['one', 'two'].map(text => endpoint.writeFile({ path: 'lecture.md', text, expectedVersion: version }, signal())))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'transcriber-engine/file-conflict' } })
    expect(await disk.readFile(join(workspace, 'lecture.md'), 'utf8')).toMatch(/^(one|two)$/u)
  })

  it('detects a same-size external edit even if mtime is restored', async () => {
    const path = join(workspace, 'lecture.md')
    const observed = await endpoint.stat({ path })
    const metadata = await disk.stat(path)
    await disk.writeFile(path, 'abcd')
    await disk.utimes(path, metadata.atime, metadata.mtime)
    await expect(endpoint.writeFile({ path, text: 'new', expectedVersion: observed.version }, signal()))
      .rejects.toMatchObject({ code: 'transcriber-engine/file-conflict' })
    expect(await disk.readFile(path, 'utf8')).toBe('abcd')
  })

  it.each(['write', 'rename', 'external-change', 'cancel'] as const)('keeps complete original bytes and removes staging files after %s failure', async (failure) => {
    const path = join(workspace, 'lecture.md')
    const { version } = await endpoint.stat({ path })
    const controller = new AbortController()
    const originalWrite = disk.writeFile
    if (failure === 'rename') vi.spyOn(disk, 'rename').mockRejectedValueOnce(new Error('rename denied'))
    else vi.spyOn(disk, 'writeFile').mockImplementationOnce(async (...args) => {
      await originalWrite(...args)
      if (failure === 'write') throw new Error('disk full')
      if (failure === 'cancel') controller.abort()
      if (failure === 'external-change') await originalWrite(path, 'edit')
    })
    await expect(endpoint.writeFile({ path, text: 'new', expectedVersion: version }, controller.signal))
      .rejects.toMatchObject({ code: failure === 'cancel' ? 'gateway/cancelled' : failure === 'external-change' ? 'transcriber-engine/file-conflict' : 'transcriber-engine/file-unavailable' })
    expect(await disk.readFile(path, 'utf8')).toBe(failure === 'external-change' ? 'edit' : 'أب')
    expect(await disk.readdir(workspace)).toEqual(['Figures', 'lecture.md'])
  })

  it('refuses oversized reads and replacements without truncating or modifying files', async () => {
    await disk.writeFile(join(workspace, 'large.md'), 'أبج')
    await disk.writeFile(join(workspace, 'large.png'), Buffer.alloc(5))
    await expect(endpoint.readFile({ path: 'large.md' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-too-large', details: { bytes: 6, limit: 4 } })
    await expect(endpoint.readFileBytes({ path: 'large.png' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-too-large' })
    const { version } = await endpoint.stat({ path: 'lecture.md' })
    await expect(endpoint.writeFile({ path: 'lecture.md', text: 'أبج', expectedVersion: version }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-too-large' })
    expect(await disk.readFile(join(workspace, 'lecture.md'), 'utf8')).toBe('أب')
    expect((await endpoint.stat({ path: 'large.md' })).bytes).toBe(6)
  })

  it('refuses invalid UTF-8, directories, absent files, and non-Markdown writes', async () => {
    await disk.writeFile(join(workspace, 'bad.txt'), Buffer.from([0xff]))
    await expect(endpoint.readFile({ path: 'bad.txt' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-not-utf8' })
    await expect(endpoint.stat({ path: 'Figures' })).rejects.toMatchObject({ code: 'transcriber-engine/file-not-regular' })
    await expect(endpoint.writeFile({ path: 'missing.md', text: '', expectedVersion: 'x' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-not-found' })
    await expect(endpoint.writeFile({ path: 'bad.txt', text: '', expectedVersion: 'x' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-not-markdown' })
  })

  it.each(['readFile', 'readFileBytes', 'writeFile', 'stat'] as const)('validates JSON paths and rejects NUL for %s', async (method) => {
    for (const path of ['', '\0']) await expect(endpoint[method]({ path, text: '', expectedVersion: 'x' }, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('reports missing workspace and filesystem failure with typed errors', async () => {
    const missing = new TranscriberEngine(new Context(), { environment: { TRANSCRIBER_WORKSPACE: join(root, 'missing') } })
    await expect(missing.stat({ path: 'x' })).rejects.toMatchObject({ code: 'transcriber-engine/not-found' })
    vi.spyOn(disk, 'stat').mockRejectedValueOnce(new Error('permission denied'))
    await expect(endpoint.stat({ path: 'lecture.md' })).rejects.toMatchObject({ code: 'transcriber-engine/file-unavailable' })
    vi.spyOn(disk, 'open').mockRejectedValueOnce({ code: 'EACCES' })
    await expect(endpoint.readFile({ path: 'lecture.md' }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/file-unavailable' })
  })

  it('rejects an already-cancelled read before filesystem access', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(endpoint.readFile({ path: 'lecture.md' }, controller.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it.each(['during-read', 'opened-directory', 'growing', 'cancel-open', 'cancel-stat', 'cleanup'] as const)('reports %s failure without returning a partial snapshot', async (failure) => {
    const controller = new AbortController()
    const originalOpen = disk.open
    const originalStat = disk.stat
    if (failure === 'cancel-stat') vi.spyOn(disk, 'stat').mockImplementationOnce(async (...args) => {
      controller.abort()
      await originalStat(...args)
      throw new Error('aborted stat')
    })
    else if (failure === 'cancel-open') vi.spyOn(disk, 'open').mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('aborted open')
    })
    else if (failure === 'cleanup') vi.spyOn(disk, 'rm').mockRejectedValueOnce(new Error('cleanup denied'))
    else vi.spyOn(disk, 'open').mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args)
      if (failure === 'opened-directory') {
        const stat = file.stat.bind(file)
        vi.spyOn(file, 'stat').mockImplementationOnce(async (...statArgs) => {
          const value = await stat(...statArgs)
          vi.spyOn(value, 'isFile').mockReturnValue(false)
          return value
        })
      } else {
        const read = file.read.bind(file)
        vi.spyOn(file, 'read').mockImplementationOnce(async (...readArgs) => {
          if (failure === 'growing') await disk.appendFile(join(workspace, 'lecture.md'), 'extra')
          const value = await read(...readArgs)
          if (failure === 'during-read') await disk.utimes(join(workspace, 'lecture.md'), new Date(), new Date('2030-01-01'))
          return value
        })
      }
      return file
    })
    const promise = failure === 'cleanup'
      ? endpoint.writeFile({ path: 'lecture.md', text: 'new', expectedVersion: (await endpoint.stat({ path: 'lecture.md' })).version }, controller.signal)
      : endpoint.readFile({ path: 'lecture.md' }, controller.signal)
    await expect(promise).rejects.toMatchObject({ code: failure.startsWith('cancel') ? 'gateway/cancelled' : failure === 'growing' ? 'transcriber-engine/file-too-large' : failure === 'opened-directory' ? 'transcriber-engine/file-not-regular' : 'transcriber-engine/file-unavailable' })
  })

  it('uses the same cwd fallback as the engine command', async () => {
    const local = new TranscriberEngine(new Context(), { environment: {} })
    const path = relative(process.cwd(), join(workspace, 'lecture.md'))
    await expect(local.readFile({ path }, signal())).rejects.toMatchObject({ code: 'transcriber-engine/path-outside-workspace' })
  })

  it('refuses grace periods above the subprocess timer range', () => {
    expect(() => Config({ mcpGraceMs: 2_147_483_648 })).toThrow()
  })

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])('refuses invalid Config byte cap %s', (value) => {
    expect(() => Config({ maxTextBytes: value })).toThrow()
    expect(() => Config({ maxImageBytes: value })).toThrow()
    expect(() => Config({ mcpOutputMaxBytes: value })).toThrow()
    expect(() => Config({ mcpGraceMs: value })).toThrow()
  })
})
