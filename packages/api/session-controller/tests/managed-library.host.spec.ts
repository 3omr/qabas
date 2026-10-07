/** Managed library fork policy over the real AgentLoop and JSONL persistence. */

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'
import { sessionDir } from '../../../session/session-persistence-jsonl/src/format.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { createSessionTestRemote } from './test-remote.ts'

it('forks a foreign historical Session into the library while preserving the parent generation bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qabas-managed-fork-')))
  const ctx = new Context()
  try {
    const library = join(root, 'library')
    const foreign = join(root, 'foreign')
    const storageRoot = join(root, 'sessions')
    await mkdir(foreign)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot, compression: 'none' })
    const parent = meta('historical-parent', foreign)
    const writer = await ctx.sessionPersistence.create(parent)
    const parentEvents = oneTurnLog()
    try {
      await writer.append(parentEvents)
    } finally {
      await writer.close()
    }
    const parentHeader = (await ctx.sessionPersistence.stat(parent.id))!.header
    const parentDir = sessionDir(storageRoot, foreign, parent.id)
    const beforeNames = (await readdir(parentDir)).filter(name => name.includes('.jsonl')).sort()
    const beforeBytes = await Promise.all(beforeNames.map(name => readFile(join(parentDir, name))))
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', domain)
    ctx.provide('storageDomain', domain)
    await ctx.plugin(WorkspaceRegistry, { managedDirectory: library })
    await mountAgentLoopTestHarness(ctx)
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: foreign,
    })
    const result = await remote.fork({ sessionId: parent.id })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    const child = ctx.sessions.get(result.value.sessionId)
    expect(child?.header).toMatchObject({ cwd: await realpath(library), parentSession: parent.id, isSeeded: true })
    expect(ctx.workspaceRegistry.managedWorkspace?.sessionIds).toEqual([child?.id])
    expect(ctx.sessions.get(parent.id)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBeUndefined()
    const childStored = await ctx.sessionPersistence.stat(result.value.sessionId)
    expect(childStored?.header).toMatchObject({ cwd: await realpath(library), parentSession: parent.id })
    const reader = await ctx.sessionPersistence.open(parent.id, 'read')
    try {
      expect(reader.header).toEqual(parentHeader)
      expect((await reader.read()).events).toEqual(parentEvents)
    } finally {
      await reader.close()
    }
    const afterNames = (await readdir(parentDir)).filter(name => name.includes('.jsonl')).sort()
    expect(afterNames).toEqual(beforeNames)
    expect(await Promise.all(afterNames.map(name => readFile(join(parentDir, name))))).toEqual(beforeBytes)
    expect(result.value.sessionId).not.toBe(SessionId('historical-parent'))
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
