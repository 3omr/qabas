/**
 * Reading the workspace layout, against a scripted Remote.
 *
 * The layout under test is the engine's own: `modules/<id>/module.json`,
 * `Lecture/` read recursively, `Transcripts/` read flat. What matters is which
 * paths are asked for, what a missing folder means, and that a failure that is
 * not a missing folder is passed on rather than shown as an empty workspace.
 */
import { describe, expect, it, vi } from 'vitest'
import type { TranscriberLectureListing } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createReadModules } from '../src/client/workspace.ts'
import type { ModuleView, TranscriberRemote } from '../src/client/workspace.ts'

const SESSION = 'session-1' as SessionId

type Entry = { name: string; type: 'file' | 'directory' }

/** A Remote over a literal directory map; anything unlisted is not found. */
function remoteOver(
  tree: Record<string, Entry[]>,
  files: Record<string, string> = {},
  listings?: Record<string, TranscriberLectureListing | undefined>,
) {
  const list = vi.fn(async (_session: SessionId, path: string) => {
    const entries = tree[path]
    if (entries === undefined) {
      return { ok: false as const, error: { code: 'workspace-file/not-found', message: path } }
    }
    return { ok: true as const, value: { path, entries, truncated: false } }
  })
  const read = vi.fn(async (_session: SessionId, path: string) => {
    const text = files[path]
    if (text === undefined) {
      return { ok: false as const, error: { code: 'workspace-file/not-found', message: path } }
    }
    return { ok: true as const, value: { text } }
  })
  const workspaceFiles = { list, read }
  const transcriberEngine = listings === undefined
    ? undefined
    : { listLectures: vi.fn(async ({ module }: { module: string }) => ({
      ok: true as const,
      value: listings[module] ?? { module, lectures: [], materials: [] },
    })) }
  const remote = {
    workspaceFiles,
    ...transcriberEngine === undefined ? {} : { transcriberEngine },
  } as unknown as TranscriberRemote
  return { remote, workspaceFiles, list, read, transcriberEngine }
}

const dir = (name: string): Entry => ({ name, type: 'directory' })
const file = (name: string): Entry => ({ name, type: 'file' })

describe('createReadModules', () => {
  it('reads an empty workspace as no modules rather than as a failure', async () => {
    // A freshly chosen folder is the normal first screen of setup.
    const { remote } = remoteOver({})
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: [] })
  })

  it('takes a module\'s name from module.json and its lectures from the two folders', async () => {
    const { remote } = remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json'), dir('Lecture'), dir('Transcripts')],
      'modules/toxo/Lecture': [file('Corrosives Part 1.mp3'), file('Corrosives Part 2.mp3'), file('slides.pptx')],
      'modules/toxo/Transcripts': [file('Corrosives.md'), file('Index.md')],
    }, { 'modules/toxo/module.json': '{"display_name": "Toxicology"}' })
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result).toEqual({
      ok: true,
      value: [{
        id: 'toxo',
        displayName: 'Toxicology',
        lectures: [{
          title: 'Corrosives',
          sources: [
            { name: 'Corrosives Part 1.mp3', path: 'modules/toxo/Lecture/Corrosives Part 1.mp3' },
            { name: 'Corrosives Part 2.mp3', path: 'modules/toxo/Lecture/Corrosives Part 2.mp3' },
          ],
          transcribed: true,
          inNotebookOnly: false,
        }],
        notebookStatus: 'unavailable',
        questionFileExists: false,
      }],
    })
  })

  it('attaches the newest cached run to its module view', async () => {
    const runPath = 'modules/toxo/.transcriber-cache/runs/lecture-20260917054201/events.ndjson'
    const result = await createReadModules(remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json'), dir('Lecture'), dir('Transcripts')],
      'modules/toxo/Lecture': [file('Heavy Metals.mp3')],
      'modules/toxo/Transcripts': [],
      'modules/toxo/.transcriber-cache/runs': [dir('lecture-20260917054201')],
    }, {
      'modules/toxo/module.json': '{"display_name":"Toxicology"}',
      [runPath]: [
        '{"event":"init","run_id":"r1","title":"Heavy Metals attempt","run_dir":"r1","phases":["guide","imp"],"labels":{"guide":"Guide","imp":"Important"}}',
        '{"event":"phase","phase":"guide","state":"running","label":"Guide"}',
      ].join('\n'),
    }).remote).call(null, SESSION, new AbortController().signal)

    expect(result.ok && result.value[0]?.run).toMatchObject({
      title: 'Heavy Metals attempt',
      done: [],
      running: ['guide'],
      finished: false,
    })
  })

  it('falls back to the folder name when module.json cannot be parsed', async () => {
    const { remote } = remoteOver({
      modules: [dir('radio')],
      'modules/radio': [file('module.json')],
    }, { 'modules/radio/module.json': 'not json at all' })
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result.ok && result.value[0]?.displayName).toBe('radio')
  })

  it('skips a folder with no module.json, exactly as the engine does', async () => {
    const { remote } = remoteOver({
      modules: [dir('Figures'), dir('toxo')],
      'modules/Figures': [file('a.png')],
      'modules/toxo': [file('module.json')],
    })
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result.ok && result.value.map(view => view.id)).toEqual(['toxo'])
  })

  it('skips a dot folder', async () => {
    const { remote } = remoteOver({
      modules: [dir('.obsidian')],
      'modules/.obsidian': [file('module.json')],
    })
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result.ok && result.value).toEqual([])
  })

  it('walks nested recording folders', async () => {
    const { remote } = remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json')],
      'modules/toxo/Lecture': [dir('week1')],
      'modules/toxo/Lecture/week1': [file('Heavy Metals.m4a')],
    })
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result.ok && result.value[0]?.lectures[0]?.sources[0]?.path)
      .toBe('modules/toxo/Lecture/week1/Heavy Metals.m4a')
  })

  it('publishes the disk half before merging NotebookLM-only lectures', async () => {
    const harness = remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json'), dir('Lecture'), dir('Transcripts')],
      'modules/toxo/Lecture': [file('Corrosives.mp3')],
      'modules/toxo/Transcripts': [],
    }, { 'modules/toxo/module.json': '{"display_name":"Toxicology"}' }, {
      toxo: {
        module: 'toxo',
        lectures: [
          {
            title: 'Notebook lecture', recording_sources: ['Notebook lecture.m4a'], paths: [],
            parts: 1, transcribed: false, in_notebook_only: true,
          },
          {
            title: 'Corrosives', recording_sources: ['Corrosives.mp3'], paths: ['/workspace/Corrosives.mp3'],
            parts: 1, transcribed: false, in_notebook_only: false,
          },
        ],
        materials: [],
      },
    })
    const phases: ModuleView[][] = []
    const result = await createReadModules(harness.remote)(SESSION, new AbortController().signal, {
      onDisk: (modules) => { phases.push([...modules]) },
    })

    expect(phases[0]?.[0]?.notebookStatus).toBe('pending')
    expect(result.ok && result.value[0]?.notebookStatus).toBe('ready')
    expect(result.ok && result.value[0]?.lectures.map(lecture => [
      lecture.title, lecture.sources.length, lecture.inNotebookOnly,
    ])).toEqual([
      ['Notebook lecture', 0, true],
      ['Corrosives', 1, false],
    ])
  })

  it('keeps the disk half and warning when NotebookLM is unreachable', async () => {
    const harness = remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json'), dir('Lecture'), dir('Transcripts')],
      'modules/toxo/Lecture': [file('Corrosives.mp3')],
      'modules/toxo/Transcripts': [],
    }, { 'modules/toxo/module.json': '{"display_name":"Toxicology"}' }, {
      toxo: { module: 'toxo', lectures: [], materials: [] },
    })
    harness.transcriberEngine?.listLectures.mockResolvedValue({
      ok: false,
      error: { code: 'gateway/internal', message: 'NotebookLM timed out' },
    } as never)
    const result = await createReadModules(harness.remote)(SESSION, new AbortController().signal)

    expect(result.ok).toBe(true)
    expect(result.ok && result.value[0]?.lectures.map(lecture => lecture.title)).toEqual(['Corrosives'])
    expect(result.ok && result.value[0]?.notebookStatus).toBe('failed')
    expect(result.ok && result.value[0]?.notebookWarning).toBe('NotebookLM timed out')
  })

  it('passes on a failure that is not a missing folder instead of showing an empty workspace', async () => {
    // Reporting a permission failure as "no modules yet" would send the reader
    // off to create modules they already have.
    const { remote, workspaceFiles } = remoteOver({})
    workspaceFiles.list = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'gateway/internal', message: 'connection lost' },
    }))
    const result = await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(result).toEqual({ ok: false, error: { code: 'gateway/internal', message: 'connection lost' } })
  })

  it('never writes: only list and read are ever called', async () => {
    const { remote, workspaceFiles, list, read } = remoteOver({
      modules: [dir('toxo')],
      'modules/toxo': [file('module.json')],
    }, { 'modules/toxo/module.json': '{"display_name":"Toxicology"}' })
    await createReadModules(remote).call(null, SESSION, new AbortController().signal)
    expect(list).toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith(SESSION, 'modules/toxo/module.json', {}, expect.anything())
    expect(Object.keys(workspaceFiles)).toEqual(['list', 'read'])
  })
})
