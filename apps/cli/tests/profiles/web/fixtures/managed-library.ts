/** Observe managed-library ownership after the shipped Web profile finishes booting. */

import type { Context } from '@deepseek-ai/cordis'
import { exitOnStdinEnd } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'

/** Fixture plugin name. */
export const name = 'managed-library-profile-observer'
/** Production services observed by this fixture. */
export const inject = ['sessionController', 'sessionPersistence', 'workspaceRegistry', 'workspaceController', 'attachments']

interface Config {
  readonly foreignDirectory: string
  readonly legacySessionId: SessionId
  readonly legacyAttachment: FileAttachmentRef
}

async function rejectedMutation(operation: () => Promise<unknown>): Promise<{ name: string; code: string }> {
  try {
    await operation()
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      return { name: error.name, code: error.code }
    }
    throw error
  }
  throw new Error('managed Workspace mutation was accepted')
}

async function observe(ctx: Context, config: Config): Promise<void> {
  const before = ctx.workspaceRegistry.list().map(workspace => ({
    id: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
  }))
  const created = await ctx.sessionController.create({})
  await ctx.sessionPersistence.flush()
  const stored = await ctx.sessionPersistence.stat(created.sessionId)
  const attachment = await ctx.attachments.saveFile({ data: Buffer.from('managed-library-attachment\n'), name: 'lecture.txt' })
  const legacyBytes: Uint8Array[] = []
  for await (const chunk of ctx.attachments.readFileStream(config.legacyAttachment)) legacyBytes.push(chunk)
  const managed = ctx.workspaceRegistry.managedWorkspace
  if (managed === undefined) throw new Error('shipped Web profile did not publish a managed Workspace')
  const errors = {
    rename: await rejectedMutation(() => ctx.workspaceController.rename({ workspaceId: managed.id, title: 'Other library' })),
    delete: await rejectedMutation(() => ctx.workspaceController.delete({ workspaceId: managed.id })),
    foreignWorkspace: await rejectedMutation(() => ctx.workspaceController.create({ path: config.foreignDirectory })),
    foreignSession: await rejectedMutation(() => ctx.sessionController.create({ cwd: config.foreignDirectory })),
  }
  process.stdout.write(`QABAS_MANAGED_LIBRARY ${JSON.stringify({
    before,
    created,
    header: stored?.header,
    after: ctx.workspaceRegistry.list().map(workspace => ({
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [...workspace.sessionIds],
    })),
    attachmentPath: ctx.attachments.fileHostPath(attachment),
    legacyHeader: (await ctx.sessionPersistence.stat(config.legacySessionId))?.header,
    legacyAttachmentPath: ctx.attachments.fileHostPath(config.legacyAttachment),
    legacyAttachmentContent: Buffer.concat(legacyBytes).toString(),
    errors,
  })}\n`)
}

/**
 * Report resolved production state without a model turn, then let stdin EOF request bounded disposal.
 * @param ctx - real services from the CLI's shipped Web composition.
 * @param config - isolated legacy data and a foreign directory owned by the test.
 */
export function apply(ctx: Context, config: Config): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) throw new Error('profile observer requires CLI readiness and shutdown')
  exitOnStdinEnd(ctx, 'managed-library-observer.stdin')
  process.stdin.resume()
  ctx.effect(() => ready.onReady(() => {
    void observe(ctx, config).catch((error: unknown) => {
      process.stderr.write(`managed-library observer failed: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    })
  }), 'managed-library-observer.ready')
}
