/** Strict parsing of the deployment-owned review record, without executable imports. */
import { z } from 'zod'
import type { ReviewedBundle, BundleCatalogId } from './types.ts'

const nonempty = z.string().trim().min(1)
const guideSchema = z.strictObject({ summary: nonempty, accounts: nonempty, access: nonempty, setup: nonempty })
const entrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  packageName: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  version: nonempty,
  title: nonempty,
  publisher: nonempty,
  source: z.url().refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  }, 'source must be an HTTPS URL without credentials'),
  details: z.strictObject({ license: nonempty, en: guideSchema, ar: guideSchema }).nullable(),
  harnessVersions: z.array(nonempty).min(1),
  platforms: z.array(z.enum(['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'])).min(1),
  artifact: z.strictObject({
    file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
})
const catalogSchema = z.strictObject({ schemaVersion: z.literal(1), entries: z.array(entrySchema) })

/**
 * Parse one complete catalog and reject duplicate identities or artifact names.
 * @param bytes - bounded UTF-8 JSON input from the deployment-owned file.
 * @returns Reviewed entries; the parser does not independently attest the publisher or review.
 */
export function parseCatalog(bytes: Uint8Array): readonly ReviewedBundle[] {
  const parsed = catalogSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  const ids = new Set<string>()
  const files = new Set<string>()
  return parsed.entries.map((entry) => {
    if (ids.has(entry.id)) throw new Error(`bundle catalog: duplicate id ${entry.id}`)
    if (files.has(entry.artifact.file)) throw new Error(`bundle catalog: duplicate artifact ${entry.artifact.file}`)
    ids.add(entry.id)
    files.add(entry.artifact.file)
    return { ...entry, id: entry.id as BundleCatalogId }
  })
}
