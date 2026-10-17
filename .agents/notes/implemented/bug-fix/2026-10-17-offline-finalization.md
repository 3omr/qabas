# Agent Note: Offline finalization

Status: implemented

## Problem

A real lecture passed review, `validate_draft` and `verify_provenance`, then failed at `finalize` with `Could not resolve module notebook: nlm notebook list timed out` while notebooklm.google.com was unreachable from the student's machine. Finalization only reads the saved draft and writes the transcript and `Index.md`. The `--finalize-draft` launcher path still resolved every notebook with `nlm notebook list` and `nlm notebook get`, and listed remote recordings. The engine's finalize audit then resolved the notebooks again and listed sources without the module's inventory cache.

## Decision

`--finalize-draft` is a local-only run. [The launcher](../../../../engine/scripts/run_transcription.py) and [the engine](../../../../engine/scripts/universal_transcribe.py) set the engine config key `LOCAL_ONLY_RUN` from [nlm_client](../../../../engine/scripts/nlm_client.py). In that mode `saved_notebook` targets each notebook by its saved id, and `list_remote_sources` reads the module's `remote-sources.json` inventory in `cached` mode, which returns the last saved inventory instead of refreshing an expired one. A notebook without a saved id still resolves online, and a module with no saved inventory still fetches one.

## Alternatives considered

**Classify the timeout as a network stop and retry.** The job would wait for NotebookLM to return before saving work that needs no network.

**Skip the finalize audit.** The audit enforces blocking source and evidence checks that finalization must keep.

## Consequences

Finalization succeeds while NotebookLM is unreachable when the module has saved notebook ids and a cached inventory, which every earlier step of the same lecture job creates. The recordings named in the finalized transcript come from that inventory. A test finalizes a lecture with an nlm stub that fails every call once finalization starts.
