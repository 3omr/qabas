# Harness Desktop plugin marketplace

## Summary

Add optional capabilities from **Settings → Plugins → Marketplace**. A Bundle can contribute interfaces, tools or agent behavior through Cordis; Skills and MCP integrations are possible contents, not the whole marketplace. These instructions describe the current source build. Older [release installers](https://github.com/Bestbbb/deepseek-harness-desktop/releases) may not include these controls; check the release notes before downloading.

## Table of Contents

- [Choose a capability](#choose-a-capability)
- [Install and use](#install-and-use)
- [Change or remove a version](#change-or-remove-a-version)
- [Understand operation records](#understand-operation-records)
- [Contribute a Bundle](#contribute-a-bundle)

<a id="choose-a-capability"></a>
## Choose a capability

Discover searches names, package names, publishers and the description in your selected language. The catalog ships with the application; refreshing status does not download new catalog entries. Each listing shows its publisher, source, compatibility, account requirements, declared access and setup instructions. Host plugins have the same access as Harness; declarations are not enforced permission limits.

| Capability | Choose it for | Account requirement |
|---|---|---|
| [Focus Timer](../../../packages/desktop/focus-timer/README.md) | An optional countdown beside your conversation | None |
| [Notification Controls](../../../packages/desktop/notification-controls/README.md) | Choosing task completion and failure notifications | None; OS notification permission is separate |
| [Delegate Tasks](../../../packages/desktop/delegation-launcher/README.md) | Submitting work to an already loaded agent provider | Provider setup or login; execution may use quota |

The separate **Configure local agents** entry opens desktop agent settings. Installing Delegate Tasks does not install Codex, Claude Code or another provider, and does not sign you in.

<a id="install-and-use"></a>
## Install and use

1. Open a listing and read its source, access and account requirements. An incompatible entry cannot be installed from this view.
2. Select **Review installation**, then confirm **Install for next launch**. Preparing an installation does not interrupt your current task.
3. Wait for **Waiting for app restart**. Finish active tasks, quit the application and reopen it. A failed startup retains a recoverable previous combination; recovery does not undo plugin changes to user data.
4. Open **Installed** and use the Bundle's action, such as **Open timer**, **Configure notifications** or **Delegate a task**. Pending combinations are not yet enabled. A listed package version is not a running-plugin health check.

<a id="change-or-remove-a-version"></a>
## Change or remove a version

**Version changes** lists installed Bundles whose readable version differs from the packaged catalog. It does not imply the target is newer or compatible. Review both versions and the downgrade warning before confirming; activation still requires a full app restart. No plugin-data migration or automatic update is provided.

**Installed → Review removal** prepares a new combination without a direct, confirmed Bundle. Built-in, indirect and unreadable packages cannot be removed here. Removal retains previous packages and user data for recovery. Canceling pending activation leaves its files intact.

<a id="understand-operation-records"></a>
## Understand operation records

**Operation history** reads preparation records only when opened or refreshed. A verified preparation receipt is not proof that the candidate was queued, activated or healthy. An unsettled record has no recorded outcome and does not prove its process stopped. A missing or changed receipt is unavailable; unreadable history is not an empty history. Do not retry uncertain changes automatically: refresh and check Installed and pending activation first.

<a id="contribute-a-bundle"></a>
## Contribute a Bundle

The desktop installs the curated catalog bundled with its runtime, not arbitrary npm URLs. Authors can follow the [Bundle submission guide](../../cookbook/desktop-marketplace-bundle.md) and propose source for review. Submission and packaging checks do not confer approval. This website explains discovery and use; it does not install code into your computer.

## Dev Note

None.
