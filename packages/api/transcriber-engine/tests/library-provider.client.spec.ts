/** Session-free Client calls preserve their generated Remote results and cancellation. */

import { Context } from '@deepseek-ai/cordis'
import { isRemoteMethodNameAvailable } from '@deepseek-ai/dsh-api-gateway/client'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('publishes the library methods over the generated namespace without a Session argument', async () => {
  const result = { ok: true as const, value: { absolutePath: '/workspace/lecture.md', version: 'v1', text: 'lecture', bytes: 'AQ==' } }
  const remote = {
    listModules: vi.fn().mockResolvedValue({ ok: true, value: { workspace: '/workspace', modules: [] } }),
    readFile: vi.fn().mockResolvedValue(result), readFileBytes: vi.fn().mockResolvedValue(result),
    writeFile: vi.fn().mockResolvedValue(result), stat: vi.fn().mockResolvedValue(result),
    auth: vi.fn(() => []), answerAuth: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    cancelAuth: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  }
  const ctx = new Context()
  ctx.provide('remote', { transcriberEngine: remote } as never)
  ctx.provide('remote.transcriberEngine', remote as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber
  try {
    const signal = new AbortController().signal
    await expect(ctx.transcriberEngine.listModules(signal)).resolves.toEqual({ ok: true, value: { workspace: '/workspace', modules: [] } })
    expect(remote.listModules).toHaveBeenCalledWith(signal)
    const request = { path: 'lecture.md' }
    await expect(ctx.transcriberEngine.readFile(request, signal)).resolves.toBe(result)
    expect(remote.readFile).toHaveBeenCalledWith(request, signal)
    await expect(ctx.transcriberEngine.readFileBytes({ ...request, relativeTo: 'other.md' }, signal)).resolves.toBe(result)
    expect(remote.readFileBytes).toHaveBeenCalledWith({ ...request, relativeTo: 'other.md' }, signal)
    await expect(ctx.transcriberEngine.writeFile({ ...request, text: 'new', expectedVersion: 'v1' }, signal)).resolves.toBe(result)
    expect(remote.writeFile).toHaveBeenCalledWith({ ...request, text: 'new', expectedVersion: 'v1' }, signal)
    await expect(ctx.transcriberEngine.stat(request)).resolves.toBe(result)
    expect(remote.stat).toHaveBeenCalledWith(request)
    expect(ctx.transcriberEngine.auth(signal)).toEqual([])
    await expect(ctx.transcriberEngine.answerAuth('answer')).resolves.toEqual({ ok: true, value: undefined })
    await expect(ctx.transcriberEngine.cancelAuth()).resolves.toEqual({ ok: true, value: undefined })
    for (const name of ['listModules', 'readFile', 'readFileBytes', 'writeFile', 'stat']) expect(isRemoteMethodNameAvailable(name)).toBe(true)
  } finally {
    await fiber.dispose()
  }
  expect(ctx.get('transcriberEngine')).toBeUndefined()
})
