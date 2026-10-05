---
description: "Qabas first-run setup's last step: report what the study workspace holds and land the student in the library."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-setup

English | [中文](README.zh.md)

## Summary

The last step of first-run setup. After the welcome and the AI account (ui-settings-models) and the transcription tools (ui-settings-transcriber-engine), it says how many modules the study workspace holds — or that it has none yet — and opens the library.

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

Mount it with ui-library. It registers one `settings.onboarding` step (`qabas-library`, order 30) drawn in the shared `SetupStage` frame.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The step reads the library service's state, which the library has been loading since the app opened, and reads its own position in the sequence from the `settings.onboarding` ledger, as every setup step does.

</details>

**Runtime invariant:** No companion is published. The step reads the library service and the onboarding ledger and owns no state of its own; its sequencing is asserted by behavior specs.

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-library](../ui-library/README.md) — the library this step opens.
- [ui-settings-models](../ui-settings-models/README.md) — the welcome and account steps.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or session event.

#### KV Cache effect

None; the setup step neither assembles nor sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The library location is fixed.** The library uses the operating-system home plus `Qabas Library`, created on first use. Setup does not offer folder selection; `TRANSCRIBER_WORKSPACE` is a developer and test override.

-----

<a id="dev-note"></a>
### Dev Note

Tested with a scripted workspace snapshot.
