import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { SessionStore, SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import NativeDesktopHost, { resolveConfig } from '../src/index.ts'
import type { DesktopProfileName } from '@deepseek-ai/dsh-desktop'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('desktop native bridge provider', () => {
  it('forwards the NotebookLM PTY lifecycle and validates incremental output', async () => {
    const session = 'a'.repeat(32)
    const fetch = vi.fn<(input: URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, session })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, cursor: 42, output: 'Open https://accounts.example.test', done: false, exitCode: null, failure: null,
      })))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
      .mockResolvedValueOnce(new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    try {
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token' })
      const started = await ctx.desktop.startNotebookLmAuth()
      expect(started.session).toBe(session)
      await expect(ctx.desktop.pollNotebookLmAuth(started, 0)).resolves.toEqual({
        cursor: 42, output: 'Open https://accounts.example.test', done: false, exitCode: null, failure: null,
      })
      await ctx.desktop.writeNotebookLmAuth(started, 'fixture-code')
      await ctx.desktop.cancelNotebookLmAuth(started)
      expect(fetch.mock.calls.map(call => call[0].pathname)).toEqual([
        '/v1/notebooklm-auth/start', '/v1/notebooklm-auth/poll',
        '/v1/notebooklm-auth/write', '/v1/notebooklm-auth/cancel',
      ])
      expect(fetch.mock.calls[1]?.[0].search).toBe(`?session=${session}&cursor=0`)
      expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ session, line: 'fixture-code' }))
      expect(fetch.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ session }))
    } finally { await ctx.fiber.dispose() }
  })

  it('opens agent settings through the private bridge without paths, account or activation input', async () => {
    const fetch = vi.fn((_url: URL, _init: RequestInit) => Promise.resolve(new Response('{"ok":true}')))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    try {
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token' })
      expect(fetch).not.toHaveBeenCalled()
      await ctx.desktop.openLocalAgents()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0]![0].pathname).toBe('/v1/local-agents')
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', headers: { 'x-dsh-desktop-bridge-token': 'token' } })
      expect(fetch.mock.calls[0]![1].body).toBeUndefined()
      fetch.mockResolvedValueOnce(new Response('', { status: 403 }))
      await expect(ctx.desktop.openLocalAgents()).rejects.toThrow('HTTP 403')
    } finally { await ctx.fiber.dispose() }
  })
  it('reads native selection and sends queue or exact cancellation without restarting', async () => {
    const selection = { schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null }
    const fetch = vi.fn((_url: URL, _init: RequestInit) => Promise.resolve(new Response(JSON.stringify({ ok: true, selection }))))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    try {
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token' })
      expect(await ctx.desktop.profileSelection()).toEqual(selection)
      const candidate = { profile: 'desktop-00000000-0000-4000-8000-000000000001' as DesktopProfileName,
        previousProfile: 'web' as DesktopProfileName, manifestSha256: 'a'.repeat(64) }
      await ctx.desktop.queueProfile(candidate)
      await ctx.desktop.cancelProfile(candidate.profile)
      expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(['/v1/profile-selection', '/v1/profile-queue', '/v1/profile-cancel'])
      expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'POST', body: JSON.stringify(candidate) })
      expect(fetch.mock.calls[2]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ profile: candidate.profile }) })
    } finally { await ctx.fiber.dispose() }
  })

  it('bounds and validates the complete Profile response instead of trusting native JSON', async () => {
    const fetch = vi.fn<() => Promise<Response>>()
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    const selection = { schemaVersion: 1, activeProfile: 'web', previousProfile: null, pending: null, trial: null, lastFailure: null }
    const valid = JSON.stringify({ ok: true, selection })
    try {
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token' })
      fetch.mockResolvedValueOnce(new Response(valid.padEnd(65_536, ' ')))
      expect(await ctx.desktop.profileSelection()).toEqual(selection)
      for (const response of [new Response(valid.padEnd(65_537, ' ')), new Response(null), new Response('{'),
        new Response(new Uint8Array([255])), new Response(JSON.stringify({ ok: true, selection: { ...selection, schemaVersion: 2 } })),
        new Response(JSON.stringify({ ok: true, selection: { ...selection, activeProfile: '../unsafe' } })),
        new Response(JSON.stringify({ ok: true, selection: { ...selection, pending: { profile: 'web', previousProfile: 'web', manifestSha256: 'a'.repeat(64) } } })),
      ]) {
        fetch.mockResolvedValueOnce(response)
        await expect(ctx.desktop.profileSelection()).rejects.toThrow()
      }
    } finally { await ctx.fiber.dispose() }
  })

  it('requires launcher readiness and validates per-child acknowledgement identities', async () => {
    const ctx = new Context()
    try {
      await expect(ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token',
        startupToken: 'a'.repeat(32),
      })).rejects.toThrow('launcher-owned appReady')
      expect(() => resolveConfig({ endpoint: 'http://127.0.0.1:43123', token: 'token', startupToken: 'invalid' }))
        .toThrow('per-child hexadecimal identity')
    } finally { await ctx.fiber.dispose() }
  })

  it('acknowledges committed launcher startup, never plugin mounting or disposed listeners', async () => {
    const fetch = vi.fn((_url: URL, _init: RequestInit) => Promise.resolve(new Response('{"ok":true}')))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    const listeners = new Set<() => void>()
    ctx.provide('appReady', { onReady(listener) { listeners.add(listener); return () => { listeners.delete(listener) } } })
    try {
      const fiber = await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret',
        startupToken: 'a'.repeat(32),
      })
      expect(fetch).not.toHaveBeenCalled()
      for (const listener of listeners) listener()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0]?.[0].href).toBe('http://127.0.0.1:43123/v1/runtime-ready')
      expect(fetch.mock.calls[0]?.[1].body).toBe(JSON.stringify({ attempt: 'a'.repeat(32) }))
      expect(fetch.mock.calls[0]?.[1].headers).toMatchObject({ 'x-dsh-desktop-bridge-token': 'bridge-secret' })
      await fiber.dispose()
      expect(listeners.size).toBe(0)
      const pending = await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret',
        startupToken: 'b'.repeat(32),
      })
      await pending.dispose()
      expect(listeners.size).toBe(0)
      expect(fetch).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it('aborts and drains acknowledgement transport before disposal completes', async () => {
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
      init.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      await release.promise
      throw new Error('private transport failure')
    }))
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    let disposal: Promise<unknown> | undefined
    try {
      const fiber = await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret',
        startupToken: 'a'.repeat(32),
      })
      let settled = false
      disposal = fiber.dispose().then(() => { settled = true })
      await aborted.promise
      expect(settled).toBe(false)
      release.resolve(undefined)
      await disposal
      expect(warn).not.toHaveBeenCalled()
    } finally { release.resolve(undefined); await disposal; await ctx.fiber.dispose(); warn.mockRestore() }
  })

  it('contains a rejected startup acknowledgement without logging launch identities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    try {
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret', startupToken: 'a'.repeat(32) })
      await expect.poll(() => warn.mock.calls.length).toBe(1)
      expect(warn).toHaveBeenCalledWith('desktop-native: startup acknowledgement could not be delivered')
    } finally { await ctx.fiber.dispose(); warn.mockRestore() }
  })
  it('keeps turn notifications opt-in outside the desktop overlay', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token' })
      ctx.sessions.create().append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contains notification failure without exposing error details or rejecting the committed turn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private native error')))
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(NativeDesktopHost, {
        endpoint: 'http://127.0.0.1:43123', token: 'token', notifyOnTurnEnd: true,
      })
      const session = ctx.sessions.create()
      expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).not.toThrow()
      await expect.poll(() => warn.mock.calls.length).toBe(1)
      expect(warn).toHaveBeenCalledWith('desktop-native: background notification could not be delivered')
      expect(session.snapshotEvents().at(-1)?.type).toBe('turn/end')
    } finally {
      await ctx.fiber.dispose()
      warn.mockRestore()
    }
  })

  it('notifies only live top-level completion and failure, with no task contents', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response('{"ok":true}')))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      const fiber = ctx.plugin(NativeDesktopHost, {
        endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret', notifyOnTurnEnd: true,
      })
      await fiber
      const session = ctx.sessions.create()
      const child = ctx.sessions.create(undefined, { meta: { parentSession: session.id } })
      child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const ignored: TurnEndReason[] = [
        { kind: 'blocked' }, { kind: 'max-tokens' }, { kind: 'interrupted' },
        { kind: 'aborted', reason: { kind: 'legacy' } },
      ]
      for (const reason of ignored) session.append('turn/end', { turn: 1, reason })
      expect(fetch).not.toHaveBeenCalled()
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      session.append('turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'private failure' } } })
      await expect.poll(() => fetch.mock.calls.length).toBe(2)
      expect(fetch.mock.calls.map(call => call[1]?.body)).toEqual([
        JSON.stringify({ title: 'Harness Desktop', body: 'Task finished. Open Harness Desktop to review.', backgroundOnly: true }),
        JSON.stringify({ title: 'Harness Desktop', body: 'Task failed. Open Harness Desktop to review.', backgroundOnly: true }),
      ])
      ctx.sessions.create(SessionId('restored'), { seed: session.snapshotEvents() })
      expect(fetch).toHaveBeenCalledTimes(2)
      await fiber.dispose()
      session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('delegates notification policy, contains thrown policies, and restores delivery after policy disposal', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('{"ok":true}')))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(NativeDesktopHost, { endpoint: 'http://127.0.0.1:43123', token: 'token', notifyOnTurnEnd: true })
      const policy = ctx.plugin({ apply(policyCtx: Context) {
        policyCtx.on('desktop/task-notification', (outcome, next) => outcome === 'error' && next())
      } })
      await policy.await()
      const session = ctx.sessions.create()
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(fetch).not.toHaveBeenCalled()
      session.append('turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'private' } } })
      expect(fetch).toHaveBeenCalledOnce()
      await policy.dispose()
      const off = ctx.on('desktop/task-notification', () => { throw new Error('private policy error') })
      expect(() => session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })).not.toThrow()
      await expect.poll(() => warn.mock.calls.length).toBe(1)
      expect(warn).toHaveBeenCalledWith('desktop-native: background notification could not be delivered')
      expect(fetch).toHaveBeenCalledOnce()
      off()
      session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { await ctx.fiber.dispose(); warn.mockRestore() }
  })

  it.each([true, false])('scopes desktop orientation to the provider lifetime (prompt first: %s)', async (promptFirst) => {
    const ctx = new Context()
    try {
      if (promptFirst) await ctx.plugin(SystemPrompt)
      const fiber = ctx.plugin(NativeDesktopHost, {
        endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret',
      })
      await fiber
      if (!promptFirst) await ctx.plugin(SystemPrompt)
      await expect.poll(async () => renderPrompt(await ctx.systemPrompt.assemble()))
        .toContain('Harness Desktop, a desktop application built on DeepSeek Harness')
      const prompt = renderPrompt(await ctx.systemPrompt.assemble())
      expect(prompt).not.toContain('bridge-secret')
      expect(prompt).not.toContain('43123')
      const removePersona = ctx.systemPrompt.section({
        name: 'fixture:persona', order: 0, text: 'A complete custom persona.', complete: true,
      })
      expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe('A complete custom persona.')
      removePersona()
      await fiber.dispose()
      expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Harness Desktop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts only an exact IPv4 loopback HTTP origin', () => {
    expect(resolveConfig({ endpoint: 'http://127.0.0.1:43123', token: 'token' }))
      .toEqual({ endpoint: 'http://127.0.0.1:43123', token: 'token', timeoutMs: 5_000, notifyOnTurnEnd: false })
    for (const endpoint of [
      'https://127.0.0.1:43123',
      'http://localhost:43123',
      'http://127.0.0.1:43123/path',
      'http://127.0.0.1',
    ]) {
      expect(() => resolveConfig({ endpoint, token: 'token' })).toThrow(/127\.0\.0\.1/)
    }
    expect(() => resolveConfig({ endpoint: 'http://127.0.0.1:43123', token: '' })).toThrow(/must not be empty/)
  })

  it('authenticates every allowlisted native operation without exposing the token in the body', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })))
    vi.stubGlobal('fetch', fetch)
    const ctx = new Context()
    const host = new NativeDesktopHost(ctx, {
      endpoint: 'http://127.0.0.1:43123',
      token: 'bridge-secret',
    })
    await expect(host.status()).resolves.toEqual({ available: true })
    await host.notify({ title: 'Finished', body: 'The task completed.' })
    const status = fetch.mock.calls[0]
    const statusUrl = status?.[0]
    const statusHref = typeof statusUrl === 'string'
      ? statusUrl
      : statusUrl instanceof URL
        ? statusUrl.href
        : statusUrl?.url
    expect(statusHref).toBe('http://127.0.0.1:43123/v1/status')
    expect(status?.[1]?.headers).toMatchObject({ 'x-dsh-desktop-bridge-token': 'bridge-secret' })
    const notification = fetch.mock.calls[1]
    const notificationBody = notification?.[1]?.body
    if (typeof notificationBody !== 'string') throw new TypeError('expected the notification body to be a string')
    expect(notificationBody).toBe('{"title":"Finished","body":"The task completed."}')
    expect(notificationBody).not.toContain('bridge-secret')
    await host.setAutostart(true)
    expect(fetch.mock.calls[2]?.[1]?.body).toBe('{"enabled":true}')
  })

  it('turns a bridge HTTP rejection into a stable operation failure', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('', { status: 403 }))))
    const ctx = new Context()
    const host = new NativeDesktopHost(ctx, {
      endpoint: 'http://127.0.0.1:43123',
      token: 'bridge-secret',
    })
    await expect(host.show()).rejects.toThrow('HTTP 403')
  })

  it.each([new Error('offline'), 'offline'])('reports a rejected bridge transport (%s)', async (failure) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
    const ctx = new Context()
    try {
      const host = new NativeDesktopHost(ctx, {
        endpoint: 'http://127.0.0.1:43123', token: 'bridge-secret',
      })
      await expect(host.status()).rejects.toThrow('desktop-native: native operation failed: offline')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
