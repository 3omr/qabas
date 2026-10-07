/** Original-preserving relocation remains readable through the attachment provider. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LocalAttachmentStore } from '../src/index.ts'

it.each(['notes.txt', 'tmp', 'session.lock', '.qabas-copy-user.json'])(
  'reads a legacy attachment named %s before returning from its first store operation', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'qabas-attachment-relocation-'))
    try {
      const original = new LocalAttachmentStore(new Context(), { dshHome: join(root, 'legacy') })
      const ref = await original.saveFile({ name, data: Buffer.from('medical notes') })
      const path = original.fileHostPath(ref)
      const relocated = new LocalAttachmentStore(new Context(), { dshHome: join(root, 'library'), migrateFrom: join(root, 'legacy') })
      const chunks: Uint8Array[] = []
      for await (const chunk of relocated.readFileStream(ref)) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString()).toBe('medical notes')
      expect(await readFile(path, 'utf8')).toBe('medical notes')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
