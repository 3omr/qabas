/** Version and hosted-workflow checks for the desktop distribution. */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { checkWorkspaceManifest, type PackageManifest } from './check-workspace-constraints.ts'
import { verifyDesktopRelease, verifyDesktopVersions } from './verify-desktop-release.ts'

const root = resolve(import.meta.dirname, '..')

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

function publicationCommand(): string {
  const workflow = record(load(readFileSync(resolve(root, '.github/workflows/desktop.yml'), 'utf8')))
  const release = record(record(workflow.jobs).release)
  assert(Array.isArray(release.steps))
  const publish = release.steps.map(record).find(step => step.name === 'Publish installers and checksums')
  assert(typeof publish?.run === 'string')
  return publish.run
}

describe('desktop release', () => {
  // Publication runs on Ubuntu; Windows hosts do not supply its POSIX checksum tools.
  it.skipIf(process.platform === 'win32').each(['0.1.5-alpha.1', '0.1.5'])('publishes %s as an Alpha prerelease', (version) => {
    const directory = mkdtempSync(join(tmpdir(), 'qabas-alpha-release-'))
    try {
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      const argsFile = join(directory, 'arguments.txt')
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$DSH_RELEASE_TEST_ARGS"\n', { mode: 0o755 })
      writeFileSync(join(directory, 'Qabas preview.exe'), 'windows fixture')
      writeFileSync(join(directory, 'Qabas preview.dmg'), 'macos fixture')
      execFileSync('bash', ['-c', publicationCommand()], {
        cwd: directory, timeout: 10_000,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_REPO: 'example/qabas',
          RELEASE_TAG: `desktop-v${version}`, DSH_RELEASE_TEST_ARGS: argsFile },
      })
      const args = readFileSync(argsFile, 'utf8').trimEnd().split('\n')
      expect(args.slice(0, 3)).toEqual(['release', 'create', `desktop-v${version}`])
      expect(args).toContain('--prerelease')
      expect(args[args.indexOf('--title') + 1]).toBe(`Qabas Alpha ${version}`)
      expect(args).toEqual(expect.arrayContaining(['Qabas.preview.exe', 'Qabas.preview.dmg', 'SHA256SUMS']))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('gives native subprocess tests and cleanup the Windows lane budget', () => {
    const manifest = record(JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')))
    const command = record(manifest.scripts)['desktop:test']
    assert(typeof command === 'string')
    expect(command).toContain('--testTimeout=90000')
    expect(command).toContain('--hookTimeout=90000')
    expect(command).not.toMatch(/--retry|--no-file-parallelism|--passWithNoTests/)
  })

  it('packs only desktop source inputs rather than native build outputs', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')) as PackageManifest
    expect(manifest.files).toEqual([
      'loading', 'runtime', 'scripts',
      'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/icons',
      'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
      'src-tauri/entitlements.node.plist', 'src-tauri/tauri.conf.json', 'src-tauri/tauri.windows.conf.json',
      'README.md', 'README.zh.md',
    ])
    expect(checkWorkspaceManifest({ dir: 'apps/desktop', manifest })).toEqual([])
  })

  it('aligns the actual native and JavaScript manifests', () => {
    expect(() => {
      verifyDesktopRelease(root)
    }).not.toThrow()
  })

  it('accepts aligned preview versions and their exact desktop tag', () => {
    expect(() => {
      verifyDesktopVersions({
        'apps/desktop/package.json': '0.1.2-rc.1', native: '0.1.2-rc.1',
      }, 'desktop-v0.1.2-rc.1')
    }).not.toThrow()
  })

  it('rejects an absent application, a stale component, and a mismatched tag', () => {
    expect(() => {
      verifyDesktopVersions({})
    }).toThrow('application version is missing')
    expect(() => {
      verifyDesktopVersions({
        'apps/desktop/package.json': '0.1.2-rc.1', native: '0.1.1',
      })
    }).toThrow('native: desktop version must be 0.1.2-rc.1')
    expect(() => {
      verifyDesktopVersions({
        'apps/desktop/package.json': '0.1.2-rc.1',
      }, 'v0.1.2-rc.1')
    }).toThrow('Desktop tag must be desktop-v0.1.2-rc.1')
  })

  it('checks runtime changes on both native hosted targets before releasing', () => {
    const workflow = record(load(readFileSync(resolve(root, '.github/workflows/desktop.yml'), 'utf8')))
    expect(workflow.permissions).toEqual({ contents: 'read' })
    const triggers = record(workflow.on)
    expect(record(triggers.pull_request).paths).toEqual(expect.arrayContaining([
      'apps/**', 'packages/**', 'vendor/**', 'native/**', 'scripts/**', 'pnpm-lock.yaml',
    ]))
    expect(triggers.push).toEqual({ tags: ['desktop-v*'] })
    const jobs = record(workflow.jobs)
    const build = record(jobs.build)
    const matrix = record(record(build.strategy).matrix)
    expect(matrix.include).toEqual([
      { target: 'macos-arm64', runner: 'macos-15', artifact: 'harness-desktop-macos-arm64' },
      { target: 'windows-x64', runner: 'windows-2025', artifact: 'harness-desktop-windows-x64' },
    ])
    assert(Array.isArray(build.steps))
    const steps = build.steps.map(record)
    const commands = steps.map(step => step.run).filter((run): run is string => typeof run === 'string')
    for (const command of [
      'pnpm install --frozen-lockfile', 'pnpm run desktop:prepare', 'pnpm run desktop:smoke',
      'pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install chromium',
      'pnpm run desktop:smoke:plugins',
      'pnpm exec vitest run scripts/desktop-package-manager.spec.ts --testTimeout=90000 --hookTimeout=90000',
      'pnpm run desktop:test', 'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml',
      'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml packaged_provider_and_preset_smoke -- --ignored',
      'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml packaged_profile_selection_and_recovery -- --ignored',
      'cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml packaged_skill_lifecycle -- --ignored',
    ]) expect(commands).toContain(command)
    expect(steps.find(step => step.name === 'Verify release tag matches the application version')).toMatchObject({
      if: "startsWith(github.ref, 'refs/tags/desktop-v')",
      run: 'pnpm exec tsx scripts/verify-desktop-release.ts "${{ github.ref_name }}"',
    })
    const uploads = steps.filter(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'))
    expect(uploads).toHaveLength(2)
    expect(uploads.map(step => record(step.with).path)).toEqual([
      'apps/desktop/src-tauri/target/release/bundle/dmg/*.dmg',
      'apps/desktop/src-tauri/target/release/bundle/nsis/*.exe',
    ])
    for (const upload of uploads) expect(record(upload.with)['if-no-files-found']).toBe('error')
    expect(jobs.release).toMatchObject({
      needs: 'build', if: "startsWith(github.ref, 'refs/tags/desktop-v')",
      'runs-on': 'ubuntu-latest', permissions: { contents: 'write' },
    })
    const release = record(jobs.release)
    assert(Array.isArray(release.steps))
    const publish = release.steps.map(record).find(step => step.name === 'Publish installers and checksums')
    assert(typeof publish?.run === 'string')
    expect(publish.run).toContain('sha256sum')
    expect(publish.run).toContain('normalized="${file// /.}"')
    expect(publish.run.indexOf('normalized=')).toBeLessThan(publish.run.indexOf('sha256sum'))
    expect(publish.run).toContain('--verify-tag')
    expect(publish.run).toContain('--prerelease')
    expect(publish.run).toContain('not notarized')
    expect(publish.run).toContain('Windows x64: unsigned')
    expect(publish.run).toContain('Automatic updates are not configured')
    expect(publish.run).toContain('--notes "$notes"')
    expect(publish.run).not.toContain('--clobber')
  })
})
