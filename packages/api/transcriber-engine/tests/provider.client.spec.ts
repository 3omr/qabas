/** Client provider wiring over the generated transcriber Remote namespace. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('transcriber engine Client provider', () => {
  it('forwards doctor calls through the app-facing capability', async () => {
    const response = { ok: true as const, value: { platform: 'linux' } as never }
    const doctor = vi.fn().mockResolvedValue(response)
    const listingResponse = { ok: true as const, value: { module: 'toxo' } as never }
    const listLectures = vi.fn().mockResolvedValue(listingResponse)
    const importResponse = { ok: true as const, value: { module: 'toxo', destination: 'Lecture' } as never }
    const importFiles = vi.fn().mockResolvedValue(importResponse)
    const installFrames = [{ type: 'plan', route: 'user', launcher: 'in-process', command: 'pipx install notebooklm-mcp-cli' }] as never
    const install = vi.fn(() => installFrames)
    const authStatusResponse = { ok: true as const, value: { connected: false, reason: 'not-connected' } as never }
    const authStatus = vi.fn().mockResolvedValue(authStatusResponse)
    const remote = { transcriberEngine: { doctor, install, authStatus, listLectures, importFiles } }
    const ctx = new Context()
    ctx.provide('remote', remote as never)
    ctx.provide('remote.transcriberEngine', remote.transcriberEngine as never)
    await ctx.plugin({ inject: [...inject], apply })

    const signal = new AbortController().signal
    await expect(ctx.transcriberEngine.doctor({ live: false }, signal)).resolves.toBe(response)
    expect(doctor).toHaveBeenCalledWith({ live: false }, signal)

    expect(ctx.transcriberEngine.install({ name: 'nlm' }, signal)).toBe(installFrames)
    expect(install).toHaveBeenCalledWith({ name: 'nlm' }, signal)
    await expect(ctx.transcriberEngine.authStatus(signal)).resolves.toBe(authStatusResponse)
    expect(authStatus).toHaveBeenCalledWith(signal)

    const listing = await ctx.transcriberEngine.listLectures({ module: 'toxo' }, signal)
    expect(listing).toBe(listingResponse)
    expect(listLectures).toHaveBeenCalledWith({ module: 'toxo' }, signal)

    const imported = await ctx.transcriberEngine.importFiles({
      module: 'toxo', destination: 'Lecture', paths: ['/tmp/lecture.mp3'],
    }, signal)
    expect(imported).toBe(importResponse)
    expect(importFiles).toHaveBeenCalledWith({
      module: 'toxo', destination: 'Lecture', paths: ['/tmp/lecture.mp3'],
    }, signal)
  })
})
