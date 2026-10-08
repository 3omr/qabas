/** Session-free lecture registry edits and temporary browser-file intake. */

import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { cancelled, isAborted, type TranscriberDoctorInternals } from './doctor.ts'
import { engineWorkspacePath } from './workspace.ts'
import { parseMcpToolOutput, runMcpTool } from './mcp.ts'
import type { TranscriberImportFileRequest, TranscriberImportFileResult, TranscriberMcpConfig } from './types.ts'

const moduleId = z.string().min(1).refine(name => !/[\\/:]/u.test(name) && name !== '.' && name !== '..')
const fileName = z.string().min(1).refine(name => !/[\\/:]/u.test(name) && name !== '.' && name !== '..')
const localPath = z.string().min(1).refine(path => !/^[\\/]|[:\\\0]/u.test(path) && !path.split('/').includes('..'))
const trashId = z.string().regex(/^[A-Za-z0-9_-]+$/u)
const removedAt = z.iso.datetime({ offset: true })
const transcriptKind = z.enum(['final', 'draft', 'verbatim'])
const kind = z.enum(['recording', 'material', 'question'])
const origin = z.enum(['manual', 'auto'])
const size = z.number().int().nonnegative()
const examLocatorPart = z.union([
  z.object({ type: z.literal('page'), page: z.number().int().positive() }),
  z.object({ type: z.literal('line'), line: z.number().int().positive() }),
  z.object({ type: z.literal('spreadsheet_row'), sheet: z.string(), row: z.number().int().positive(), range: z.string() }),
  z.object({ type: z.literal('paragraph'), paragraph: z.number().int().positive() }),
  z.object({ type: z.literal('table_row'), table: z.number().int().positive(), row: z.number().int().positive() }),
])
const examLocator = z.union([examLocatorPart, z.object({ type: z.literal('multiple'), items: z.array(examLocatorPart).min(1) })])
const examQuestion = z.object({
  id: z.string().min(1), number: z.number().int().nullable(), kind: z.enum(['mcq', 'written']),
  stem: z.string(), options: z.record(z.string(), z.string()), answer: z.string().nullable(),
  source_answer: z.string().nullable(), explanation: z.string(), section: z.string(),
  year: z.number().int().nullable(), topic: z.string().nullable(), locator: examLocator.nullable(),
  needs_review: z.boolean(), review_reason: z.string().nullable(),
})

/** Wire requests admitted before starting an engine process. */
export const editingRequests = {
  getEngineSettings: z.object({}),
  setEngineSettings: z.object({ web_figures: z.boolean() }),
  removeTranscript: z.object({ module: moduleId, lecture: z.string().trim().min(1),
    kinds: z.array(transcriptKind).min(1).refine(kinds => new Set(kinds).size === kinds.length) }),
  removeModule: z.object({ module: moduleId }),
  restoreModule: z.object({ trashId }),
  listRemovedModules: z.object({}),
  listTrash: z.object({ module: moduleId }),
  restoreTrash: z.object({ module: moduleId, id: trashId }),
  listModuleFiles: z.object({ module: moduleId, refresh: z.boolean().optional() }),
  proposeOrganization: z.object({ module: moduleId, refresh: z.boolean().optional() }),
  applyOrganization: z.object({
    module: moduleId,
    lectures: z.array(z.object({ title: z.string().min(1),
      recordings: z.array(localPath), materials: z.array(localPath), id: z.string().min(1).optional() })),
    replaceExisting: z.boolean(),
    general: z.array(localPath).optional(),
  }),
  prepareExamFile: z.object({ module: moduleId, path: localPath }),
  buildExamIndex: z.object({ module: moduleId }),
  listExamQuestions: z.object({ module: moduleId, path: localPath, offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(10).optional(), query: z.string().max(200).optional() }),
  defineLecture: z.object({ module: moduleId, title: z.string().min(1), recordings: z.array(localPath),
    materials: z.array(localPath), id: z.string().min(1).optional() }),
  setGeneralMaterials: z.object({ module: moduleId, materials: z.array(localPath) }),
  hideLecture: z.object({ module: moduleId, title: z.string().trim().min(1) }),
  restoreRecordings: z.object({ module: moduleId, recordings: z.array(localPath).min(1) }),
  deleteLecture: z.object({ module: moduleId, id: z.string().min(1) }),
  importFile: z.object({ module: moduleId, name: fileName, kind, bytes: z.string(), replace: z.boolean().optional() }),
  renameFile: z.object({ module: moduleId, path: localPath, new_name: fileName }),
  removeFile: z.object({ module: moduleId, path: localPath }),
  uploadRecordings: z.object({ module: moduleId, files: z.array(localPath).min(1) }),
}

/** Engine results validated before crossing the Remote transport. */
export const editingResults = {
  engineSettings: z.object({ web_figures: z.boolean() }),
  removeTranscript: z.object({ module: moduleId, id: trashId, paths: z.array(localPath).min(1) }),
  removeModule: z.object({ module: moduleId, trash_id: trashId, notebook_untouched: z.literal(true) }),
  restoreModule: z.object({ module: moduleId, notebook_untouched: z.literal(true) }),
  listRemovedModules: z.array(z.object({ module: moduleId, trash_id: trashId, display_name: z.string(), removed_at: removedAt })),
  listTrash: z.array(z.object({ id: trashId, removed_at: removedAt, kind: z.enum(['file', 'transcript', 'lecture']),
    label: z.string(), paths: z.array(localPath).min(1) })),
  restoreTrash: z.object({ module: moduleId, id: trashId, paths: z.array(localPath).min(1) }),
  listModuleFiles: z.object({
    module: z.string(),
    remote_as_of: z.string().nullable().optional(),
    files: z.array(z.object({ path: localPath, name: z.string(), size_bytes: size, kind,
      lectures: z.array(z.object({ id: z.string().nullable(), title: z.string(), origin })), in_notebook: z.boolean().nullable(),
      general: z.boolean().optional(), hidden: z.boolean().optional(),
      indexed: z.boolean().optional(), question_count: size.optional(),
      question_review_count: size.optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      preparation: z.enum(['pending', 'ready', 'failed']).optional(), preparation_error: z.string().optional() })),
    warning: z.string().optional(),
  }),
  defineLecture: z.object({ id: z.string(), title: z.string(), recordings: z.array(z.string()),
    materials: z.array(z.string()), created: z.string(), updated: z.string() }),
  setGeneralMaterials: z.object({ module: z.string(), general_materials: z.array(localPath) }),
  proposeOrganization: z.object({ source: z.enum(['agy', 'automatic']), lectures: z.array(z.object({
    title: z.string().min(1), recordings: z.array(localPath), materials: z.array(localPath),
    existing_id: z.string().optional(), change: z.enum(['new', 'same', 'changed']),
  })), unassigned: z.object({ recordings: z.array(localPath), materials: z.array(localPath) }), notes: z.array(z.string()),
  general: z.array(localPath).optional() }),
  applyOrganization: z.object({ module: z.string(), lectures: z.array(z.object({
    id: z.string(), title: z.string(), recordings: z.array(z.string()), materials: z.array(z.string()),
    created: z.string(), updated: z.string(),
  })) }),
  prepareExamFile: z.object({ path: localPath, status: z.enum(['ready', 'failed']), message: z.string().optional() }),
  buildExamIndex: z.object({ output: z.string().min(1) }),
  listExamQuestions: z.object({ module: moduleId, path: localPath, sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    query: z.string(), offset: z.number().int().nonnegative(), limit: z.number().int().positive(), total: z.number().int().nonnegative(),
    questions: z.array(examQuestion), next_offset: z.number().int().nonnegative().nullable() }),
  hideLecture: z.object({ module: moduleId, recordings: z.array(localPath).min(1) }),
  restoreRecordings: z.object({ module: moduleId, recordings: z.array(localPath) }),
  deleteLecture: z.object({ deleted: z.string() }),
  importFile: z.object({ path: z.string(), kind, size_bytes: size }),
  renameFile: z.object({ path: z.string() }),
  removeFile: z.object({ trash_path: z.string() }),
  uploadRecordings: z.object({ module: z.string(), notebook: z.object({ id: z.string(), title: z.string() }), status: z.enum(['ready', 'processing']), next: z.string(),
    files: z.array(z.object({ path: z.string(), name: z.string(), size_bytes: size, size_mb: z.number().nonnegative(),
      status: z.enum(['uploaded', 'already-uploaded', 'processing', 'not-ready']), ready: z.boolean().optional(),
      source_id: z.string().optional(), message: z.string().optional(), error: z.string().optional() })),
  }),
}

/** Host process dependencies and intake size limit resolved from plugin configuration. */
export interface EditingOptions {
  readonly internals: TranscriberDoctorInternals
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly config: TranscriberMcpConfig & { readonly maxImportBytes: number }
}

function badRequest(detail: string): RemoteError<'gateway/bad-request'> {
  return new RemoteError('gateway/bad-request', detail, {})
}

function inside(parent: string, path: string): boolean {
  const child = relative(parent, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function moduleRoot(module: string, internals: TranscriberDoctorInternals): Promise<string> {
  const workspace = await realpath(resolve(engineWorkspacePath(internals.environment)))
  const modules = resolve(workspace, 'modules')
  const root = await realpath(resolve(modules, module))
  if (!inside(workspace, root) || !inside(modules, root)) throw badRequest('Module resolves outside modules/')
  if (!(await stat(join(root, 'module.json'))).isFile()) throw badRequest('Module has no module.json')
  return root
}

function modulePath(root: string, path: string): string {
  const absolute = resolve(root, path)
  if (!inside(root, absolute)) throw badRequest('Engine result path escapes the module')
  return relative(root, absolute).split(sep).join('/')
}

function editUnavailable(error: unknown): never {
  if (error instanceof RemoteError) throw error
  const detail = error instanceof Error ? error.message : String(error)
  throw new RemoteError('transcriber-engine/edit-unavailable', `Lecture edit could not complete: ${detail}`, { detail })
}

/**
 * Execute a registry operation against an existing contained module.
 * @param call - tool name, request schema, result schema, and student-selected arguments.
 * @param signal - Remote cancellation passed to the subprocess provider.
 * @param options - Host filesystem, process, and capture configuration.
 * @returns the validated engine answer, with file paths made module-relative.
 */
export async function runEditingTool<I extends object, O>(
  call: {
    readonly tool: string
    readonly request: unknown
    readonly input: z.ZodType<I>
    readonly output: z.ZodType<O>
    readonly timeoutMs?: number
    readonly textResult?: boolean
  },
  signal: AbortSignal,
  options: EditingOptions,
): Promise<O> {
  const parsed = call.input.safeParse(call.request)
  if (!parsed.success) throw badRequest(parsed.error.message)
  if (isAborted(signal)) throw cancelled()
  try {
    const arguments_ = { ...parsed.data } as Record<string, unknown>
    const root = typeof arguments_.module === 'string'
      ? await moduleRoot(arguments_.module, options.internals) : engineWorkspacePath(options.internals.environment)
    if (call.tool === 'restore_module') {
      arguments_.trash_id = arguments_.trashId
      delete arguments_.trashId
    }
    if (call.tool !== 'set_general_materials') arguments_.confirmed = true
    if (call.tool === 'apply_organization') {
      arguments_.replace_existing = arguments_.replaceExisting
      delete arguments_.replaceExisting
    }
    const output = await runMcpTool({ toolName: call.tool, arguments: arguments_, signal,
      ...call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs },
      internals: options.internals, spawn: options.spawn,
      outputMaxBytes: options.config.mcpOutputMaxBytes, graceMs: options.config.mcpGraceMs })
    const invalid = (detail: string): RemoteError<'transcriber-engine/invalid-edit-result'> =>
      new RemoteError('transcriber-engine/invalid-edit-result', `Invalid ${call.tool} result: ${detail}`, { tool: call.tool, detail })
    const response = parseMcpToolOutput(output, invalid, 'Engine rejected the lecture edit')
    if (response.error !== undefined || response.isError) {
      const detail = response.error ?? response.text ?? 'Engine rejected the lecture edit'
      throw new RemoteError('transcriber-engine/edit-rejected', detail, { tool: call.tool, detail })
    }
    let decoded: unknown
    try { decoded = call.textResult ? { output: response.text ?? '' } : JSON.parse(response.text ?? '') as unknown } catch (error: unknown) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
    const result = call.output.safeParse(decoded)
    if (!result.success) throw invalid(result.error.message)
    // Import and rename results contain absolute engine paths; inventory paths are already relative.
    if (typeof result.data === 'object' && result.data !== null && 'path' in result.data && typeof result.data.path === 'string') {
      return { ...result.data, path: modulePath(root, result.data.path) }
    }
    return result.data
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    return editUnavailable(error)
  }
}

/**
 * Stage canonical browser bytes for the engine's `import_file` operation.
 * @param request - original name, kind, module, and base64 contents.
 * @param signal - cancellation before import or during the engine process.
 * @param options - intake cap and process configuration.
 * @returns the imported module-relative path and engine-reported size and kind.
 */
export async function runImportFile(
  request: TranscriberImportFileRequest,
  signal: AbortSignal,
  options: EditingOptions,
): Promise<TranscriberImportFileResult> {
  const parsed = editingRequests.importFile.safeParse(request)
  if (!parsed.success) throw badRequest(parsed.error.message)
  if (isAborted(signal)) throw cancelled()
  const { bytes, ...fields } = parsed.data
  if (bytes.length > 4 * Math.ceil(options.config.maxImportBytes / 3)) throw badRequest('Import exceeds maxImportBytes')
  const contents = Buffer.from(bytes, 'base64')
  if (contents.toString('base64') !== bytes) throw badRequest('Import bytes must be canonical base64')
  if (contents.length > options.config.maxImportBytes) throw badRequest('Import exceeds maxImportBytes')
  let directory: string | undefined
  try {
    await moduleRoot(fields.module, options.internals)
    directory = await mkdtemp(join(tmpdir(), 'qabas-import-'))
    const source = join(directory, fields.name)
    await writeFile(source, contents, { signal, flag: 'wx', mode: 0o600 })
    return await runEditingTool({ tool: 'import_file', request: { ...fields, source_path: source },
      input: editingRequests.importFile.omit({ bytes: true }).extend({ source_path: z.string() }),
      output: editingResults.importFile }, signal, options)
  } catch (error: unknown) {
    if (isAborted(signal)) throw cancelled()
    return editUnavailable(error)
  } finally {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch(editUnavailable)
  }
}
