/** File-import safety and mixed-drop behavior at the Host filesystem boundary. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { TranscriberEngine } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transcriber-import-'))
  roots.push(root)
  await writeFile(join(root, 'workspace.marker'), '')
  return root
}

async function moduleRoot(root: string, moduleId = 'toxo'): Promise<string> {
  const path = join(root, 'modules', moduleId)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'module.json'), '{}')
  return path
}

function service(root: string): TranscriberEngine {
  return new TranscriberEngine(new Context(), {
    environment: { TRANSCRIBER_WORKSPACE: root },
  })
}

describe('transcriber engine file import', () => {
  it('refuses a module path that escapes the workspace before copying', async () => {
    const root = await workspace()
    const source = join(root, 'recording.mp3')
    await writeFile(source, 'recording')

    await expect(service(root).importFiles({
      module: '../outside', destination: 'Lecture', paths: [source],
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'transcriber-engine/import-invalid' })
  })

  it('refuses a colliding name and preserves both the existing file and the source', async () => {
    const root = await workspace()
    const module = await moduleRoot(root)
    const source = join(root, 'lecture.mp3')
    const destination = join(module, 'Lecture', 'lecture.mp3')
    await mkdir(join(module, 'Lecture'), { recursive: true })
    await writeFile(source, 'new')
    await writeFile(destination, 'old')

    const report = await service(root).importFiles({
      module: 'toxo', destination: 'Lecture', paths: [source],
    }, new AbortController().signal)

    expect(report.filed).toEqual([])
    expect(report.rejected[0]).toMatchObject({ name: 'lecture.mp3', reason: 'name-collision' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('old')
    await expect(readFile(source, 'utf8')).resolves.toBe('new')
  })

  it('honours cancellation before resolving the module layout', async () => {
    const root = await workspace()
    await moduleRoot(root)
    const source = join(root, 'lecture.mp3')
    await writeFile(source, 'audio')
    const controller = new AbortController()
    controller.abort()

    await expect(service(root).importFiles({
      module: 'toxo', destination: 'Lecture', paths: [source],
    }, controller.signal)).rejects.toMatchObject({ code: 'gateway/cancelled' })
  })

  it('files accepted sources while reporting an unsupported source in the same drop', async () => {
    const root = await workspace()
    await moduleRoot(root)
    const recording = join(root, 'lecture.m4a')
    const rejected = join(root, 'notes.zip')
    await writeFile(recording, 'audio')
    await writeFile(rejected, 'archive')

    const report = await service(root).importFiles({
      module: 'toxo', destination: 'Lecture', paths: [recording, rejected],
    }, new AbortController().signal)

    expect(report.filed).toHaveLength(1)
    expect(report.filed[0]?.destination).toBe(join(root, 'modules', 'toxo', 'Lecture', 'lecture.m4a'))
    expect(report.rejected).toEqual([{
      source: rejected,
      name: 'notes.zip',
      reason: 'unsupported-extension',
      detail: '.zip',
    }])
    await expect(readFile(recording, 'utf8')).resolves.toBe('audio')
  })
})
