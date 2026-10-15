---
description: "Add an account-free focus timer to the Harness sidebar through an optional Bundle."
kind: "package-bundle"
---

# @deepseek-ai/dsh-focus-timer

## Summary

Add a local countdown without an account, model request or network service. Choose a duration, start, pause, resume or reset it. Closing the panel keeps the countdown running; reloading the page or unloading the plugin clears it. The desktop catalog offers this Bundle, but the base Web profile does not activate it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open Settings → Plugins → Marketplace, select Focus Timer, review installation, and confirm installation for the next launch. Finish current tasks, then quit and reopen the desktop application. Use the sidebar's Focus timer button or choose Installed → Open timer in the marketplace. The marketplace action closes Settings and opens the same countdown. A separate Node or pnpm installation is not required.

Enter a whole number from 1 to 1440 minutes. Pause preserves the remaining whole seconds; Resume continues them, and Reset returns to the chosen duration. The sidebar retains the countdown when the panel is closed and shows a completion mark when time expires. The timer sends no sound or system notification.

Under Plugin settings in the timer panel, choose Save this duration to reuse it after a page refresh or application restart. Clear saved duration leaves fresh timers empty. The saved-duration label reflects the Host settings observation, not the button click; an unconfirmed save keeps the draft for inspection. A temporary timer remains usable while preferences are loading or cannot be saved. Saving a duration never saves countdown progress or starts a timer automatically.

The Bundle inserts one `focus-timer` row. In the marketplace's Installed view, choose Review removal and confirm removal for the next launch; the timer disappears after restart. Removal preserves previous Profiles and plugin data. This package ships as a reviewed local tarball, not a promise of npm registry availability.

The tarball includes the schema validator and its dependencies through `bundledDependencies`. The desktop pack command enables pnpm's bundled-dependency packing without changing the workspace installation layout; offline installation does not need registry metadata for these libraries.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The patch](cordis.patch.yml) mounts a Host entry that registers the `focus-timer` preference namespace with the existing settings provider. The schema accepts an optional integer `minutes` from 1 to 1440. [The browser entry](src/client/index.ts) uses the existing `settingsScope` service for revision-fenced writes and renderer-bound observations; it registers a reversible dictionary and waits for `sidebar.footer.action`. Its optional `settings.bundleMarketplace.action` contribution shares panel visibility through an entry-declared store and leaves when the sidebar declaration disappears. The sidebar remains usable without the marketplace. [The component](src/client/FocusTimer.tsx) alone owns countdown state, runs one second-resolution interval while counting down, and clears it on pause, completion or unmount. A wall-clock deadline catches up after browser throttling or system sleep; changing the system clock also changes the remaining time.

No invariant companion is published because the settings service owns preference validation and persistence, while no durable record tracks the component-local countdown. Model input, Session persistence and native lifecycle remain outside this Bundle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop packages](../README.md) — marketplace and native capability owners.
- [Marketplace](../bundle-marketplace/README.md) — confirmation and next-launch activation.
- [Focus timer decision](../../../.agents/notes/implemented/feature/2026-09-07-focus-timer-bundle.md) — optional installation and timer lifetime.

<a id="model-experience"></a>
## Model Experience

None, as this browser-local countdown adds no model input or Session events.

#### KV Cache effect

The Bundle does not change system prompts, tool schemas, request prefixes or model cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Refresh, plugin reload, sidebar owner replacement or application exit clears the timer; it is not a durable reminder.
- Background throttling can delay the visible completion indication. There is no wake-up service, alarm, sound, system notification, history or cross-window countdown synchronization. Preference changes do not alter an already started countdown.
- Preferences use the selected Harness home's settings document and survive Bundle removal; they are not synchronized between devices. Saving requires a writable Host settings scope.
- Host plugin installation grants trusted same-process code access. This package's limited Host behavior does not isolate other packages.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
