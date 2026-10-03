/** Accounts data calls report only safe Host check results and preserve write-only credentials. */
import { expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientRemote, GeminiKeyCheck, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { geminiKeyOf } from '../src/client/gemini-key.ts'

it('returns the authenticated Host check result without accepting a client key', async () => {
  const remote = {
    checkGeminiKey: vi.fn<() => Promise<RemoteResult<GeminiKeyCheck>>>(async () => ({ ok: true, value: { status: 'quota', limit: 'daily' } })),
    describe: vi.fn(async () => ({ ok: true as const, value: { GEMINI_API_KEY: { configured: true, writable: true } } })),
    set: vi.fn(async () => ({ ok: true as const, value: undefined })),
    unset: vi.fn(async () => ({ ok: true as const, value: undefined })),
  } satisfies Pick<ClientRemote['credentials'], 'checkGeminiKey' | 'describe' | 'set' | 'unset'>
  const stop = vi.fn()
  let notify: ((ref: string) => void) | undefined
  const key = geminiKeyOf(remote, (changed) => { notify = changed; return stop })
  expect(await key.check()).toEqual({ status: 'quota', limit: 'daily' })
  expect(remote.checkGeminiKey).toHaveBeenCalledWith()
  remote.checkGeminiKey.mockRejectedValueOnce(new Error('Connection lost'))
  expect(await key.check()).toEqual({ status: 'network' })
  remote.checkGeminiKey.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'unavailable', {}) })
  expect(await key.check()).toEqual({ status: 'network' })
  expect(await key.describe()).toEqual({ configured: true, writable: true })
  expect(await key.save('new-secret')).toBeUndefined()
  expect(remote.set).toHaveBeenCalledWith('GEMINI_API_KEY', 'new-secret')
  expect(await key.remove()).toBeUndefined()
  expect(remote.unset).toHaveBeenCalledWith('GEMINI_API_KEY')
  const changed = vi.fn()
  const dispose = key.watch(changed)
  notify?.('UNRELATED_KEY')
  expect(changed).not.toHaveBeenCalled()
  notify?.('GEMINI_API_KEY')
  expect(changed).toHaveBeenCalledTimes(1)
  dispose()
  expect(stop).toHaveBeenCalledTimes(1)
})
