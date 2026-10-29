# Agent Note: Remove library onboarding

Status: implemented

## Problem

The library onboarding screen requires an extra action despite the library having a fixed location.

## Decision

First-run onboarding ends after the tools step. The library package selects the library panel at startup, and onboarding completion reveals it. The ui-setup package and its registrations, copy, dependencies, and generated references are removed.

resolveQabasLibrary owns the location: ~/qabas/Qabas Library or the developer TRANSCRIBER_WORKSPACE override.

## Alternatives considered

Keeping an informational library screen preserves an unnecessary interruption. Adding coordinator navigation duplicates the library's existing startup selection.

## Consequences

Students enter the library without a folder screen. Focused client tests cover default library selection and dismissal after tools. A library onboarding step requires a new product decision before reintroduction.
