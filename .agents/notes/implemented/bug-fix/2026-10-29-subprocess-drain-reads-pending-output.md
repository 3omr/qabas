# Agent Note: Read pending subprocess output before drain settlement

Status: implemented

## Problem

Issue #76 reports truncated collected output under heavy host load: the engine writes 5646 bytes of valid JSON, but the host receives only 5373 bytes. An overdue drain timer can destroy collected streams before pending pipe reads reach their collectors.

## Decision

Drain expiry schedules settlement with setImmediate so pending I/O can reach collectors before destruction and sealing. EOF or close settles earlier and cancels deferred settlement. The graceMs duration and termination escalation remain unchanged.

## Alternatives considered

Increasing graceMs cannot prevent truncation after a longer event-loop block. Waiting indefinitely for EOF allows a descendant holding an inherited pipe to prevent completion.

## Consequences

A pipe held open remains bounded by graceMs plus the deferred event-loop turn. Caller-owned pipe streams retain their ownership semantics. Deterministic tests control drain expiry and pending output delivery for EOF, close, and a pipe that remains open; all three fail before the fix and pass afterward.
