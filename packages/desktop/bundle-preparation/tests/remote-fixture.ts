/** Test-owned signing authority and complete inert review metadata. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import type { RemoteCatalogConfig } from '../src/types.ts'

export const keys = generateKeyPairSync('ed25519')
export const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
export const now = Date.parse('2026-09-13T00:00:00Z')
export const artifactBytes = Buffer.from('reviewed remote fixture bytes')
const guide = { summary: 'Fixture', accounts: 'None', access: 'Harness access', setup: 'Restart after review' }
export const remoteEntry = { id: 'remote', packageName: '@test/remote', version: '1.0.0', title: 'Remote Bundle',
  publisher: 'Fixture', source: 'https://example.com/source', details: { license: 'MIT', en: guide, ar: guide },
  harnessVersions: ['fixture-host'], platforms: [`${process.platform}-${process.arch}`],
  artifact: { file: 'remote.tgz', size: artifactBytes.length, sha256: createHash('sha256').update(artifactBytes).digest('hex') } }
export const publication = { schemaVersion: 1, channel: 'fixture', revision: 1, issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(), artifactBaseUrl: 'https://example.com/bundles/',
  catalog: { schemaVersion: 1, entries: [remoteEntry] } }

export function signed(value: unknown = publication): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  return Buffer.from(JSON.stringify({ schemaVersion: 1, payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }))
}

export function remoteConfig(cacheFile: string): RemoteCatalogConfig {
  return { url: 'https://example.com/catalog.signed.json', channel: 'fixture', publicKeys: [publicKey], cacheFile,
    allowedOrigins: ['https://example.com'], timeoutMs: 5_000, lockWaitMs: 5_000, maxEnvelopeBytes: 65_536,
    maxValidityMs: 86_400_000, clockSkewMs: 1_000 }
}
