# Agent Note: Same-stem lecture sources resolve by full name

Status: implemented

## Problem

A lecture with `L2 Anatomy ( CVS ).mp3` and `L2 Anatomy ( CVS ).pdf` under `Lecture/` wrote a readable draft and then failed at save with `Source 'L2 Anatomy ( CVS ).pdf' matches multiple local sources` (#33). The local branch of [`_audit_source_match`](../../../../engine/scripts/universal_transcribe.py) accepted a source whose normalized full name or normalized stem equalled the request. The slide request carries no role filter, so the recording matched the PDF's stem and the request became ambiguous. The NotebookLM branch already preferred full-name matches.

## Decision

`_local_title_candidates` returns the full-name matches among role-eligible sources and falls back to stem matches only when no full name matches, the same order as `_remote_title_candidates`. A stem-only ambiguity still blocks the run, and its message now lists every candidate file so the desktop can name them.

## Alternatives considered

**Filter slide requests to document roles.** Local roles come from folder classification and preparation records, and a lecture PDF can be classified as `slides`, `handout` or `reference`; a role filter would reject valid slide choices while the full-name rule needs no role knowledge.

## Consequences

Recording and slide requests that name a file exactly always resolve to that file. Extensionless or renamed requests keep the stem fallback and still fail on a genuine ambiguity. Regression tests pin the same-stem recording and PDF case and the candidate list.
