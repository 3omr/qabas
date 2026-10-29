# Agent Note: Remove upstream-only CI and demos

Status: implemented

## Problem

Qabas is published from GitHub `3omr/qabas`, whose default branch is `main` and which has no `master` branch, no self-hosted runners and no npm, Cloudflare or native-addon publication. The fork still carried DeepSeek Harness workflows that trigger only on `master` pushes or publish upstream artifacts, their topology specs, the `demo:ptc`/`demo:inspector` scripts and `BENCHMARK.md`. These files never ran for Qabas, yet their specs and documentation constrained every CI change.

## Decision

Delete `sandbox.yml`, `ci-master.yml`, `release-publish.yml`, `release-vendor-publish.yml`, `node-addon-system-release.yml`, `build-preview-cloudflare.yml` with `.github/preview-sizing/`, the self-hosted topology specs under `scripts/tests/`, the preview workflow spec, `scripts/demo-ptc.mjs` with its two package scripts and `BENCHMARK.md`. [Workflow checks](../../../../scripts/ci-workflow.spec.ts) and [entrypoint policy](../../../../scripts/verify-application-entrypoints.ts) now describe only the workflows Qabas runs: `ci.yml`, `engine.yml`, `desktop.yml`, `expected-filenames.yml`, `node-addon-system.yml`, the PR pack rehearsals `release.yml` and `release-vendor.yml`, `e2e.yml` and `pi-ai-provider-e2e.yml`. Notes that only described the master/self-hosted topology moved to the archive.

## Alternatives considered

**Keep the workflows dormant.** They cannot trigger on `main`, and their specs forced every workflow edit to preserve a topology Qabas does not have.

**Port them to `main`.** Qabas has no self-hosted runners, Cloudflare preview project or upstream publication credentials, so the ported jobs would fail or publish nowhere.

## Consequences

Cross-platform reference runs, PR previews and upstream package publication are gone; Qabas desktop builds remain in `desktop.yml`. Restoring any of them means reintroducing the workflow together with its spec and runner or credential setup. The archived notes record the upstream measurements.
