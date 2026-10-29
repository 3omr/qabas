# Agent Note: Remove the upstream Python SDK

Status: implemented

## Problem

Qabas is a Tauri desktop application over the Web profile. The upstream DeepSeek Harness Python client, bundled Node runtime, wheel distribution, and GitLab pipeline add packaging and validation obligations outside that application. The owner decided to remove them on 2026-10-28. Qabas's transcription engine is independently owned under `engine/` and remains required.

## Decision

The repository omits `python/`, its pnpm runtime workspace, SDK-only pytest configuration, Python wheel build and release workflows, GitLab CI, and Python-only fixtures and packaging dependencies. Workspace declarations, dependency update configuration, hooks, notices generation, and active architecture and testing instructions describe the surviving deployment.

The TypeScript SDK, its JSON-RPC protocol and profiles, and its tests remain supported. Agent-loop, session-lifecycle, and `SessionEventMap` changes update the TypeScript SDK expected outputs. Shared SDK-profile tests retain their Node-driven behavior without depending on the Python guide. Runtime-closure validation defaults to the desktop deployment manifest and evaluates platform-conditioned presets for Linux, macOS, and Windows without a Python wheel manifest.

The private experimental CPython code runtime remains independent of the removed client distribution. Its subprocess implementation and model-facing Python tool bindings remain available for explicit experimental compositions. Qabas's `engine/`, its environment and tests, and `Qabas Library/` remain outside this removal. The user documentation and website are retained for their separate removal change; their Python SDK links require that follow-up.

## Alternatives considered

**Retain the Python client and wheel tooling.** The owner rejected retaining this upstream SDK because Qabas uses the desktop Web application and its own transcription engine; wheel packaging does not serve that deployment.

**Remove all Python implementations together.** Rejected because the transcription engine serves Qabas, and the independent experimental code runtime belongs to a separate experimental-removal decision.

**Remove all SDK-profile tests.** Rejected because the Node-driven JSON-RPC profile tests also cover the surviving TypeScript SDK runtime.

## Consequences

Qabas maintains fewer runtime distributions, CI jobs, dependencies, and fixtures. Python clients lose the upstream SDK and bundled runtime distribution from this repository; the TypeScript SDK and transcription engine retain their separate responsibilities. Reintroducing a Python client requires an explicit owner decision and renewed distribution and installed-artifact validation.

The removal requires workspace and CI specs, TypeScript checks, documentation and catalog checks, and the engine pytest smoke. Validation results and sandbox limitations belong in the change report; unavailable checks are not passing evidence. Python packaging decisions have historical scope; partially affected active notes retain independent rationale with TypeScript-only SDK facts.
