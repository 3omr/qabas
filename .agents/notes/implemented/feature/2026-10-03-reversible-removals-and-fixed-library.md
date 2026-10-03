# Agent Note: Reversible library removals and fixed Gemini setup

Status: implemented

English | [中文](2026-10-03-reversible-removals-and-fixed-library.zh.md)

## Problem

Students need to remove outputs and modules without losing their study files. Completed run checkpoints and batch records can incorrectly make a new transcription reuse removed work. Folder selection splits library resolution between Host and engine. A stored Gemini key alone does not activate a Google route or select a first chat model.

## Decision

The Python engine owns reversible file and transcript removals in module-local trash manifests. A transcript entry retains selected outputs, final figures and Anki artifacts, removed Index rows, and matching run checkpoint directories. Matching batch records are cleared. Draft removal also retains staged parts and draft-check metadata so removed text cannot be reconstructed from a completed stage. Clearing the whole matching run avoids retaining completed dependencies that refer to removed work; unrelated lectures remain untouched. Restore refuses occupied paths before moving files and preserves later unrelated Index and batch edits.

Whole modules move by same-filesystem rename to the library's module trash. Their notebooks and NotebookLM sources remain untouched. Module restoration refuses a reused id. Trash has no automatic expiry. Hidden lectures share the trash inventory and restore through recording visibility without recreating definitions.

An admission gate outside the module and OS-held activity leases protect launcher and MCP operations. Removal probes existing module, lecture, batch and Index locks while excluding newly admitted engine work. This guard conservatively refuses the whole active module. It cannot identify an idle chat between engine calls; browser job state is not Host authority.

The Host and Python each own one default-path function: developer override `TRANSCRIBER_WORKSPACE`, otherwise the operating-system home plus `Qabas Library`. First use creates `modules/`. Saved library selections and cwd do not select the library. Session workspaces retain their separate policy.

Gemini key save stores the credential before provisioning an absent empty Google profile in `llm-pi-ai`. Discovery chooses the newest main Flash model and saves it only if the deployment has no default. Credential removal retains the route and default. The existing Google quota fallback remains enabled by the provider's resolved defaults. Client data APIs return explicit edit outcomes; their consumers own UI controls and refreshes.

## Alternatives considered

**Permanent deletion.** The student's removal operation must remain reversible, including outputs and resumable state.

**Browser job records as the removal guard.** Those records are local to one client and cannot exclude another engine process.

**Retaining completed checkpoint phases.** Completed phase files and staged draft parts can recreate removed text without running the requested transcription again.

**Saved student folder selection.** The owner fixes the library location across desktop and Python entry points; a saved pointer creates competing authorities.

**Deleting the Google route with its key.** A later key must work without repeating route selection or resetting the existing default.

## Consequences

Restoration preserves original bytes when edited metadata is unchanged and merges unrelated later Index and batch edits. Destination or progress conflicts require the student to resolve the named path. Engine tests use temporary directories and cover lock refusals, rollback, stages, trash ordering and real MCP dispatch. Host and client tests cover wire validation, data mapping, default-path agreement and conditional Gemini provisioning.

This decision partially supersedes the folder-selection decision in the session-free transcriber library workspace note. That note's inventory and file-access policies remain independent. The lecture-manager, lecture-visibility and daily-quota-fallback decisions retain their independent responsibilities.

### Dev Note

A finishing session completed work an earlier session left uncommitted when its credits ran out; the reviewer placed this note.
