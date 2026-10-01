/**
 * The editor's file access over the transcriber engine's session-free calls,
 * and where a link written in a note points.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { NoteFiles, NoteOutcome } from './service.ts'

/** The engine's session-free file calls, as this package uses them. */
type EngineFiles = Pick<ClientRemote['transcriberEngine'], 'readFile' | 'readFileBytes' | 'writeFile'>

/**
 * The engine sends file bytes as base64 over the JSON carrier.
 * @param base64 - the encoded bytes.
 * @returns the raw bytes.
 */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function outcome<T, U>(answer: RemoteResult<T>, map: (value: T) => U): NoteOutcome<U> {
  if (answer.ok) return { ok: true, value: map(answer.value) }
  return { ok: false, conflict: /conflict/iu.test(answer.error.code), message: answer.error.message }
}

/**
 * Adapt the engine's file calls to the editor's.
 * @param engine - the transcriber-engine Remote.
 * @returns the editor's file access.
 */
export function engineNoteFiles(engine: EngineFiles): NoteFiles {
  const guard = async <T>(call: () => Promise<NoteOutcome<T>>): Promise<NoteOutcome<T>> => {
    try {
      return await call()
    } catch (error: unknown) {
      // The Remote face folds carrier failures into its error branch; only an
      // assembly fault rejects, and the panel reports it the same way.
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }
  return {
    read: (path, signal) => guard(async () => outcome(await engine.readFile({ path }, signal), value => value)),
    readBytes: (path, relativeTo, signal) => guard(async () => outcome(
      await engine.readFileBytes({ path, ...relativeTo === undefined ? {} : { relativeTo } }, signal),
      value => decodeBase64(value.bytes),
    )),
    write: (path, text, expectedVersion, signal) => guard(async () => outcome(
      await engine.writeFile({ path, text, expectedVersion }, signal),
      value => ({ version: value.version }),
    )),
  }
}

/**
 * Where a link written in a note points: a relative `.md` path, or a
 * `[[wikilink]]` naming a note beside this one.
 * @param target - the link as written.
 * @param from - the note it was written in.
 * @returns the absolute path to open.
 */
export function linkTarget(target: string, from: string): string {
  const withoutAnchor = target.split('#')[0] ?? target
  const file = /\.[A-Za-z0-9]+$/u.test(withoutAnchor) ? withoutAnchor : `${withoutAnchor}.md`
  if (file.startsWith('/')) return file
  const folder = from.slice(0, Math.max(from.lastIndexOf('/'), 0))
  const parts = `${folder}/${file}`.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return `/${resolved.join('/')}`
}
