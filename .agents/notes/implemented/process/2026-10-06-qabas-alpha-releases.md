# Agent Note: Qabas desktop publication stays Alpha

Status: implemented

English | [中文](2026-10-06-qabas-alpha-releases.zh.md)

## Problem

The desktop publisher marked a release as a prerelease only when its build version contained a suffix. A suffix-free build could therefore appear stable while Qabas remains under development.

## Decision

Every desktop release is titled Qabas Alpha and published with GitHub's prerelease flag until the application stabilizes. Build version alignment and target-native verification remain required. Existing installer version identifiers are preserved; the release classification does not change their compiled metadata.

## Alternatives considered

**Infer stability from the version suffix.** Rejected because build numbering does not establish application stability.

**Change only the current release title.** Rejected because the next automated publication would restore the version-dependent classification.

## Consequences

The current and future desktop release pages identify Alpha builds. Publication tests execute the real shell step with isolated files and a recording GitHub CLI substitute, covering both suffixed and suffix-free versions. Stable publication requires an explicit change to this policy.
