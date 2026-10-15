import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_MANIFEST_VERSION,
  extendArchiveManifest,
  parseArchiveManifest,
  renderArchiveManifest,
  validateArchiveArtifacts,
  validateArchiveManifestExtension,
  type ArchiveManifest,
} from './archived-agent-notes.ts'
import { isArchivedAgentNotePath } from './repo-files.ts'

const NOTE = 'process/2026-07-26-example.md'

function fixture(): Map<string, Buffer> {
  return new Map([
    [NOTE, Buffer.from('# Agent Note: Example\n\nStatus: implemented\nArchived: 2026-07-26\n\n## Problem\n\nExample.\n')],
  ])
}

function current(files: Readonly<Record<string, string>>): ArchiveManifest {
  return { version: ARCHIVE_MANIFEST_VERSION, files }
}

describe('archived Agent Notes', () => {
  it('recognizes archived paths with POSIX and Windows separators', () => {
    expect(isArchivedAgentNotePath('.agents/notes/archived/process/example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents\\notes\\archived\\process\\example.md')).toBe(true)
    expect(isArchivedAgentNotePath('.agents/notes/implemented/process/example.md')).toBe(false)
  })

  it('accepts an implemented note with matching archive metadata', () => {
    expect(validateArchiveArtifacts(fixture())).toEqual([])
  })

  it('rejects translated artifacts and invalid archive headers', () => {
    const artifacts = fixture()
    artifacts.set('process/2026-07-26-example.zh.md', Buffer.from('# Agent Note: Example\n'))
    artifacts.set('process/2026-07-26-example.i18n.yaml', Buffer.from(''))
    artifacts.set(NOTE, Buffer.from('# Agent Note: Example\n\nStatus: proposed\nArchived: yesterday\n'))
    const errors = validateArchiveArtifacts(artifacts)
    expect(errors).toContain('process/2026-07-26-example.zh.md: expected {kind}/yyyy-mm-dd-topic.md')
    expect(errors).toContain('process/2026-07-26-example.i18n.yaml: expected {kind}/yyyy-mm-dd-topic.md')
    expect(errors).toContain(`${NOTE}: line 3 must be \`Status: implemented\``)
    expect(errors).toContain(`${NOTE}: line 4 must be \`Archived: YYYY-MM-DD\` with a valid date`)
  })

  it('extends the manifest without permitting a sealed change or removal', () => {
    const artifacts = fixture()
    const first = extendArchiveManifest(current({}), artifacts)
    expect(first.errors).toEqual([])
    expect(first.added).toEqual([NOTE])

    const changed = new Map(artifacts)
    changed.set(NOTE, Buffer.from('changed'))
    expect(extendArchiveManifest(current(first.files), changed).errors).toEqual([`${NOTE}: sealed content hash changed`])
    changed.delete(NOTE)
    expect(extendArchiveManifest(current(first.files), changed).errors).toContain(`${NOTE}: sealed artifact is missing`)
  })

  it('rejects replacing manifest seals alongside changed archive content', () => {
    const artifacts = fixture()
    const baseline = current(extendArchiveManifest(current({}), artifacts).files)
    const changedArtifacts = new Map(artifacts)
    changedArtifacts.set(NOTE, Buffer.from('changed'))
    const replaced = current(extendArchiveManifest(current({}), changedArtifacts).files)

    expect(extendArchiveManifest(replaced, changedArtifacts).errors).toEqual([])
    expect(validateArchiveManifestExtension(baseline, replaced)).toEqual([`${NOTE}: sealed manifest hash changed`])
    expect(validateArchiveManifestExtension(baseline, current({}))).toContain(`${NOTE}: sealed manifest entry is missing`)
  })

  it('re-seals the archive once when the format version is bumped', () => {
    const triplet = { [NOTE]: `sha256:${'a'.repeat(64)}`, 'process/2026-07-26-example.zh.md': `sha256:${'b'.repeat(64)}` }
    expect(validateArchiveManifestExtension({ version: 1, files: triplet }, current({ [NOTE]: `sha256:${'c'.repeat(64)}` }))).toEqual([])
    expect(validateArchiveManifestExtension(current({}), { version: 1, files: {} }))
      .toEqual([`manifest version 1 is not the current version ${ARCHIVE_MANIFEST_VERSION}`])
  })

  it('round-trips the deterministic manifest schema', () => {
    const content = renderArchiveManifest({ 'process/z.md': `sha256:${'a'.repeat(64)}` })
    expect(parseArchiveManifest(content)).toEqual(current({ 'process/z.md': `sha256:${'a'.repeat(64)}` }))
  })
})
