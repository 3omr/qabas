# Agent Note: Qabas desktop identity preserves installed data

Status: implemented

English | [中文](2026-10-05-qabas-desktop-identity.zh.md)

## Problem

Qabas's study interface and engine ship inside a desktop host whose installer, menus and model-visible desktop guidance identify a different product. Renaming the application identifier would also move its settings and credentials to another application-data directory.

## Decision

The installer, native window, menus, notifications, loading documents, release title and desktop system-prompt context use Qabas. The Tauri identifier remains `io.github.bestbbb.harness-desktop`; internal package names and the runtime-output ownership marker retain their existing names. The [desktop distribution overlay](../process/2026-08-21-upstream-rc1-desktop-sync.md) continues to own launch and packaging.

## Alternatives considered

**Rename the identifier with the product.** Rejected because changing the application-data location makes existing settings and credentials unavailable without a separate migration.

**Keep the inherited name in native surfaces.** Rejected because students install Qabas and need the window, installer and instructions to identify the same application.

## Consequences

Existing installations keep their application-data location. The Arabic root README describes Windows installation and links the engine and desktop guides; documentation translation remains owned by their bilingual pairs. Native branding has unit coverage and the desktop context has a recorded-session expectation.
