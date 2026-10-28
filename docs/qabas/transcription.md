---
description: "Qabas transcription: current Qabas controls, saved data, recovery and limitations."
---

# Qabas transcription

## Summary

A lecture transcription turns recorded speech into an Egyptian Arabic study guide with English medical terms and sourced questions. The lecture page exposes Start, Continue or Redo according to the saved outputs. The five-section document is the intended output format; recovery can retain empty assessment sections when no validated content is available.

## Table of Contents

- [Entry points and saved work](#entry-points-and-saved-work)
- [Pipeline stages](#pipeline-stages)
- [Five sections and badges](#five-sections-and-badges)
- [Figures and external illustrations](#figures-and-external-illustrations)
- [Recovery and limitations](#recovery-and-limitations)
- [Dev Note](#dev-note)

## Entry points and saved work

Open a module's lecture and use «فرّغ» (Start), «كمّل التفريغ» (Continue) or «فرّغ تاني» (Redo); each runs as a background job shown in the task tray. Start applies to a lecture with recordings that has neither a draft nor a final transcript; Continue is available for a draft, including a newer draft beside a final transcript. Redo applies when a recording-backed lecture has a draft or final transcript. The [action rules](../../packages/client/ui-library/src/client/chat-actions.ts), [eligibility](../../packages/client/ui-library/src/client/model.ts) and [job controller](../../packages/client/ui-library/src/client/jobs.ts) define availability. The old final remains readable until Redo finalizes its replacement; [publication](../../engine/scripts/output_assembly.py) archives the replaced final under `Transcripts/.previous/`.

Raw speech is saved as `Verbatim/<recording-stem>.verbatim.md`. Reviewed drafts use a `.draft.md` suffix beside the destination transcript in `Transcripts/`; final filenames come from the engine's resolved output target, not a filename the student must invent. Intermediate `part-<n>.md`, layout metadata and `topics.json` live under `.transcriber-cache/staged-drafts/<draft-name>/`. Run and manifest checkpoints also live in `.transcriber-cache/`. [Draft staging](../../engine/scripts/mcp_server.py) and [module paths](../../engine/scripts/module_registry.py) own these locations.

## Pipeline stages

The [engine pipeline](../../engine/scripts/lecture_pipeline.py) coordinates a complete lecture job. These are processing stages, not seven separate student approvals.

1. Prepare the selected sources and resolve recording order. Missing or failed local recordings are compressed into upload copies, uploaded to NotebookLM and awaited; originals remain intact. Ready remote sources can be reused.
2. Retrieve the doctor's verbatim speech from NotebookLM. Remote-only recordings can supply this input. Failure to obtain speech cannot be replaced by a slide-only explanation.
3. Prepare slide figures and their descriptions when slides exist. Question-index refresh can overlap the early lecture work; later question-dependent steps wait for it.
4. Build a topic map from ordered verbatims, using slide outlines to help name topics. Save anchored topics and split the guide into writing parts. Unusable maps fall back to recording segments.
5. Write guide parts, then the remaining four sections. Prompts require the doctor's spoken order and full explanation; slide-only additions carry a distinct label or folded summary.
6. Apply review, validate format and coverage, and verify question provenance. Bounded repairs can rewrite targeted parts or split work; exhausted repair attempts can salvage retained content only when publication checks accept it. An explicit salvage first writes any guide or questions part that was never staged, so it does not publish a draft with missing parts.
7. Finalize the transcript and update `Transcripts/Index.md`. The lecture request authorizes review and finalization for that lecture; the normal pipeline does not pause for a second save confirmation.

[Recording uploads](../../engine/scripts/recording_uploads.py), [topic mapping](../../engine/scripts/topic_map.py), [writer prompts](../../engine/scripts/agy_writer.py) and [output assembly](../../engine/scripts/output_assembly.py) define the stage details. A failure in optional supporting material can be reported as an omission; an absent narrated guide or recorded-speech baseline prevents publication. Salvage is not proof that the transcript contains every spoken point.

## Five sections and badges

The [format validator](../../engine/scripts/phase_validation.py) defines five ordered headings, and the [section prompts](../../engine/scripts/question_prompts.py) define the IMP subsections. The [editorial reference](../../engine/references/drafting-and-editorial.md) owns detailed writing rules.

| Section | Current intended content |
|---|---|
| 📖 Chronological Guide | The doctor's explanation in spoken order, with topic headings, medical terms and clearly marked slide-only additions |
| 🌟 IMP Points | Doctor's Spoken Pearls, Diagnostic Traps, Lethal Mistakes, Interactive Doctor Questions and Exam Rules; spoken-emphasis completeness is not guaranteed |
| ❓ MCQs | Relevant sourced multiple-choice questions and generated IMP practice, with options and answers |
| ✍️ Written Questions | Relevant direct questions, concise English model-answer keywords and Egyptian Arabic clinical explanation |
| 🩺 Clinical Cases | Patient scenarios and retained taught subquestions; sourced cases precede generated IMP cases |

`[Past Exams - YYYY]` identifies supported exam years, `[Question Bank]` identifies sourced questions without a supported year, and `[IMP]` marks generated practice in the current prompts. Review drafts carry Source fields for sourced questions; finalization removes those evidence-only lines. Generated IMP questions do not claim an exam source. The format also accepts a combined `[Past Exams (YYYY) / IMP]` badge with recording evidence, although automatic generation and repair do not reliably preserve independent importance marks. Validators check structure and evidence, but cannot establish complete semantic coverage of the lecture.

The agy assessment prompt receives guide headings, question lookup results and exam style rather than the complete spoken explanation. It asks for IMP supplements for a thin bank. Provenance repair can replace badges, including using IMP when a question cannot be located. Consequently IMP does not reliably mean “the doctor emphasized this,” and a past-exam badge does not reliably retain a separate importance mark ([#51](https://github.com/3omr/qabas/issues/51)). See the [prompt assembly](../../engine/scripts/mcp_server.py) and [badge repair](../../engine/scripts/question_provenance.py).

## Figures and external illustrations

Slide figures live under `Transcripts/Figures/<lecture>/`, with `figures.json` describing extracted images. Writers and repair try to link figures beside the matching explanation. The validator requires links for every extracted raster; salvage can append unmatched images in a folded reference block at the guide's end. This can include decorative or ungrounded slide references rather than only relevant inline figures. [Placement](../../engine/scripts/figure_placement.py) and [validation](../../engine/scripts/transcript_contract.py) expose the mismatch described in the remediation scope linked to [#63](https://github.com/3omr/qabas/issues/63). Figure dispositions are tracked in [#67](https://github.com/3omr/qabas/issues/67).

With external illustrations enabled, a writer can request an appearance described by the doctor and absent from the slides. The [external-image resolver](../../engine/scripts/web_figures.py) searches Wikimedia Commons and requires a grounded speech excerpt, an eligible open license and confident image verification through agy. At most five gaps are resolved per lecture. Approved files live in the lecture figure directory's `web/` child; `web-figures.json` records attribution and evidence. The transcript identifies these as external illustrations and includes credit. Failed or uncertain requests yield no image; there is no API-key fallback for image verification. Turning the [setting](settings.md#accounts-and-tools) off prevents new requests and leaves existing images valid.

## Recovery and limitations

The task tray's «وقّف المهمة» control stops work. Cancellation preserves completed staged parts; a saved draft makes Continue available. Validation, provenance review and finalization can still fail after writing. Errors and omission notes must be read alongside the artifact, and Continue can repeat a failure for an undersized saved draft whose retained repair parts cannot be regenerated as source segments ([#65](https://github.com/3omr/qabas/issues/65)). Recovery is bounded, not a guarantee of completion. Offline draft finalization uses saved notebook IDs and cached inventory rather than contacting NotebookLM; generating missing speech still requires the service.

The [browser job store](../../packages/client/ui-library/src/client/jobs.ts) persists one `dsh.library.jobs` snapshot and aborts active work on disposal. Restoring sessionless records can queue Continue automatically. The [Host request](../../packages/api/transcriber-engine/src/pipeline.ts) owns the engine cancellation signal, so reload is not a durable detach and application restart is not an explicit recovery workflow ([#52](https://github.com/3omr/qabas/issues/52)). Job history and tray placement are not reliably library-scoped ([#54](https://github.com/3omr/qabas/issues/54)).

The lecture stepper reports verbatim/draft/final artifact state, while only active jobs reach the lecture page. A failed run without a saved draft can lack a visible Continue action; incomplete drafts can misleadingly suggest only checking remains ([#63](https://github.com/3omr/qabas/issues/63)). Weekly quota wording can be misclassified as a short rate limit, and partial indexing can be reported as done ([#61](https://github.com/3omr/qabas/issues/61)). The tray's progressbar also lacks an accessible name ([#62](https://github.com/3omr/qabas/issues/62)). [Failure classification](../../engine/scripts/pipeline_errors.py) and [lecture presentation](../../packages/client/ui-library/src/client/views/Lecture.tsx) determine these current limits.

## Dev Note

None.
