# AGENTS.md — GitHub Actions

This community desktop distribution does not have access to DeepSeek's private larger-runner or self-hosted pools. Keep `.github/workflows/ci.yml` on the standard `ubuntu-latest` hosted runner and run workflow policy tests, portable keyless static, artifact, lint, and Node compatibility gates there. Its focused desktop Web replay runs after the build with `DSH_SNAPSHOT=replay`; failures block the job. The separate `desktop.yml` workflow owns target-native macOS and Windows preparation, smoke tests, Rust tests, and packaging.

Upstream-only issue policy and lifecycle workflows remain manual stubs because this repository does not own DeepSeek's GitHub App or Project board. Real-provider E2E workflows are manual-only and must fail loud when their required secret is absent. Dependabot version updates stay weekly, grouped per ecosystem, capped at one open version PR per ecosystem, and subject to the repository's 30-day cooldown.

When syncing upstream workflow changes, preserve the community runner and trigger policy above, then update `scripts/ci-workflow.spec.ts` so it enforces this community topology. Do not copy private runner labels, organization secrets, or project-board mutations into the community defaults.

Documentation builds remain keyless CI checks. Upstream demo launchers, master-only reference workflows, npm publishers, and Cloudflare previews are absent; preserve that scope when syncing upstream. Public website deployment requires a separately chosen community destination.
