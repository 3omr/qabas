/** Desktop user-bin discovery uses real Windows path and access semantics. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '../src/index.ts'

// POSIX cannot reproduce Windows's executable extension and case semantics.
it.skipIf(process.platform !== 'win32')('finds user-installed agy while respecting an explicit PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-user-bin-'))
  const ctx = new Context()
  try {
    const bin = join(root, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const executable = join(bin, 'agy.EXE')
    await writeFile(executable, '')
    vi.stubEnv('USERPROFILE', root)
    vi.stubEnv('PATH', '')
    await ctx.plugin(LocalSubprocessRuntime)
    expect(await ctx.subprocess.resolveExecutable('agy')).toBe(executable)
    await expect(ctx.subprocess.resolveExecutable('agy', { PATH: '' })).rejects.toThrow('was not found on PATH')
  } finally {
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
