/** Native sidecar preparation preserves the app's engine layout after relocation. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { prepareEngine } = await import(pathToFileURL(resolve(import.meta.dirname, '../apps/desktop/scripts/runtime-engine.mjs')).href) as {
  prepareEngine: (repoRoot: string, appOutput: string, target: { platform: string; arch: string }) => Promise<void>
}

it('copies native sidecars and rejects a missing target build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qabas-engine-'))
  try {
    await mkdir(join(root, 'engine/dist'), { recursive: true })
    await writeFile(join(root, 'engine/transcriber.cordis.yml'), 'engine patch')
    for (const [platform, arch, triple, extension] of [
      ['linux', 'x64', 'x86_64-unknown-linux-gnu', ''],
      ['darwin', 'arm64', 'aarch64-apple-darwin', ''],
      ['win32', 'x64', 'x86_64-pc-windows-msvc', '.exe'],
    ] as const) {
      const output = join(root, platform, 'app')
      await writeFile(join(root, 'engine/dist', `transcriber-engine-${triple}${extension}`), triple)
      await prepareEngine(root, output, { platform, arch })
      expect(await readFile(join(output, 'engine', `transcriber-engine${extension}`), 'utf8')).toBe(triple)
      expect(await readFile(join(output, 'engine/transcriber.cordis.yml'), 'utf8')).toBe('engine patch')
    }
    await expect(prepareEngine(root, join(root, 'missing/app'), { platform: 'darwin', arch: 'x64' })).rejects.toThrow('engine:build')
    await expect(prepareEngine(root, join(root, 'foreign/app'), { platform: 'linux', arch: 'ia32' })).rejects.toThrow('Unsupported engine target')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
