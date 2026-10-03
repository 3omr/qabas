/** Authenticated credential checks keep keys and provider diagnostics on the Host. */
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { CredentialsController } from '../src/credentials.ts'

async function controller(request: typeof fetch, key?: string, timeoutMs = 5000) {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, key === undefined ? {} : { GEMINI_API_KEY: key })
  const service = new CredentialsController(ctx, { geminiKeyCheckTimeoutMs: timeoutMs }, { fetch: request })
  return { service, credentials: ctx.credentials }
}

const signal = (): AbortSignal => new AbortController().signal

describe('Gemini stored-key check', () => {
  it('makes one small authenticated request and observes the current credential on every call', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"models":[{"name":"models/gemini-flash"}]}'))
    const { service, credentials } = await controller(request, 'first-secret')
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'works' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenLastCalledWith('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', expect.objectContaining({
      method: 'GET', headers: { 'x-goog-api-key': 'first-secret' }, redirect: 'error',
    }))
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    await credentials.set(credentialRef('GEMINI_API_KEY'), 'rotated-secret')
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'works' })
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ 'x-goog-api-key': 'rotated-secret' })
  })

  it.each([undefined, '   '])('does not request the catalog without a usable stored key (%s)', async (key) => {
    const request = vi.fn<typeof fetch>()
    const { service } = await controller(request, key)
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'no-key' })
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    [400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}', { status: 'invalid-key' }],
    [401, '{"error":{"status":"UNAUTHENTICATED"}}', { status: 'invalid-key' }],
    [403, '{"error":{"status":"PERMISSION_DENIED","message":"API key is not permitted"}}', { status: 'invalid-key' }],
    [429, '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}', { status: 'quota', limit: 'daily' }],
    [429, '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel"}]}}', { status: 'quota', limit: 'per-minute' }],
    [429, 'RESOURCE_EXHAUSTED: quota exceeded', { status: 'quota', limit: 'unknown' }],
    [503, 'Service temporarily unavailable', { status: 'network' }],
    [302, 'Redirect elsewhere', { status: 'network' }],
  ] as const)('projects HTTP %s into credential-safe status', async (status, body, expected) => {
    const request: typeof fetch = async () => new Response(body + ' secret-echo', { status })
    const { service } = await controller(request, 'secret-echo')
    const result = await service.checkGeminiKey(signal())
    expect(result).toEqual(expected)
    expect(JSON.stringify(result)).not.toContain('secret-echo')
  })

  it('does not expose a credential embedded in a transport failure', async () => {
    const request: typeof fetch = async () => { throw new Error('connection failed with secret-echo') }
    const { service } = await controller(request, 'secret-echo')
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'network' })
  })

  it('classifies malformed header values as invalid keys without sending them', async () => {
    const request = vi.fn<typeof fetch>()
    const { service } = await controller(request, 'secret\r\nInjected: value')
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'invalid-key' })
    expect(request).not.toHaveBeenCalled()
  })

  it('aborts an unsettled request at the configured deadline', async () => {
    const request: typeof fetch = async (_url, options) => await new Promise<Response>((_resolve, reject) => {
      const requestSignal = options?.signal
      if (requestSignal === undefined || requestSignal === null) throw new Error('missing signal')
      requestSignal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
    })
    const { service } = await controller(request, 'secret', 20)
    expect(await service.checkGeminiKey(signal())).toEqual({ status: 'network' })
  })

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])('refuses an invalid configured request deadline (%s)', async (timeoutMs) => {
    await expect(controller(vi.fn<typeof fetch>(), 'secret', timeoutMs)).rejects.toThrow()
  })

  it('passes caller cancellation to the authenticated request', async () => {
    const cancellation = new AbortController()
    const request: typeof fetch = async (_url, options) => {
      cancellation.abort()
      expect(options?.signal?.aborted).toBe(true)
      throw new Error('cancelled')
    }
    const { service } = await controller(request, 'secret')
    expect(await service.checkGeminiKey(cancellation.signal)).toEqual({ status: 'network' })
  })
})
