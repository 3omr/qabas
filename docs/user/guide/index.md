# Get started with Harness Desktop

Use Harness Desktop to connect a model and run a task in a local project. This guide is for installer users: the app starts its own Harness runtime, so you do not need to start a Web server or install a separate CLI. For source development, follow the [build instructions](../../../README.md#run-from-source).

## Install and open the app

1. Open [Releases](https://github.com/Bestbbb/deepseek-harness-desktop/releases/tag/desktop-v0.1.3-alpha.1) and choose the macOS Apple Silicon DMG or Windows x64 installer under **Assets**. Check that release's bundled version and platform notes; a source checkout can be newer than the available installers.
2. Verify the download against the release's SHA-256 checksums before installing. These community previews are ad-hoc signed and not notarized on macOS, and unsigned on Windows. If your operating system blocks the app, review the release's platform instructions before deciding whether to allow it.
3. Open **Harness Desktop** and wait for the conversation interface. Read the first-run notice before continuing to model setup.

Automatic updates are not configured. Check Releases for a newer installer; the [desktop guide](../../../apps/desktop/README.md) describes data isolation and distribution limits.

## Configure a model

Open **Settings → Models**. Enter a [DeepSeek API key](https://platform.deepseek.com/) in the DeepSeek card, or use **Add provider** or **Add a custom provider** for another supported provider or gateway. Save the configuration, then select a model in the conversation composer.

The [model configuration guide](./providers.md) covers authentication, model discovery, image support, and gateway settings. Saving a key stores it locally; it does not prove that the provider will accept a request. Model requests use your provider's service and billing, not a bundled subscription.

## Choose a workspace

Click **Choose workspace**, add a local project directory, and select it. The conversation composer needs a selected workspace and model before you can send a task. Start with a project you are comfortable granting the agent access to.

## Run a task

Start a session, choose an Agent preset, and send a small task:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

Read the response and any tool results before asking for larger changes. If the provider rejects the request, return to **Settings → Models** and check the endpoint, model, and credentials using the [troubleshooting guide](./providers.md#provider-troubleshooting). A disabled composer also requires checking the workspace and model selections.

## Continue

- [Configure models](./providers.md)
- [Configure a network proxy](./network-proxy.md)
- [Use the plugin marketplace](./marketplace.md)
- [Use the Python SDK](./python-sdk.md)
- [Develop a plugin](../develop/basic/index.md)
