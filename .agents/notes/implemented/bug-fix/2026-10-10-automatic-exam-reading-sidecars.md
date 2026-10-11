# Agent Note: Automatic exam reading and legacy sidecars

Status: implemented

English | [中文](2026-10-10-automatic-exam-reading-sidecars.zh.md)

## Problem

Scanned papers can contain corrupt searchable layers with format marks, isolated Arabic letters and fragmented tokens. Permanent repair failures prevent recovery after tools or source bytes change. Legacy same-stem text files duplicate exam counts and model input. Students need automatic preparation rather than instructions to recognize or repair scans.

## Decision

PDF preparation measures script noise alongside sparse text and corrupt characters. Manifest entries configure `ocr_format_control_limit` and `ocr_script_noise_limit`; exam requests inherit those settings and `ocr_language` from engine configuration. Each unsuccessful request permits one local retry using supported rotation and deskew options discovered from the installed program. Failure markers remain diagnostic artifacts and cannot veto later requests. Source and language remain part of the artifact cache key.

Missing reading executables or language data use `ocr_tool_missing` and installer names in optional `tools`. The API schema and Client result retain those fields. The desktop exam view and module banner share a preparation helper and the installer consumer used by the settings queue. They install reported tools sequentially, retry the affected paper once, and localize installation failures with the tool name. Linux and macOS Tesseract installation plans include multilingual data. Student-facing copy describes automatic reading.

The existing exam-text state pairs direct same-stem document and text files case-insensitively in optional `sidecar`. A pairing-only record uses `prepared: false` and cannot authorize overwriting a student's generated-looking file. Inventory and source selection share the pairing helper. Successful document text wins; after document reading fails, a usable sidecar supplies the derived copy with `fallback: true`. Subsequent explicit requests retry document reading. Original files and sidecars retain their bytes. Old records remain valid, and per-question and per-paper failure isolation stays intact. Publication reuses its owned module registry lock while validating the inventory.

## Alternatives considered

**Trust any nonempty text layer.** Corrupt bilingual extraction can contain enough letters to pass sparse-text checks while supplying unusable evidence.

**Require a student preparation step.** Scan recognition and missing-tool recovery belong to automatic exam preparation.

**Retain permanent negative caches.** A failure cannot establish that later source bytes, languages, tools or explicit requests will fail.

**Delete sidecars or index both files.** Deletion loses student data; indexing both double-counts one paper. Fallback preserves useful legacy text without preferring it over fresh reading.

## Consequences

Explicit failed requests can perform two local recognition attempts and bounded page-image repair. Heuristic thresholds can misclassify unusual papers and remain configurable. Automatic installation follows the existing desktop installer and can fail under its platform policy; the UI retains a localized tool-specific diagnostic. Synthetic Python and Client tests cover noisy and clean layers, retries, structured failures, inventories, fallback precedence, ownership, supported flags, installation and localization without live agy, network requests, system installation or student data.
