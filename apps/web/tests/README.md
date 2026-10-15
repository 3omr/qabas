# apps/web browser e2e

These tests boot the real web composition in-process and drive it with a real Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

## Manual performance diagnostics

The [manual inventory](../../../vitest.web.perf.config.ts) runs outside default CI. After building the Web client assets, run the [complex-history benchmark](complex-history.perf.ts) with deterministic model replay:

```sh
DSH_SNAPSHOT=replay corepack pnpm exec vitest run --config vitest.web.perf.config.ts apps/web/tests/complex-history.perf.ts
```

The benchmark checks the stored session count, expands the compact sidebar through its overflow control, and distinguishes Trajectory's logical records from its mounted virtual rows. Chat and Trajectory page independently; full-history assertions retain the 500-turn fixture and its 2,100 trajectory records. Continuation scenarios compare the default 24-turn window with fully loaded history and sample the next user-message paint after 100 generated turns.

`WEB_PERF_RESULT` reports measurements without speed thresholds. CDP timings and forced-GC JavaScript heap samples describe this Chromium run, not native WKWebView/WebView2 latency or total desktop memory. A failed assertion and a failed cleanup are both reported; teardown never replaces the original failure.

## Completion observations

State-sensitive cases use Workspace, admission, attachment, and model-stream barriers to separate visible intermediate states from completed operations. Details close waits for frame transitions; archive verification assigns an explicit title to the seeded Session and follows that identity across reload. See the [CI fixture synchronization decision](../../../.agents/notes/implemented/testing/2026-09-08-ci-completion-observations.md).

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate, because they read Host services directly: `ctx.connection`, the Host `SessionStore`, and `ctx.sessionProjectionCache`. Driving a browser at runtime does not make a file part of the Client program — the two faces merge cordis `Context` under the same keys with different services, so one program cannot see both. Moving these files into the Client aggregate makes every Host-service access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript project, and every project it references, into the **Host build graph**. Four Client consumer packages reference `api/remotes`' Client face, which cannot compile until Host tsdown has generated `@deepseek-ai/dsh-goal/remote`; importing them makes the Host build phase wait on an artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass. `scaffold.ts` follows this rule for the welcome-notice namespace, acknowledgement field, version, and asserted Chinese copy.

One kind of Client import stands. `assembled-boot.ts` drives the shell itself, so it imports `AppWebEntry` from `@deepseek-ai/dsh-client-web` and the boot-manifest type from `@deepseek-ai/dsh-client-modules/client`: booting the real shell is what that harness is for, and both packages are already in the Host graph. The chat scenarios mirror `conversationContextKey` in `support.ts` instead of importing its Client owner.

Nothing mechanically enforces this rule; keep it in review.
