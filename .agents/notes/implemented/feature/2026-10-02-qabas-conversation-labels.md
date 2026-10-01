# Agent Note: Qabas conversation labels

Status: implemented

English | [中文](2026-10-02-qabas-conversation-labels.zh.md)

## Problem

Students reading a transcription encounter raw MCP names and argument JSON instead of lecture progress. Flattened Gemini quota and unavailable-model diagnostics occupy the failed-request row without useful guidance.

## Decision

ui-tool owns a generic `toolTitles` service accepting pure localized title/summary resolvers keyed by wire name. ui-library contributes its sixteen transcriber titles through effects and reuses the job-step dictionary. The generic row retains state, raw input/output, expansion and Inspect; keyed toolviews retain precedence. Invalid or incomplete JSON uses the original generic label. Registration and disposal publish observable snapshots; rendering reevaluates the active locale.

ui-chat classifies projected provider codes and text, including embedded JSON, into localized guidance. Daily quotas take precedence over per-minute hints; generic account quota is distinct from a confirmed daily quota. Only scheduled retry notices promise automatic continuation. Terminal errors and cancelled retries do not infer a retry from HTTP 429 or retryDelay. Raw projected text and codes remain behind Details. Existing AUTH projection continues to suppress credential-bearing text.

The client-derived-tool-presentation note remains authoritative for raw Session transport, keyed renderer dispatch, and private card models. Its prohibition on a second presenter registry is narrowed only for text contributions to the generic row; there is no second card renderer or Host projection. The locale-owned-copy note remains authoritative. Neither existing note is fully superseded.

## Alternatives considered

**Register sixteen complete keyed toolviews.** The business plugin would need to reproduce the generic disclosure and state presentation or import a feature component, violating Client value-import ownership. Plain title contributions preserve those mechanics in ui-tool.

**Teach ui-tool the transcriber names.** This couples a generic renderer to one application and separates its titles from the library's job-step copy.

**Classify errors in the LLM provider.** The provider/retry work is independent; Client classification handles both current flattened messages and stable codes without changing retry policy or Session events.

## Consequences

Business plugins own labels without sharing component values. A live registry adds one framework-bound observable to the generic Tool renderer. Provider text classification remains conservative and uses generic guidance when no known category matches. Lecture titles are shown only when present in call arguments; manifest paths do not imply a lecture title.

Focused tests cover title effect lifetime, locale changes, argument validity, details, and provider envelopes. Owner-local snapshots record presentation output and Session-event replay. The protected .agents directory requires this bilingual note to be delivered in /tmp; the existing presentation-note amendment must be applied when that directory is writable.
