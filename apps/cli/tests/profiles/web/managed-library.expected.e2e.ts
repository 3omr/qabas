/** Shipped Web profile ownership and storage relocation through the CLI source-launch path. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { generationLogFilename, sessionDir } from '../../../../../packages/session/session-persistence-jsonl/src/format.ts'
import { scanZstdFrames } from '../../../../../packages/session/session-persistence-jsonl/src/zstd.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const binScript = fileURLToPath(new URL('../../../src/bin.ts', import.meta.url))
const observerScript = fileURLToPath(new URL('./fixtures/managed-library.ts', import.meta.url))
const reportPrefix = 'QABAS_MANAGED_LIBRARY '

interface WorkspaceObservation {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

interface Observation {
  readonly before: readonly WorkspaceObservation[]
  readonly after: readonly WorkspaceObservation[]
  readonly created: { readonly sessionId: string; readonly agentPreset: string }
  readonly header: { readonly id: string; readonly cwd: string }
  readonly legacyHeader: { readonly id: string; readonly cwd: string }
  readonly attachmentPath: string
  readonly legacyAttachmentPath: string
  readonly legacyAttachmentContent: string
  readonly errors: Readonly<Record<string, { readonly name: string; readonly code: string }>>
}

function redactedOutput(value: string): string {
  return value.replace(/https?:\/\/[^\s)]+/gu, '[redacted URL]')
}

it('boots one managed library, persists a blank Session there, and preserves legacy Session and attachment bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qabas-web-managed-library-')))
  try {
    const library = join(root, 'library')
    const foreign = join(root, 'foreign')
    const home = join(root, '.dsh')
    await Promise.all([mkdir(library), mkdir(foreign), mkdir(home)])
    // A saved model choice permits a blank Agent; no provider key or request is needed.
    await writeFile(join(home, 'settings.yaml'), 'agent-default-model:\n  provider: google\n  model: gemini-2.5-flash\n')
    const legacyId = SessionId('legacy-library-session')
    const legacySessionRoot = join(home, 'sessions')
    const legacySessionDirectory = sessionDir(legacySessionRoot, foreign, legacyId)
    await mkdir(legacySessionDirectory, { recursive: true })
    const legacyLogName = generationLogFilename(SESSION_FORMAT_VERSION, 'zstd')
    const legacyHeader = {
      type: 'session', version: SESSION_FORMAT_VERSION, id: legacyId, createdAt: 1,
      cwd: foreign, isSeeded: false, delegationDepth: 0,
    }
    const legacyLogBytes = zstdCompressSync(Buffer.from(`${JSON.stringify(legacyHeader)}\n`))
    const legacyLogPath = join(legacySessionDirectory, legacyLogName)
    await writeFile(legacyLogPath, legacyLogBytes)
    const legacyAttachmentBytes = Buffer.from('preserved legacy lecture\n')
    const digest = createHash('sha256').update(legacyAttachmentBytes).digest('hex')
    const legacyAttachment = { attachmentId: `sha256:${digest}`, name: 'legacy.txt', bytes: legacyAttachmentBytes.length }
    const legacyAttachmentRelative = join('files', digest.slice(0, 2), digest, legacyAttachment.name)
    const legacyAttachmentPath = join(home, 'attachments', 'v1', legacyAttachmentRelative)
    await mkdir(join(home, 'attachments', 'v1', 'files', digest.slice(0, 2), digest), { recursive: true })
    await writeFile(legacyAttachmentPath, legacyAttachmentBytes)
    const patchPath = join(root, 'observe.patch.yml')
    await writeFile(patchPath, [
      '- insert:',
      '    - id: managed-library-profile-observer',
      `      name: ${JSON.stringify(observerScript)}`,
      `      config: ${JSON.stringify({ foreignDirectory: foreign, legacySessionId: legacyId, legacyAttachment })}`,
      '',
    ].join('\n'))

    // Source launch is the regression subject: Loader expressions must receive qabasLibraryPath under tsx/esm.
    const child = execa(process.execPath, [
      '--import', 'tsx/esm', binScript, '--profile', 'web', '--patch', patchPath,
      '--host', '127.0.0.1', '--port', '0', '--no-open',
    ], {
      cwd: repoRoot,
      env: {
        DSH_HOME: home,
        TRANSCRIBER_WORKSPACE: library,
        DSH_TELEMETRY_DISABLED: '1',
      },
      timeout: 100_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const output = createInterface({ input: child.stdout })
    try {
      const report = await new Promise<Observation>((resolve, reject) => {
        const deadline = setTimeout(() => {
          reject(new Error(`Web profile did not report managed-library state: ${redactedOutput(stderr)}`))
        }, 90_000)
        const onLine = (line: string): void => {
          if (!line.startsWith(reportPrefix)) return
          clearTimeout(deadline)
          output.off('line', onLine)
          try {
            resolve(JSON.parse(line.slice(reportPrefix.length)) as Observation)
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
        output.on('line', onLine)
        void child.then((result) => {
          clearTimeout(deadline)
          output.off('line', onLine)
          reject(new Error(`Web profile exited before observation: exitCode=${String(result.exitCode)}, signal=${String(result.signal)}, timedOut=${String(result.timedOut)}; ${redactedOutput(stderr)}`))
        })
      })
      child.stdin.end()
      const exit = await child
      expect(exit.timedOut, redactedOutput(stderr)).toBe(false)
      expect(exit.signal, redactedOutput(stderr)).toBeUndefined()
      expect(exit.exitCode, redactedOutput(stderr)).toBe(0)
      expect(report.before).toHaveLength(1)
      expect(report.before[0]).toMatchObject({ path: library, sessionIds: [] })
      expect(report.created.sessionId).toEqual(expect.any(String))
      expect(report.created.agentPreset).toBe('transcriber')
      expect(report.header).toMatchObject({ id: report.created.sessionId, cwd: library })
      expect(report.after).toEqual([{ ...report.before[0], sessionIds: [report.created.sessionId] }])
      expect(report.errors).toEqual({
        rename: { name: 'RemoteError', code: 'workspace/managed' },
        delete: { name: 'RemoteError', code: 'workspace/managed' },
        foreignWorkspace: { name: 'RemoteError', code: 'workspace/managed' },
        foreignSession: { name: 'RemoteError', code: 'workspace/managed' },
      })
      const sessionsRoot = join(library, '.qabas', 'sessions')
      const newLogPath = join(sessionDir(sessionsRoot, library, SessionId(report.created.sessionId)), legacyLogName)
      const compressed = await readFile(newLogPath)
      const { frames, tornStart } = scanZstdFrames(compressed)
      expect(tornStart).toBeUndefined()
      const records = frames.flatMap(({ start, end }) => zstdDecompressSync(compressed.subarray(start, end)).toString().trim().split('\n'))
        .map(line => JSON.parse(line) as Record<string, unknown>)
      expect(records[0]).toMatchObject({ type: 'session', id: report.created.sessionId, cwd: library })
      expect(records.some(record => record.type === 'request/header')).toBe(false)
      const attachmentRoot = join(library, '.qabas', 'attachments', 'v1')
      const attachmentRelative = relative(attachmentRoot, report.attachmentPath)
      expect(isAbsolute(attachmentRelative)).toBe(false)
      expect(attachmentRelative.startsWith('..')).toBe(false)
      expect(await readFile(report.attachmentPath)).toEqual(Buffer.from('managed-library-attachment\n'))
      expect(report.legacyHeader).toMatchObject({ id: legacyId, cwd: foreign })
      const copiedLegacyLog = join(sessionDir(sessionsRoot, foreign, legacyId), legacyLogName)
      expect(await readFile(copiedLegacyLog)).toEqual(legacyLogBytes)
      expect(await readFile(legacyLogPath)).toEqual(legacyLogBytes)
      expect(report.legacyAttachmentPath).toBe(join(attachmentRoot, legacyAttachmentRelative))
      expect(report.legacyAttachmentContent).toBe(legacyAttachmentBytes.toString())
      expect(await readFile(report.legacyAttachmentPath)).toEqual(legacyAttachmentBytes)
      expect(await readFile(legacyAttachmentPath)).toEqual(legacyAttachmentBytes)
      expect((await readdir(legacySessionRoot, { recursive: true })).some(name => name.includes(report.created.sessionId))).toBe(false)
    } finally {
      output.close()
      child.stdin.end()
      child.kill('SIGKILL')
      await child
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
