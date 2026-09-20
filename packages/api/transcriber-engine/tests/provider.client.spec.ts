/** Client provider wiring over the generated transcriber Remote namespace. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('transcriber engine Client provider', () => {
  it('forwards doctor calls through the app-facing capability', async () => {
    const response = { ok: true as const, value: { platform: 'linux' } as never }
    const doctor = vi.fn().mockResolvedValue(response)
    const remote = { transcriberEngine: { doctor } }
    const ctx = new Context()
    ctx.provide('remote', remote as never)
    ctx.provide('remote.transcriberEngine', remote.transcriberEngine as never)
    await ctx.plugin({ inject: [...inject], apply })

    const signal = new AbortController().signal
    await expect(ctx.transcriberEngine.doctor({ live: false }, signal)).resolves.toBe(response)
    expect(doctor).toHaveBeenCalledWith({ live: false }, signal)
  })
})
