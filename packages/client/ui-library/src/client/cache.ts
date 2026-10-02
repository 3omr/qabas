/** Versioned browser snapshots, keyed by engine workspace and scoped to this app origin. */
import { z } from 'zod'
import type { LibraryLecture, ModuleContents } from './model.ts'
import type { LibraryState, Loadable } from './service.ts'

const KEY = 'qabas.library.v1'
const lecture = z.object({ title: z.string(), parts: z.number().int().nonnegative(), sources: z.array(z.string()),
  inNotebookOnly: z.boolean(), state: z.enum(['pending', 'verbatim', 'draft', 'final']), transcript: z.string().optional(),
  transcriptTitle: z.string().optional(), draft: z.string().optional(), verbatim: z.string().optional(),
  verbatims: z.array(z.string()).optional(), origin: z.enum(['manual', 'auto']).optional(), id: z.string().optional(),
  materials: z.array(z.string()).optional() })
function lectureFromCache(entry: z.output<typeof lecture>): LibraryLecture {
  const { transcript, transcriptTitle, draft, verbatim, verbatims, origin, id, materials, ...required } = entry
  return { ...required,
    ...transcript === undefined ? {} : { transcript }, ...transcriptTitle === undefined ? {} : { transcriptTitle },
    ...draft === undefined ? {} : { draft }, ...verbatim === undefined ? {} : { verbatim },
    ...verbatims === undefined ? {} : { verbatims }, ...origin === undefined ? {} : { origin },
    ...id === undefined ? {} : { id }, ...materials === undefined ? {} : { materials },
  }
}
const snapshotSchema = z.object({ workspace: z.string(), modules: z.object({ status: z.literal('ready'),
  refreshing: z.boolean(), value: z.array(z.object({ id: z.string(), displayName: z.string(),
    notebooks: z.array(z.string()), root: z.string() })) }),
contents: z.record(z.string(), z.union([
  z.object({ status: z.literal('ready'), refreshing: z.boolean(), value: z.object({ lectures: z.array(lecture),
    materials: z.array(z.object({ name: z.string(), path: z.string() })), warning: z.string().optional(),
    remoteAsOf: z.string().nullable().optional(),
    questionIndex: z.object({ state: z.enum(['built', 'missing', 'stale']), files: z.number().int().nonnegative() }).optional() }) }),
  z.object({ status: z.literal('failed'), message: z.string() }),
])) })

/**
 * Restore the last connected engine workspace immediately; fresh Remote data replaces it.
 * @returns a validated snapshot marked refreshing, or undefined when storage is unavailable or invalid.
 */
export function readLibraryCache(): Partial<LibraryState> | undefined {
  try {
    const workspace = localStorage.getItem(KEY)
    if (workspace === null) return undefined
    const parsed = snapshotSchema.safeParse(JSON.parse(localStorage.getItem(`${KEY}:${workspace}`) ?? 'null'))
    if (!parsed.success || parsed.data.workspace !== workspace) return undefined
    const contents: Record<string, Loadable<ModuleContents>> = {}
    for (const [module, entry] of Object.entries(parsed.data.contents)) {
      if (entry.status === 'failed') { contents[module] = entry; continue }
      const { warning, remoteAsOf, questionIndex } = entry.value
      contents[module] = { status: 'ready', refreshing: true, value: {
        lectures: entry.value.lectures.map(lectureFromCache), materials: entry.value.materials,
        ...warning === undefined ? {} : { warning }, ...remoteAsOf === undefined ? {} : { remoteAsOf },
        ...questionIndex === undefined ? {} : { questionIndex },
      } }
    }
    return { workspace, modules: { ...parsed.data.modules, refreshing: true }, contents }
  } catch {
    // Browser storage and cached JSON are optional; denied access and corrupt entries cannot block engine reads.
    return undefined
  }
}

/**
 * Persist only settled contents for one engine workspace; storage failure leaves live state intact.
 * @param snapshot - current library state.
 */
export function writeLibraryCache(snapshot: LibraryState): void {
  if (snapshot.workspace === undefined || snapshot.modules.status !== 'ready') return
  const contents = Object.fromEntries(Object.entries(snapshot.contents).filter(([, entry]) => entry.status !== 'loading'))
  try {
    localStorage.setItem(`${KEY}:${snapshot.workspace}`, JSON.stringify({ workspace: snapshot.workspace, modules: snapshot.modules, contents }))
    localStorage.setItem(KEY, snapshot.workspace)
  } catch {
    // Storage can be denied or full; the live library remains usable without persistence.
  }
}
