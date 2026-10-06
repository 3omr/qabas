# Agent Note: Bundle subprocess rejection preserves cancellation

Status: implemented

English | [中文](2026-10-06-bundle-subprocess-cancellation.zh.md)

## Problem

A Bundle installation or removal deadline can terminate a managed subprocess before its bootstrap accepts the launch request. The provider then rejects its outcome, hiding the operation's timeout reason behind a startup error.

## Decision

The Bundle subprocess consumer checks its cancellation signal when the outcome rejects. Cancellation reports the operation's reason; other provider failures keep their original error. Both paths terminate and await the managed process range before settling. The [offline candidate decision](../architecture/2026-09-06-offline-bundle-candidates.md) continues to own candidate isolation and retention.

## Alternatives considered

**Increase the test's operation deadline.** Rejected because a slower bootstrap can still race any deadline, and students need the same timeout diagnosis at every startup phase.

**Replace every provider failure with a timeout.** Rejected because uncancelled startup failures need their own diagnosis.

## Consequences

Candidate cleanup and native activation policy stay with their existing owners. Controlled outcome and drainage promises cover cancelled and uncancelled rejection without relying on host timing. The real removal deadline test retains its child-drainage assertions.
