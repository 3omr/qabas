/** Session-free Client calls preserve their generated Remote results and cancellation. */

import { Context } from '@deepseek-ai/cordis'
import { isRemoteMethodNameAvailable } from '@deepseek-ai/dsh-api-gateway/client'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

it('publishes the library methods over the generated namespace without a Session argument', async () => {
  const result = { ok: true as const, value: { absolutePath: '/workspace/lecture.md', version: 'v1', text: 'lecture', bytes: 'AQ==' } }
  const remote = {
    workspace: vi.fn().mockResolvedValue({ ok: true, value: { path: '/workspace', source: 'env', exists: true, modules: 0 } }),
    setWorkspace: vi.fn().mockResolvedValue({ ok: false, error: { code: 'gateway/bad-request', message: 'Absolute path required', details: {} } }),
    setGeneralMaterials: vi.fn().mockResolvedValue({ ok: true, value: { module: 'toxo', general_materials: ['Book.pdf'] } }),
    hideLecture: vi.fn().mockResolvedValue({ ok: true, value: { module: 'toxo', recordings: ['Shock.m4a'] } }),
    restoreRecordings: vi.fn().mockResolvedValue({ ok: true, value: { module: 'toxo', recordings: ['Shock.m4a'] } }),
    createModule: vi.fn().mockResolvedValue({ ok: true, value: 'Created module' }),
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
    expect(await ctx.transcriberEngine.workspace(signal)).toEqual({ ok: true, value: { path: '/workspace', source: 'env', exists: true, modules: 0 } })
    expect(remote.workspace).toHaveBeenCalledWith(signal)
    expect(await ctx.transcriberEngine.setWorkspace({ path: 'relative', create: false }, signal)).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(remote.setWorkspace).toHaveBeenCalledWith({ path: 'relative', create: false }, signal)
    expect(await ctx.transcriberEngine.createModule({ module: 'toxo', displayName: 'Toxicology' }, signal)).toEqual({ ok: true, value: 'Created module' })
    expect(remote.createModule).toHaveBeenCalledWith({ module: 'toxo', displayName: 'Toxicology' }, signal)
    const generalRequest = { module: 'toxo', materials: ['Book.pdf'] }
    expect(await ctx.transcriberEngine.setGeneralMaterials(generalRequest, signal)).toEqual({ ok: true, value: { module: 'toxo', general_materials: ['Book.pdf'] } })
    expect(remote.setGeneralMaterials).toHaveBeenCalledWith(generalRequest, signal)
    const refusal = { ok: false, error: { code: 'transcriber-engine/edit-rejected', message: 'Unknown material', details: { tool: 'set_general_materials', detail: 'Unknown material' } } }
    remote.setGeneralMaterials.mockResolvedValueOnce(refusal)
    expect(await ctx.transcriberEngine.setGeneralMaterials(generalRequest, signal)).toBe(refusal)
    const visibility = { ok: true, value: { module: 'toxo', recordings: ['Shock.m4a'] } }
    expect(await ctx.transcriberEngine.hideLecture({ module: 'toxo', title: 'Shock' }, signal)).toEqual(visibility)
    expect(remote.hideLecture).toHaveBeenCalledWith({ module: 'toxo', title: 'Shock' }, signal)
    expect(await ctx.transcriberEngine.restoreRecordings({ module: 'toxo', recordings: ['Shock.m4a'] }, signal)).toEqual(visibility)
    expect(remote.restoreRecordings).toHaveBeenCalledWith({ module: 'toxo', recordings: ['Shock.m4a'] }, signal)
    remote.restoreRecordings.mockResolvedValueOnce(refusal)
    expect(await ctx.transcriberEngine.restoreRecordings({ module: 'toxo', recordings: ['Shock.m4a'] }, signal)).toBe(refusal)
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
    for (const name of ['hideLecture', 'restoreRecordings', 'setGeneralMaterials', 'workspace', 'setWorkspace', 'createModule', 'listModules', 'readFile', 'readFileBytes', 'writeFile', 'stat']) expect(isRemoteMethodNameAvailable(name)).toBe(true)
  } finally {
    await fiber.dispose()
  }
  expect(ctx.get('transcriberEngine')).toBeUndefined()
})
