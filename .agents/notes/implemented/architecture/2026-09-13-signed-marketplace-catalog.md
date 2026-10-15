# Agent Note: Signed marketplace catalog selection

Status: implemented

## Problem

A catalog distributed independently of an application release can change between review and installation. Artifact hashes supplied by an unauthenticated catalog do not establish review authority, and a valid old signature can reintroduce withdrawn code.

## Decision

The [preparation service](../../../../packages/desktop/bundle-preparation/README.md) accepts an optional deployment-pinned HTTPS channel and Ed25519 public keys. Its internal remote catalog reader authenticates exact payload bytes, validates complete metadata, and enforces origin, size, validity and channel limits. The existing Cordis service owns selection and cancellation; the [browser gateway](2026-09-07-desktop-marketplace-browser.md) supplies explicit refresh and confirmation. No agent-loop change, native loader, publisher login or arbitrary installation URL is added.

The envelope has schemaVersion 1, canonical base64 payload and signature fields. The signed JSON payload has schemaVersion 1, channel, positive integer revision, issuedAt, expiresAt, artifactBaseUrl and the existing catalog document. Empty catalogs can withdraw all discoverable entries. Every online entry requires bilingual review guidance. HTTPS artifact filenames come only from verified records; downloads reject redirects and ambient credentials, and staging checks exact size and SHA-256 before the existing offline preparation path.

Startup reads only the cache. An absent cache permits bundled discovery; a known expired or corrupt cache does not permit fallback. Refresh authenticates the response, then rereads the cache under the existing atomic-write lock before rejecting rollback or same-revision equivocation and replacing it. Refresh and preparation exclude each other. Installation confirmation carries a digest of the signed revision and complete entry, checked before preparation and immediately before native queue dispatch. Expiry or changed review metadata requires a new review; native Profile/version checks remain independent.

The [local preparation decision](2026-09-06-reviewed-bundle-preparation.md) retains staging ownership and receipt semantics. It does not own online trust. The broader [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md) retains publication operations, plugin readiness and product acceptance; neither earlier record is fully superseded.

## Alternatives considered

**Trust HTTPS and adjacent checksums alone.** Rejected because a hosting compromise could replace both metadata and checksums. Deployment-pinned signatures authenticate a separate catalog authority.

**Fall back to the bundled catalog whenever online metadata fails.** Rejected because an expired or withdrawn online entry could silently become installable again. Only a never-cached deployment starts from bundled metadata.

**Add a separate catalog service and account backend immediately.** Rejected because the preparation service already owns selection and all consumers share its lifecycle. GitHub review and static signed metadata do not require user accounts; independent provider evolution can justify a later split.

## Consequences

The signed reader, bounded transport, cache races, expiry, tampering, stale confirmation and Cordis disposal have focused tests. The browser acceptance fixture exposes explicit online-check controls through the actual Loader and authenticated gateway; signed transport uses a substituted HTTPS response in service tests. This is not public-hosting or native WebView acceptance.

Public feed deployment, publisher review automation, signing-key custody and application distribution remain incomplete; packaged desktop defaults do not configure a remote channel. Key rotation accepts only public keys distributed in trusted deployment configuration; no remotely supplied trust-root update is supported. Private keys must remain outside catalogs and application bundles. Cache writes are atomic but not power-loss durable, and local deletion, filesystem rollback or clock tampering can defeat the cached revision floor. Orphaned writer locks require operator recovery. Catalog withdrawal does not disable or delete installed code, and Host plugins still run with Harness access; this is not TUF or plugin isolation.
