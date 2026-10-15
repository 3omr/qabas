# Agent Note: Desktop local agent checks and explicit delegation opt-ins

Status: implemented

## Problem

A local Codex or Claude Code installation does not prove that Harness has installed its provider, granted a delegation tool, or authenticated the SDK selected by that provider. A desktop entry point must distinguish these facts without copying credentials or silently granting tools to every session.

## Decision

The native extension window separates on-demand execution preflight from saved provider opt-ins. The exact packaged document and window label gate privileged native commands; remote runtime pages receive no such access. A packaged JSON catalog owns public metadata and fixed launch arguments; preference keys must name catalog entries. Checks accept no executable or argv from the caller, scrub inherited secret variables and runtime injection variables, retain bounded output privately, and project only known version and login facts. The existing process-tree owner bounds and cleans up probes. A successful check is not proof of an SDK query, quota, or inference availability.

Build-time Node dependency resolution anchors Codex and Claude paths at the actual provider packages, without importing either agent. A versioned resource records only confined relative paths to the Codex wrapper and Claude SDK platform binary. Native checks validate that resource and invoke the bundled Node plus Codex wrapper, or the Claude binary directly. Invalid metadata, missing files and escaping symlinks fail without falling back to PATH. Kimi/Qoder retain local-CLI lookup with relative PATH entries excluded. The UI names each execution source, so an unrelated system CLI version cannot be mistaken for the delegated runtime.

The desktop deployment includes the pinned upstream Codex, Claude Code, and ACP adapters. Atomic preferences in the isolated desktop home select which providers load on the next runtime start. The application generates a separate system-trust `desktop-local-agents` preset from the shipped standard composition, granting only selected delegation tools. Unexpected upstream optional-row changes fail closed. Standard and user-authored presets are not rewritten; active tasks are not interrupted by saving. The generated preset root remains available with external delegation tools disabled when all opt-ins are off.

The native choices do not expose permission bypass or arbitrary package installation. Codex retains `never`, Claude Code retains `dontAsk`, and ACP uses `reject`; providers own authentication, execution, and delegation output. Experimental Kimi/Qoder entries use locally installed programs and fixed ACP arguments. Missing executables and Windows command shims reject activation. The ACP client supplies no filesystem/terminal service or interactive approval bridge; a child process is not a filesystem sandbox. The [desktop carrier decision](../architecture/2026-08-20-tauri-desktop-carrier.md) remains authoritative for runtime isolation, transport, and native lifecycle.

The curated marketplace reads the packaged catalog without a network dependency. Search and type filters operate on existing cards so they preserve pending choices. **Selected** means the next-launch draft, never a claim about the current runtime. Diagnostics cannot overwrite that draft, and a failed save cannot replace the last confirmed selection. Provenance and execution limits remain available in each card's details.

The Bundle marketplace opens this same native window through the authenticated `desktop` service. Its argument-free command carries neither agent ids nor account data and performs no checks or activation. The browser labels it as built-in connections, not an installable collaboration Bundle. The native menu remains a recovery entry when the runtime or marketplace is unavailable.

## Alternatives considered

**Use PATH CLI checks for bundled execution readiness.** Rejected because the system CLI can differ from the provider's pinned runtime or be absent while the bundled runtime works. Resolving during packaging also avoids adding a second Node package resolver to Rust.

**Treat a CLI login as an enabled integration.** Rejected because the provider selects a separate pinned dependency and the agent preset independently grants its tool.

**Maintain marketplace-specific agent opt-ins.** Rejected because two saved selections could grant different tools at startup. Opening the existing native editor preserves one preference owner and keeps long-running checks outside the private synchronous bridge.

**Install arbitrary npm packages from the first extension screen.** Rejected because executing third-party host code needs source review, compatibility policy, installation recovery, and explicit user trust. Curated bundled adapters provide a bounded first path.

**Enable external delegation in the standard preset or hot-restart on save.** Rejected because either changes existing session behavior without a separate session choice or interrupts active work.

## Consequences

The installer carries the selected upstream adapters but not the Kimi/Qoder runtime distributions. Disabled integrations start no agent process and load no provider plugin. The separate native page adds no dependency to the chat renderer. Provider removal means disabling at next restart, not deleting bundled files or the provider's own account data. Custom host roster roots are not merged into the generated desktop roster configuration; shipped and ordinary user roots remain available.

Rust tests cover catalog preferences, missing executables, opt-in generation, malformed preferences, upstream row drift, origin restrictions, output bounds, timeouts, and secret projection. Bilingual browser expectations cover the packaged document, read-before-save, explicit choices, and safe errors. The packaged-runtime smoke keeps generated ACP providers and tool grants while replacing external commands with the provider-owned protocol fixture. Codex/Claude real-product suites exercise official binaries against local protocol fixtures; the ACP suite covers cancellation, refusal, and process cleanup. Real Kimi/Qoder binaries, real-account inference, native Windows interaction, and public marketplace installation remain separate acceptance work.

Packaging tests reject invalid wrapper metadata, mismatched Claude payload versions and paths outside the prepared root. Native tests distinguish a bundled executable from a conflicting PATH CLI and reject fallback after removing the bundled file. A target-native packaged test launches both real executables with only `--version`, an empty private configuration home and no host CLI PATH. It does not exercise login or spend provider quota; the desktop workflow runs it after preparing its target runtime.
