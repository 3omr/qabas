# Agent Note: Exam indexing finishes promptly when agy hangs or is signed out

Status: implemented

## Problem

An 18-paper text-only module stayed active at 17/18 for more than 40 minutes while its saved state already classified every paper: 4 indexed, 13 failed on Antigravity authentication and one failed coverage (#35). [`build_index`](../../../../engine/scripts/agy_exam_index.py) treated every agy timeout as a capacity failure and split the batch, so an agy process that waited instead of answering cost the 600-second writer timeout at every split level. The automatic review in [`review_paper`](../../../../engine/scripts/exam_question_review.py) splits the same way, sequentially, inside one paper. A paper whose batch failed kept its other batches running until each finished or timed out. The desktop waits up to `examIndexTimeoutMs` (one hour) between progress notifications, so the job looked active throughout.

## Decision

- A paper's extraction fails at its `exam_index_timeout_limit`-th agy timeout (engine JSON, default 2, integer of at least 1); capacity failures without a timeout keep the recursive split. The review counts timeouts against the same limit and fails, keeping the extraction, instead of splitting further. The value is a keyword argument of `review_paper`, not a `ReviewSettings` field, because those settings key the review cache and adding one would re-review every saved paper.
- Each paper's agy batches share a stop event. Recording a paper failure sets it, and `cancellation.run` ends the paper's running agy process trees.
- An agy diagnostic that matches the doctor's not-signed-in pattern (`agy_writer.signed_out`) raises `SignedOutError` with failure cause `auth`. The worker sets a build-wide signed-out event, and every later batch that would launch agy fails at once with the same cause. Cached and column-read batches never launch agy and still complete.
- The desktop shows `auth` failures as "Antigravity isn't signed in", a notice with the count and a button that opens Settings → Accounts and tools, a finished-job line with ready and failed counts, and the job's English error only behind "Technical details".

## Alternatives considered

**Fail every unfinished paper as soon as one reports a sign-in failure.** Papers that are fully cached or read from spreadsheet columns need no agy and would be failed without cause.

**Lower the writer timeout.** Large batches legitimately take minutes; the limit on repeated timeouts bounds the waiting without failing slow but working runs.

## Consequences

A hanging agy costs at most `exam_index_timeout_limit` writer timeouts per paper in extraction and again in review, instead of one per split level. A signed-out agy costs one launch per concurrently running batch. Indexer tests pin the timeout limit, the build-wide sign-in stop with cached papers preserved, and the cancellation of a failed paper's running batch; review tests pin the review limit; host and Exams tests pin the `auth` cause and its copy. Native Windows agy behaviour while signed out still requires verification on Windows.
