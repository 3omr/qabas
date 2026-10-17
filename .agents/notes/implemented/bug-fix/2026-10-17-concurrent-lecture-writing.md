# Agent Note: Concurrent lecture writing

Status: implemented

## Problem

A lecture job ran every slow step in sequence. It refreshed the module's exam index, including automatic review of every unreviewed paper, before preparing the lecture. On one Toxicology job, eleven never-reviewed papers kept the job in exam review for over eighteen minutes before any guide part was written. Guide parts were then written one agy call at a time, although only the final guide part reads the earlier guide and only the questions part reads every guide heading.

## Decision

[The lecture pipeline](../../../../engine/scripts/lecture_pipeline.py) starts the exam-index refresh on a background thread that shares the request's cancellation. `begin_lecture` receives a pending status instead of refreshing the index itself. The final guide part and the questions part, which read ranked past-exam questions, wait for the refresh, as do review and salvage, which check provenance against it. The job outcome waits for the refresh's index writes.

`write_parts_with_agy` writes the requested guide parts before the final guide part concurrently, up to the engine JSON `lecture_writer_workers` (default 3). Prompts are built before any write. A part whose predecessor is not staged continues from the predecessor's verbatim segment instead of its written tail. Completed parts are staged in part order after every write settles, including when the request is cancelled, and figure links that an earlier staged part already placed are removed. The lowest failed part is reported as before; the final guide part and the questions part follow in order only when every concurrent part succeeded.

## Alternatives considered

**Skip review during the lecture refresh.** The questions part would cite unreviewed OCR text; review is a one-time cost per paper and overlapping it with writing removes most of its wait.

**Write every part concurrently.** The final guide part excludes content already in the earlier guide, and the questions part grounds its headings in the whole guide.

**Stage each part as soon as it finishes.** Staging updates shared layout and manifest files, and figure de-duplication depends on part order.

## Consequences

A job's wall time approaches the longer of preparation plus exam review and the concurrent guide writing, instead of their sum. More agy processes run at once, so per-minute limits are reached sooner; the existing transient-error backoff applies. Tests use fake writers to check overlap, ordering, the one-worker configuration and figure de-duplication.
