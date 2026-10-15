# Agent Note: Native next-launch Profile selection

Status: implemented

## Problem

A prepared Bundle composition needs a recoverable startup choice outside the plugin runtime. Switching the Harness home would hide existing Sessions and credentials. Activating on incidental runtime retries could also change plugins during an unfinished desktop task.

## Decision

The [native selection owner](../../../../apps/desktop/src-tauri/src/profiles.rs) stores one versioned selection record in the desktop Harness home. The authenticated bridge exposes selection inspection, candidate queueing and exact pending cancellation. Queueing admits a generated `desktop-<UUIDv4>` Profile with a matching manifest SHA-256, an unchanged active predecessor and startup-only patch reload. These checks establish selection identity, not reviewed-code authorization or package integrity; the Harness preparation service remains responsible for package policy.

Only the owner's first application launch consumes a pending candidate. It persists the trial before spawning `dsh --profile <name>` with the original home. Runtime Retry and unexpected process exits do not consume later queues. The supervisor confirms the selection only after the corresponding launcher's authenticated startup acknowledgement and listener readiness; an unsuccessful child is terminated before selection recovery. A persisted unfinished trial is rejected on the next application launch. A successful trial becomes active, with its predecessor retained as metadata; later crashes do not automatically downgrade it.

The single-instance host serializes selection operations. Missing state selects `web`; malformed, unknown-version, oversized or linked state blocks startup rather than resetting it. Atomic same-directory replacement and file synchronization avoid partial JSON publication, but do not promise directory-fsync power-loss durability or coordination between independent native hosts. Failed recovery writes block the next launch until persistence succeeds. Cancellation and recovery never delete Profile or Session files.

The Cordis preparation service reads the native predecessor and creates the candidate directly in the original home. This preserves copied dependency links without a relocation step. Preparation receipts and optional history commit before native dispatch. Once dispatch starts, an uncertain response retains all candidate artifacts; deleting them could invalidate a queue the native host already committed. The native provider validates bounded selection replies and exposes queue/cancel operations through the existing desktop Service Definition. Neither component restarts active work.

## Alternatives considered

**Use a separate Harness home for activation.** Rejected because the running desktop must retain its existing Sessions, settings and credential providers. Private composition-check homes remain useful for validation only.

**Consume the queue on every runtime retry.** Rejected because a recovery action is not authorization to replace the selected plugin composition. Full application restart gives the user an explicit activation point without adding automatic task interruption.

**Restore the previous Profile after any subsequent crash.** Rejected because a successfully activated plugin may have changed persistent data. Automatic selection recovery is confined to uncommitted startup trials and does not reverse plugin side effects.

## Consequences

The [packaged native test](../../../../apps/desktop/src-tauri/src/runtime_profile_tests.rs) starts the actual Node/CLI artifacts through the supervisor, verifies deferred activation across Runtime Retry, confirms the unchanged Harness home, and executes a deliberately failing candidate before restoring its predecessor. Native unit tests cover interrupted trials, stale predecessors, cancellation, concurrent queues, malformed records and failed persistence. The [desktop workflow](../../../../.github/workflows/desktop.yml) owns execution on both release platforms; local macOS evidence does not establish Windows behavior.

The native owner selects Profiles prepared by Cordis; it does not install packages or validate ongoing plugin health. The packaged test queues a real reviewed Bundle through the Cordis service, TypeScript bridge provider and Rust request handler before restarting the supervisor. Browser marketplace integration remains under the [marketplace proposal](../../proposed/architecture/2026-09-06-desktop-plugin-marketplace.md). The [carrier](2026-08-20-tauri-desktop-carrier.md) and [composition preparation](2026-09-07-candidate-profile-composition.md) retain their independent lifecycle and copy-policy rationale. No agent-loop or released Session format changes are required.
