import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const nativeWindowsPnpmDestination = '${{ runner.temp }}/setup-pnpm-js-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.job }}'
const runnerPrivatePnpmDestination = /^\$\{\{ runner\.temp \}\}\/setup-pnpm-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$/

function expectPortableCommunityChecks(validation: Record<string, unknown>): void {
  if (!Array.isArray(validation.steps)) throw new TypeError('Community validation job must define steps')
  const steps: unknown[] = validation.steps
  const portable: unknown = steps.find(step => isRecord(step) && step.name === 'Run portable keyless checks')
  if (!isRecord(portable) || typeof portable.run !== 'string') {
    throw new TypeError('Community validation job must define portable keyless checks')
  }
  expect(portable.run).toContain('pnpm run check:ci:static')
  expect(portable.run).toContain('pnpm run check:ci:artifacts')
  expect(portable.run).toContain('pnpm run check:ci:lint:contracts-ready')
  expect(portable.run).toContain('pnpm run check:node-compat')

  const policy: unknown = steps.find(step => isRecord(step) && step.name === 'Verify community workflow policy')
  const browser: unknown = steps.find(step => isRecord(step) && step.name === 'Install desktop replay browser')
  const replay: unknown = steps.find(step => isRecord(step) && step.name === 'Replay desktop Web composition')
  expect(policy).toMatchObject({ run: 'pnpm exec vitest run scripts/ci-workflow.spec.ts' })
  expect(browser).toMatchObject({
    run: 'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install chromium',
  })
  expect(replay).toMatchObject({
    env: { DSH_SNAPSHOT: 'replay' },
    run: 'pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/desktop-context.e2e.ts apps/web/tests/desktop-loading.e2e.ts',
  })
  expect(steps.indexOf(policy)).toBeLessThan(steps.indexOf(portable))
  expect(steps.indexOf(portable)).toBeLessThan(steps.indexOf(browser))
  expect(steps.indexOf(browser)).toBeLessThan(steps.indexOf(replay))
  for (const step of [policy, browser, replay]) {
    expect(step).not.toHaveProperty('if')
    expect(step).not.toHaveProperty('continue-on-error')
  }
}

describe('CI workflow', () => {
  it('keeps automatic community PR jobs off upstream private runner pools', () => {
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (!isRecord(ci.jobs) || !isRecord(ci.jobs.validation)) return
    for (const file of readdirSync(resolve(root, '.github/workflows')).filter(file => file.endsWith('.yml'))) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.on) || !Object.hasOwn(workflow.on, 'pull_request')) continue
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job)) throw new TypeError(`${file}: ${name} must define a job`)
        const runners = JSON.stringify({ runsOn: job['runs-on'], strategy: job.strategy })
        expect(runners, `${file}: ${name} cannot use DeepSeek's private runner pools`)
          .not.toMatch(/self-hosted|vm-backup|dsh-(?:ubuntu|windows|win-ci)/)
      }
    }
  })

  it('isolates every pnpm action setup destination per runner', () => {
    const files = ['.github/workflows/ci.yml']
    const setups: Array<{ jobName: string; step: unknown }> = []
    for (const file of files) {
      const workflow: unknown = yaml.load(readFileSync(resolve(root, file), 'utf8'))
      if (!isRecord(workflow) || !isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !Array.isArray(job.steps)) continue
        for (const step of job.steps) {
          if (!isRecord(step) || typeof step.uses !== 'string' || !step.uses.startsWith('pnpm/action-setup@')) continue
          setups.push({ jobName, step })
        }
      }
    }

    expect(setups.length).toBeGreaterThan(0)
    for (const { jobName, step } of setups) {
      const stepDest = (step as { with?: { dest?: unknown } }).with?.dest
      if (jobName.startsWith('windows-')) {
        expect(stepDest, `${jobName} must use the native Windows pnpm destination`).toBe(nativeWindowsPnpmDestination)
        expect(step).not.toMatchObject({ with: { standalone: true } })
      } else {
        expect(typeof stepDest, `${jobName} must use a runner-and-run-private pnpm destination`).toBe('string')
        expect(stepDest as string).toMatch(runnerPrivatePnpmDestination)
      }
    }
  })

  it('runs portable keyless checks on the community hosted job', () => {
    const validation = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'validation')
    expect(validation).toMatchObject({
      name: 'community / keyless',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 60,
    })
    expectPortableCommunityChecks(validation)
  })

  it('gives the Wine Host TypeScript compile the repository heap budget', () => {
    const wineGates = readFileSync(resolve(root, 'scripts/wine-windows-gates.sh'), 'utf8')

    expect(wineGates).toContain(
      'wine_node "$scratch/logs/host-tsc.log" --max-old-space-size=4096 "$tsc_js" -b tsconfig.host.json --pretty false',
    )
  })

  it('cancels superseded community validation on main and pull requests', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    expect(workflow.concurrency).toMatchObject({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': true,
    })
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: null,
      workflow_dispatch: null,
    })
  })

  it('keeps supported LSP source under native Windows coverage', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain('packages/lsp/lsp-stdio/src/connection.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/index.ts')
    expect(config).not.toContain('packages/lsp/lsp-stdio/src/instance.ts')
  })

  it('keeps every Vitest project process-isolated on native Windows', () => {
    const config = readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')

    expect(config).not.toContain("pool: process.platform === 'win32' ? 'threads' : 'forks'")
    expect(config.match(/pool: 'forks'/g)).toHaveLength(2)
  })
})

describe('DeepSeek e2e workflow', () => {
  it('is manual-only and prepares bubblewrap from the pinned payload without a package transaction', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const steps = e2e.steps.filter(isRecord)
    expect(steps.find(step => step.name === 'Prepare bubblewrap (unrestrict userns)')).toMatchObject({
      run: 'bash scripts/prepare-ci-bubblewrap.sh',
    })
    expect(JSON.stringify(steps)).not.toContain('apt-get')
  })

  it('bounds profile subprocess fan-out to the tested e2e default', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')
    const e2e = workflowJob(workflow, 'e2e')
    if (!Array.isArray(e2e.steps)) throw new TypeError('DeepSeek e2e workflow must define steps')

    const step = e2e.steps.filter(isRecord).find(candidate => candidate.name === 'E2E tests (real DeepSeek API)')
    expect(step).toMatchObject({ env: { DSH_E2E_MAX_WORKERS: 4 } })
  })
})

describe('E2B e2e workflow', () => {
  it('is manual-only and fails loud before running the focused live suite', () => {
    const workflow = loadWorkflow('.github/workflows/e2b-e2e.yml')
    expect(workflow.on).toEqual({ workflow_dispatch: null })
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.e2b) || !Array.isArray(workflow.jobs.e2b.steps)) {
      throw new TypeError('E2B e2e workflow must define the e2b job steps')
    }

    const steps = workflow.jobs.e2b.steps.filter(isRecord)
    const preflight = steps.find(step => step.name === 'Preflight (require E2B API key)')
    const e2b = steps.find(step => step.name === 'E2B tests (live sandbox)')

    expect(preflight).toMatchObject({
      env: { E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}' },
    })
    expect(preflight?.run).toContain('E2B_API_KEY_EXTERNAL repository secret')
    expect(e2b).toMatchObject({
      env: {
        E2B_API_KEY: '${{ secrets.E2B_API_KEY_EXTERNAL }}',
        DSH_E2E_MAX_WORKERS: '1',
        DSH_EXAMPLE_MODE: 'lib',
      },
    })
    expect(e2b?.run).toContain('packages/e2b/e2b/tests/composition.e2e.ts')
  })
})

describe('Issue lifecycle workflow', () => {
  it('keeps the upstream-only issue workflows as manual stubs', () => {
    const lifecycle = loadWorkflow('.github/workflows/issue-lifecycle.yml')
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')

    expect(lifecycle.on).toEqual({ workflow_dispatch: null })
    expect(policy.on).toEqual({ workflow_dispatch: null })
    expect(workflowJob(lifecycle, 'disabled').name).toBe('Upstream issue lifecycle is disabled')
    expect(workflowJob(policy, 'disabled').name).toBe('Upstream issue policy is disabled')
  })
})

describe('Dependabot configuration', () => {
  it('groups weekly version updates and bounds each ecosystem to one open request', () => {
    const config = loadWorkflow('.github/dependabot.yml')
    if (!Array.isArray(config.updates)) throw new TypeError('Dependabot must define update entries')

    for (const update of config.updates) {
      if (!isRecord(update) || !isRecord(update.groups)) {
        throw new TypeError('Each Dependabot update entry must define groups')
      }
      expect(update.schedule).toMatchObject({
        interval: 'weekly',
        day: 'monday',
        time: '04:00',
        timezone: 'Asia/Shanghai',
      })
      expect(update['open-pull-requests-limit']).toBe(1)
      const groups = Object.values(update.groups)
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ patterns: ['*'] })
    }
  })

  it('omits community Project credentials or restricts upstream tokens to human pull request metadata', () => {
    const policy = loadWorkflow('.github/workflows/issue-policy.yml')
    const ci = loadWorkflow('.github/workflows/ci.yml')
    if (isRecord(ci.jobs) && isRecord(ci.jobs.validation)) {
      expect(policy.on).toEqual({ workflow_dispatch: null })
      expect(policy.permissions).toEqual({ contents: 'read' })
      if (!isRecord(policy.jobs)) throw new TypeError('Issue policy workflow must define jobs')
      expect(Object.keys(policy.jobs)).toEqual(['disabled'])
      expect(JSON.stringify(policy)).not.toMatch(/secrets\.|create-github-app-token|PROJECT_TOKEN/)
      return
    }
    const policyJob = workflowJob(policy, 'policy')
    if (!Array.isArray(policyJob.steps)) throw new TypeError('Issue policy job must define steps')
    const steps = policyJob.steps.filter(isRecord)
    const tokenStep = steps.find(step => step.name === 'Create Project read token')
    const validateStep = steps.find(step => step.name === 'Validate pull request')
    const humanPullRequest =
      "${{ github.event.pull_request.user.type != 'Bot' && github.event.pull_request.user.type != 'App' }}"

    expect(tokenStep).toMatchObject({
      id: 'app-token',
      if: humanPullRequest,
      uses: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
      with: {
        'client-id': '${{ vars.DSH_ISSUE_APP_CLIENT_ID }}',
        'private-key': '${{ secrets.DSH_ISSUE_APP_PRIVATE_KEY }}',
        owner: 'deepseek-harness',
        repositories: 'deepseek-harness',
        'permission-issues': 'read',
        'permission-organization-projects': 'read',
      },
    })
    expect(validateStep).toMatchObject({
      if: humanPullRequest,
      env: {
        GITHUB_TOKEN: '${{ github.token }}',
        PROJECT_TOKEN: '${{ steps.app-token.outputs.token }}',
      },
    })
  })
})

describe('npm release workflows', () => {
  it('keeps credential-free pack jobs in the release workflows', () => {
    // Pull requests retain tarball verification without registry credentials.
    for (const file of ['release.yml', 'release-vendor.yml']) {
      const workflow = loadWorkflow(`.github/workflows/${file}`)
      if (!isRecord(workflow.jobs)) throw new TypeError(`${file} must define jobs`)
      expect(Object.keys(workflow.jobs).sort()).toEqual(file === 'release.yml' ? ['dependencies', 'pack'] : ['pack'])
    }
  })

  it('runs dependency policy and npm layout checks in the DSH release workflow', () => {
    const workflow = loadWorkflow('.github/workflows/release.yml')
    const dependencies = workflowJob(workflow, 'dependencies')
    if (!isRecord(workflow.on) || !Array.isArray(dependencies.steps)) {
      throw new TypeError('DSH release workflow must define triggers and dependency steps')
    }
    const commands = dependencies.steps.flatMap(step =>
      isRecord(step) && typeof step.run === 'string' ? [step.run] : [])

    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(commands).toContain('pnpm run verify-package-dependencies')
    expect(commands).toContain('pnpm run verify-npm-install-layout')
  })
})

describe('Documentation site publication', () => {
  it('keeps Pages deployment dispatch-only from a dsh-v* tag', () => {
    const workflow = loadWorkflow('.github/workflows/docs-pages.yml')
    const build = workflowJob(workflow, 'build')
    const deploy = workflowJob(workflow, 'deploy')
    if (!isRecord(workflow.on) || !isRecord(workflow.env) || !Array.isArray(build.steps)) {
      throw new TypeError('Documentation deployment must define on, env, and build steps')
    }

    // The site presents a released snapshot: a merge must never publish it, and
    // publication must never appear as a PR check.
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])

    // RELEASE_PUBLISH makes release:verify reject every ref that is not a dsh-v*
    // tag naming this tree's version, so the site and the npm sequence share one
    // definition of a released version.
    const steps = build.steps.filter(isRecord)
    const verify = steps.find(step => step.name === 'Verify release version')
    const checkout = steps.find(
      step => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
    )
    expect(verify).toMatchObject({
      env: { RELEASE_PUBLISH: 'true' },
      run: 'pnpm run release:verify --family dsh',
    })
    // Complete history: the release scripts read tags.
    expect(checkout).toMatchObject({ with: { 'fetch-depth': 0 } })

    // Projected source links stay on the public repository's master. That
    // repository advances only to each release commit, so its master never
    // carries unreleased work, while it retains only the most recent tags:
    // following the dispatched tag would leave every source link on a deploy
    // from an older tag unresolvable.
    expect(workflow.env.DOCS_REPOSITORY_REF).toBe('master')

    // The environment owns the deployment tag policy and the required reviewers.
    expect(deploy.environment).toMatchObject({ name: 'github-pages' })
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
