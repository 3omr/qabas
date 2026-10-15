# Agent Note: Candidate Profile composition before runtime activation

Status: implemented

## Problem

An installed dependency candidate does not establish that its Bundle patches compose with existing user configuration. Using the active Profile for that check can mutate a running application. Copying package links without retaining their resolution context can also produce a candidate that accidentally reads original dependencies or cannot resolve transitive imports.

## Decision

Optional [operation history](2026-09-07-preparation-operation-history.md) preserves composition observations without changing Profile validation or granting activation authority.

The optional [Bundle preparation service](../../../../packages/desktop/bundle-preparation/README.md) provides `prepareComposition()` after fresh reviewed-artifact installation. It copies a deployment-selected Profile into a private Harness home, preserves user manifest fields and Bundle order, overlays the candidate package, and refreshes the Profile lockfile offline. Internal links target the copied tree; external links are materialized, with entry and byte budgets. File copies request filesystem copy-on-write without writable sharing. The candidate uses startup-only patch loading and receives a copy of the home patch, not Session storage.

Validation checks the configured dsh version and invokes its normal boot-free `--dump-config` command. It neither boots plugins nor evaluates `!!js`. A source manifest/Profile-patch/home-patch change during preparation rejects the result. A successful `composition-checked-not-enabled` receipt records the private Profile, lockfile, dump and source-configuration fingerprint. The operation shares the installer deadline, bounded output and managed process drainage; errors remove only its candidate directory.

The upstream Bundle resolver must select the reviewed candidate's package directory. An installation-owned package with the same name causes preparation to fail before queueing, because an installation-first resolver would otherwise validate and boot different code. Marketplace artifacts therefore remain separate from the default runtime dependency graph.

## Alternatives considered

**Remove directly from the active Profile.** Rejected for the same task-preservation reason as live installation. Removal uses the shared copy and composition validator, preserving the original generation and plugin data. It requires an observed active Profile, exact package version and a direct dependency resolved inside that Profile; both source and copied inventory are checked. A distinct removal receipt and journal record avoid claiming that installed code came from a current reviewed catalog entry. Native queue acknowledgement remains separate from preparation success.

**Modify the active Profile before validation.** Rejected because configuration reload and an installation failure can affect the user's current task.

**Implement another patch evaluator.** Rejected because the existing dsh dump composes the actual Bundle layers without executing plugin code. Maintaining parallel semantics would make a successful check unreliable.

**Change upstream Bundle resolution precedence.** Rejected because installation-first resolution keeps built-in Bundles aligned with the running Harness. Optional marketplace artifacts use Profile-local installation without changing that rule.

**Point every candidate dependency at the original installation.** Rejected because later source edits would change the candidate. Internal pnpm links retain their relative package resolution context inside the copy instead.

## Consequences

The [packaged smoke](../../../../apps/desktop/scripts/smoke-plugins.mjs) independently boots the generated candidate through the real dsh launcher and checks Host/browser contributions before exercising the original Profile's existing install/remove path. Unit tests pin copying, internal dependency resolution, source-edit rejection, copy limits, wrong CLI version, cancellation and cleanup. Native Windows/WebView acceptance and arbitrary external dependency layouts remain separate platform and compatibility work.

This is configuration composition evidence, not a health check or activation authorization. It is not an atomic snapshot of every source module, and absolute paths in user configuration are not rewritten. Candidate directories can contain private configuration and must not become public diagnostics. Persistent operation recovery, task-idle admission, production Profile switching, rollback and marketplace UI remain incomplete under the [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md). The [offline candidate decision](2026-09-06-offline-bundle-candidates.md) remains the owner of dependency-only preparation.
