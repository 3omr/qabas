# Agent Note: Reviewed Bundle preparation before profile mutation

Status: implemented

## Problem

The plugin CLI installs dependencies and reconciles the selected Profile immediately. Web profile reload can make those changes live. A marketplace cannot use that command as a preparation-only step or equate matching download metadata with a working plugin.

## Decision

The optional [Bundle preparation service](../../../../packages/desktop/bundle-preparation/README.md) owns a trusted local catalog and bounded artifact staging inside Cordis. Exact reviewed Host versions, platforms, byte counts, and SHA-256 values constrain preparation. The parser rejects malformed records and ambiguous identities. Successful `prepare()` operations return `prepared-not-enabled`; that method never installs dependencies, evaluates package code, or modifies a Profile or Session. The separate [offline candidate decision](2026-09-06-offline-bundle-candidates.md) owns optional `prepareDependencies()`.

The deployment supplies catalog and staging paths. Review declarations are trusted metadata, not publisher attestation. Each operation exclusively creates its directory; failures clean only that directory, and disposal rejects further work while awaiting cleanup. Completed receipts survive disposal. A future installer must reverify bytes and resolve dependencies before controlled activation; receipts grant no authority and carry no plugin sandbox guarantee.

The [packaged smoke](../../../../apps/desktop/scripts/smoke-plugins.mjs) is the current preparation consumer. It boots the service through a real `dsh web` overlay, prepares an offline tarball, verifies absence from the Profile, then separately exercises upstream Bundle installation and Host/browser activation. The [marketplace browser](2026-09-07-desktop-marketplace-browser.md) supplies desktop review and next-launch commands; the base Web profile remains independent.

The [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md) remains partly unimplemented. The [desktop packaging decision](2026-09-06-desktop-bundle-packaging.md) still owns bundled pnpm and activation acceptance; neither note is superseded by preparation.

## Alternatives considered

**Call `dsh plugin add` during preparation.** Rejected because it mutates the chosen Profile and may trigger live reload before dependency and activation acceptance.

**Implement a native plugin loader.** Rejected because Cordis and Profile Bundles own composition; native recovery must remain available independently.

**Treat a matching checksum as an installed plugin.** Rejected because it proves byte identity only, not valid package contents, resolved dependencies, safety, or successful activation.

## Consequences

Local preparation adds no network request or inference cost. Tests cover malformed catalogs, exact limits, declared incompatibility, altered bytes, concurrent requests, write failure, and disposal during I/O. Real-composition evidence uses the desktop packaging smoke; native Windows and WebView acceptance remain platform-owned work.

The optional [operation history](2026-09-07-preparation-operation-history.md) records preparation observations without authorizing activation. The separate [signed-catalog decision](2026-09-13-signed-marketplace-catalog.md) owns optional online trust. Byte preparation alone provides no crash recovery, configuration form or activation. Abrupt termination can leave incomplete staging directories. Consumers must never infer installation from directory or receipt existence alone.
