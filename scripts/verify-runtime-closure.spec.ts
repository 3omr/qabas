import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'

const roots: string[] = []

function fixture(files: Record<string, string | Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-closure-'))
  roots.push(root)
  for (const [relative, value] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  }
  return root
}

function workspace(root: string, name: string, manifest: Record<string, unknown>): void {
  const packageName = name.replace('@scope/', '')
  const path = join(root, 'packages/core', packageName, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyRuntimeClosure', () => {
  it('checks required peers reached through application entry packages', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: { '@scope/app': 'workspace:^' } },
      'apps/cli/package.json': { name: '@scope/app', dependencies: { '@scope/plugin': 'workspace:^' } },
      'packages/preset/agent-presets/presets/minimal/agent.cordis.yml': '[]\n',
    })
    workspace(root, '@scope/plugin', { peerDependencies: { '@scope/service': 'workspace:^' } })
    workspace(root, '@scope/service', {})
    expect((await verifyRuntimeClosure(root)).failures).toEqual([
      'runtime -> @scope/app -> @scope/plugin -> @scope/service',
    ])
    writeFileSync(join(root, 'apps/desktop-runtime/package.json'), JSON.stringify({
      name: 'runtime', dependencies: { '@scope/app': 'workspace:^', '@scope/service': 'workspace:^' },
    }))
    expect((await verifyRuntimeClosure(root)).failures).toEqual([])
  })

  it('requires only plugins active for each published target', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: { '@scope/shared': 'workspace:^' } },
      'packages/preset/agent-presets/presets/standard/agent.cordis.yml': `
- id: tools
  name: cordis:group
  group: true
  config:
    - id: shared
      name: '@scope/shared'
    - id: linux
      name: '@scope/linux'
      disabled: !!js process.platform !== 'linux'
    - id: macos
      name: '@scope/macos'
      disabled: !!js process.platform !== 'darwin'
    - id: windows
      name: '@scope/windows'
      disabled: !!js process.platform !== 'win32'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(1)
    expect(result.failures).toEqual([
      'standard preset -> @scope/linux (linux)',
      'standard preset -> @scope/macos (darwin)',
      'standard preset -> @scope/windows (win32)',
    ])
  })

  it('treats an unsupported disabled expression as active on every target', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: {} },
      'packages/preset/agent-presets/presets/standard/agent.cordis.yml': `
- id: conditional
  name: '@scope/conditional'
  disabled: !!js process.env.DSH_DISABLE_CONDITIONAL === '1'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/conditional (darwin, linux, win32)',
    ])
  })

  it('does not interpret an ordinary plugin array config as nested Loader entries', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': 'workspace:^' } },
      'packages/preset/agent-presets/presets/standard/agent.cordis.yml': `
- id: plugin
  name: '@scope/plugin'
  config:
    - name: '@scope/config-value'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([])
  })

  it('requires preset plugins to be linked from the workspace', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: { '@scope/plugin': '1.2.3' } },
      'packages/preset/agent-presets/presets/standard/agent.cordis.yml': `
- id: plugin
  name: '@scope/plugin'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/plugin [runtime dependency is "1.2.3"; expected workspace:] (darwin, linux, win32)',
    ])
  })

  it('fails when no shipped preset is discovered', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: {} },
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(0)
    expect(result.failures).toEqual([
      'no agent presets matched packages/preset/agent-presets/presets/*/agent.cordis.yml',
    ])
  })

  it('retains the required workspace-peer closure check', async () => {
    const root = fixture({
      'apps/desktop-runtime/package.json': { name: 'runtime', dependencies: { '@scope/root': 'workspace:^' } },
      'packages/preset/agent-presets/presets/minimal/agent.cordis.yml': '[]\n',
    })
    workspace(root, '@scope/root', {
      peerDependencies: { '@scope/required': 'workspace:^', '@scope/optional': 'workspace:^' },
      peerDependenciesMeta: { '@scope/optional': { optional: true } },
    })
    workspace(root, '@scope/required', {})
    workspace(root, '@scope/optional', {})

    const result = await verifyRuntimeClosure(root)

    expect(result.workspacePackageCount).toBe(1)
    expect(result.failures).toEqual(['runtime -> @scope/root -> @scope/required'])
  })
})
