# Agent Note: Desktop marketplace browser commands

Status: implemented

## Problem

Non-developer installation needs a discoverable browser action without exposing native credentials, file paths or arbitrary package-manager arguments. A preparation receipt cannot prove that code is running, and losing a mutation response cannot prove that no native state was written.

## Decision

The [Bundle marketplace](../../../../packages/desktop/bundle-marketplace/README.md) owns one Settings tab and a generated Remote gateway. The desktop overlay mounts it; the upstream Web profile remains independent. The gateway consumes the existing Cordis preparation service and native desktop capability; it does not own another installation registry. It projects discovery metadata and native selection, accepts catalog identities for installation and exact pending Profile identities for cancellation, and omits private operational errors.

The browser requires review before installation. It invalidates observations across connection generations and reads native state after command settlement. It neither replays mutations nor infers success from optimistic UI. Pending and trial generations are not installed-state claims; an active Profile is not a per-plugin health result. Users control full application restart after finishing tasks.

The desktop packages a local catalog with the runtime and keeps staging and operation records in its isolated Harness home. Native startup encodes installation paths as literal YAML values and reads package versions from the selected Harness and pnpm manifests. Missing resources or invalid manifests reject startup. Deployment limits remain in the overlay. The shipped catalog contains the optional [Focus Timer Bundle](../feature/2026-09-07-focus-timer-bundle.md); test Bundles remain separate.

Installed observations come from the native-selected Profiles and the upstream package resolver, not preparation history. The gateway rereads native selection after reading packages and rejects a changed selection. A malformed Profile is unavailable; unreadable package metadata retains the listed name with a null version. No package code is imported, no runtime-health inference is made, and no background inventory polling is added. The Installed view distinguishes selected, pending and trial combinations; missing observations block new installation without hiding catalog discovery.

Installation confirmation carries the observed native Profile and installed version; null means an absent Bundle, not unreadable metadata. The preparation service checks source and copied inventories and checks the source again before queueing. Version replacement shows both versions and a downgrade warning; the marketplace makes no semantic-version ordering or plugin-data compatibility promise. A prepared receipt records preparation, not consent to replace a subsequently changed version. Native selection still owns the final Profile comparison, and none of these reads is an atomic lock over all package bytes.

Discovery and version-difference search use the already-read catalog. Version differences include older and incompatible targets without upgrading them automatically; unknown installed metadata cannot establish a difference. The read-only history command accesses the existing bounded preparation journal only when its view opens or refreshes. It does not add history to every inventory read or create a second operational database. Journal failures remain unavailable; verified preparation is separate from activation. Connection-keyed consumers discard late history responses.

The [publication check](../../../../scripts/verify-marketplace-catalog.ts) reuses the installer's strict catalog and archive validators, adds required bilingual guidance and checks every tarball's byte identity before desktop CI executes runtime tests. It reads without extraction or plugin execution; success is not source approval. Source proposals use a GitHub form and maintainer review, with accepted entries distributed through the packaged catalog. The [user guide](../../../../docs/user/guide/marketplace.md) is projected to both website languages without adding a remote installation endpoint.

## Alternatives considered

**Use the native loading page as the permanent marketplace.** Rejected because normal discovery and commands belong in the plugin-composed product; the native shell retains recovery when that product cannot boot.

**Add these commands to the original read-only inventory.** Rejected because Loader observations and installation intent have different owners. A separate tab preserves the existing inventory and makes the optional market removable.

**Retry installation after a transport failure.** Rejected because the native queue can commit before its acknowledgement is lost. The caller rereads selection and preserves candidate files.

## Consequences

The market remains a removable plugin, uses the existing authenticated Web transport, and changes neither the agent loop nor Session persistence. The local catalog, preparation and native-startup decisions retain their independent roles. Component tests cover confirmation, disconnect, duplicate clicks, inventory states and uncertain replies; bilingual browser acceptance exercises installation and version replacement through the actual gateway and preparation service with a native transport fixture. Packaged acceptance checks installation, replacement, plugin-owned use actions and removal; native startup/recovery acceptance remains owned by the [startup decision](2026-09-07-desktop-profile-startup-selection.md). The optional [signed-catalog reader](2026-09-13-signed-marketplace-catalog.md) owns online trust; this gateway forwards explicit checks and review tokens. Configuration/login, public feed operation and task-aware restart remain separate work.
