/** Reviewed catalog identities and artifact preparation results. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Catalog-owned identifier, resolved before accessing any file. */
export type BundleCatalogId = Branded<'BundleCatalogId'>

/** Digest binding installation consent to the displayed metadata and catalog revision. */
export type BundleReviewToken = Branded<'BundleReviewToken'>

/** Deployment-pinned trust and resource limits for one signed HTTPS catalog channel. */
export interface RemoteCatalogConfig {
  /** Pinned HTTPS envelope URL without credentials, query or fragment. */
  url: string
  /** Exact signed channel identity selected by the deployment. */
  channel: string
  /** Trusted Ed25519 public keys in PEM format; never private keys. */
  publicKeys: string[]
  /** Absolute deployment-owned cache file retaining the latest verified revision. */
  cacheFile: string
  /** Exact HTTPS origins permitted for the catalog and artifact directory. */
  allowedOrigins: string[]
  /** Complete network response deadline in milliseconds, including streamed body reads. */
  timeoutMs: number
  /** Maximum milliseconds waiting for another cache writer; orphaned locks need operator recovery. */
  lockWaitMs: number
  /** Maximum complete signed-envelope bytes. */
  maxEnvelopeBytes: number
  /** Maximum signed validity interval in milliseconds. */
  maxValidityMs: number
  /** Allowed future issuance skew in milliseconds; expiry receives no grace. */
  clockSkewMs: number
}

/** Catalog observations do not imply installation or runtime readiness. */
export interface BundleCatalogStatus {
  readonly source: 'bundled' | 'online' | 'cached' | 'unavailable'
  readonly remoteConfigured: boolean
  readonly revision: number | null
  readonly expiresAt: string | null
}

/** Identity of one preparation attempt, never a path or activation grant. */
export type BundleOperationId = Branded<'BundleOperationId'>

/** One configured Profile layer; a null version means its Bundle metadata could not be verified. */
export interface ProfileBundle {
  readonly packageName: string
  readonly version: string | null
  /** A direct dependency resolved inside this Profile, not an installation-owned or external package. */
  readonly removable: boolean
}

/** Preparation stage requested by a consumer. */
export type PreparationKind = 'artifact' | 'dependencies' | 'composition' | 'removal'

/** Journal observation; unsettled does not prove a process has stopped. */
export interface PreparationOperation {
  readonly id: BundleOperationId
  readonly state: 'preparing' | 'unsettled' | 'prepared' | 'failed' | 'unreadable' | 'unavailable'
  readonly entry?: { readonly id: BundleCatalogId; readonly packageName: string; readonly version: string; readonly title: string }
  readonly removed?: { readonly packageName: string; readonly version: string }
  readonly kind?: PreparationKind
  readonly startedAt?: string
  readonly preparedState?: PreparedBundle['state'] | PreparedDependencies['state'] | PreparedComposition['state'] | PreparedRemoval['state']
}

/** Bounded local operation history, independent of disposable candidate directories. */
export interface JournalConfig {
  /** Absolute deployment-owned directory outside staging and source Profiles. */
  directory: string
  /** Maximum directory entries accepted by one history read. */
  maxEntries: number
  /** Maximum bytes for one metadata record or checked preparation receipt. */
  maxRecordBytes: number
}

/** Plain-text guidance supplied by the catalog reviewer, not executable setup or a permission grant. */
export interface BundleGuide {
  readonly summary: string
  readonly accounts: string
  readonly access: string
  readonly setup: string
}

/** Bilingual review guidance; the license describes the Bundle, not all transitive dependencies. */
export interface BundleDetails {
  readonly license: string
  readonly en: BundleGuide
  readonly ar: BundleGuide
}

/** One reviewed npm tarball; declarations do not grant runtime permissions. */
export interface ReviewedBundle {
  readonly id: BundleCatalogId
  readonly packageName: string
  readonly version: string
  readonly title: string
  readonly publisher: string
  readonly source: string
  /** Null explicitly means the reviewer has not supplied user guidance. */
  readonly details: BundleDetails | null
  readonly harnessVersions: readonly string[]
  readonly platforms: readonly string[]
  readonly artifact: {
    readonly file: string
    readonly sha256: string
    readonly size: number
  }
}

/** Every catalog mismatch is reported; absence means only that the declared matrix matches. */
export type BundleCompatibilityIssue = 'harness-version' | 'platform' | 'artifact-size'

/** Reviewed entry with the preparation provider's current compatibility decision. */
export interface BundleCandidate {
  readonly entry: ReviewedBundle
  readonly reviewToken: BundleReviewToken
  readonly issues: readonly BundleCompatibilityIssue[]
}

/** Receipt committed only after exact bytes and metadata have been written. */
export interface PreparedBundle {
  readonly schemaVersion: 1
  readonly state: 'prepared-not-enabled'
  readonly entry: ReviewedBundle
  readonly hostVersion: string
  readonly platform: string
  readonly artifactPath: string
  readonly receiptPath: string
}

/** Completed offline package-manager output; neither a Profile nor an activation receipt. */
export interface PreparedDependencies {
  readonly schemaVersion: 1
  readonly state: 'dependencies-prepared-not-enabled'
  readonly prepared: PreparedBundle
  readonly candidateDirectory: string
  readonly packageDirectory: string
  readonly lockfilePath: string
  readonly receiptPath: string
  readonly packageManagerVersion: string
}

/** Boot-free validation output; the original Profile and its Session data remain untouched. */
export interface PreparedComposition {
  readonly schemaVersion: 1
  readonly state: 'composition-checked-not-enabled'
  readonly candidate: PreparedDependencies
  readonly harnessHome: string
  readonly profileName: string
  readonly profileDirectory: string
  readonly sourceProfile: string
  readonly sourceFingerprint: string
  readonly dumpPath: string
  readonly lockfilePath: string
  readonly receiptPath: string
}

/** Boot-free removal candidate; original packages, configuration and Session data remain intact. */
export interface PreparedRemoval extends Omit<PreparedComposition, 'candidate' | 'state'> {
  readonly state: 'removal-checked-not-enabled'
  readonly removed: { readonly packageName: string; readonly version: string }
}

/** Deployment-selected source Profile and bounded copy policy. */
export interface CompositionConfig {
  /** Absolute Harness home containing the source Profile and optional home patch. */
  harnessHome: string
  /** Existing source Profile name, not a path. */
  profileName: string
  /** Absolute trusted dsh CLI entry matching the deployment version. */
  dshEntry: string
  /** Maximum aggregate source-copy bytes or inventory manifest bytes, including linked dependency contents. */
  maxProfileBytes: number
  /** Maximum copied entries or listed inventory layers, including linked dependency contents. */
  maxProfileEntries: number
}

/** Deployment-owned local package manager and operation limits. */
export interface InstallerConfig {
  /** Absolute trusted Node executable, normally the packaged Node. */
  nodeExecutable: string
  /** Absolute trusted pnpm ESM entry, not a shell launcher or package-provided executable. */
  packageManagerEntry: string
  /** Exact expected pnpm version. */
  packageManagerVersion: string
  /** Whole preparation deadline, including copying and managed commands. */
  timeoutMs: number
  /** TERM-to-KILL grace for the managed process tree. */
  graceMs: number
  /** Retained bytes per child output stream; only the composed YAML is persisted. */
  maxOutputBytes: number
  /** Complete uncompressed archive budget. */
  maxExpandedBytes: number
  /** Maximum archive entries. */
  maxArchiveEntries: number
  /** Maximum manifest, lockfile or source patch bytes. */
  maxManifestBytes: number
}

/** Trusted deployment paths and bounded read budgets. */
export interface Config {
  /** Bundled JSON catalog used until a signed remote revision is cached. */
  catalogFile: string
  /** Directory containing catalog-named npm tarballs. */
  artifactDirectory: string
  /** Parent of exclusively created preparation directories; not a profile location. */
  stagingDirectory: string
  /** Exact Harness version supplied by the deployment, not by an install request. */
  hostVersion: string
  /** Maximum complete catalog file bytes. */
  maxCatalogBytes: number
  /** Maximum complete compressed tarball bytes per preparation. */
  maxArtifactBytes: number
  /** Omit to disable user-requested signed catalog updates and HTTPS artifact downloads. */
  remote?: RemoteCatalogConfig | false
  /** Omit to disable offline dependency preparation. Requires a local subprocess provider. */
  installer?: InstallerConfig | false
  /** Omit to disable boot-free candidate Profile validation. Requires installer configuration. */
  composition?: CompositionConfig | false
  /** Omit to disable persistent preparation history; records never authorize activation. */
  journal?: JournalConfig | false
}
