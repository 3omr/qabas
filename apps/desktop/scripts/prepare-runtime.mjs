/** Materialize the production Harness closure and the builder's Node executable for Tauri. */

import { createReadStream } from 'node:fs'
import {
  copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { prepareRuntimeOutput } from './runtime-output.mjs'
import { assertNativeBuildHost, rebuildNativePackage } from './runtime-native.mjs'
import { preparePackageManager } from './runtime-package-manager.mjs'
import { prepareMarketplace } from './runtime-marketplace.mjs'
import { agentProbeManifest } from './runtime-agent-probes.mjs'

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopDir, '../..')
const targetPlatform = process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.DSH_DESKTOP_TARGET_ARCH ?? process.arch
const output = resolve(process.env.DSH_DESKTOP_RUNTIME_OUTPUT ?? join(desktopDir, 'resources/runtime'))
const appOutput = join(output, 'app')
const nodeOutput = join(output, 'node', targetPlatform === 'win32' ? 'node.exe' : 'node')
const nodeVersion = '22.22.0'
const nodeDistributions = {
  'linux-x64': {
    archive: `node-v${nodeVersion}-linux-x64.tar.gz`,
    sha256: 'c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744',
    binary: `node-v${nodeVersion}-linux-x64/bin/node`,
  },
  'darwin-arm64': {
    archive: `node-v${nodeVersion}-darwin-arm64.tar.gz`,
    sha256: '5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640',
    binary: `node-v${nodeVersion}-darwin-arm64/bin/node`,
  },
  'darwin-x64': {
    archive: `node-v${nodeVersion}-darwin-x64.tar.gz`,
    sha256: '5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce',
    binary: `node-v${nodeVersion}-darwin-x64/bin/node`,
  },
  'win32-arm64': {
    archive: `node-v${nodeVersion}-win-arm64.zip`,
    sha256: '5b44fd410df7b4cd0a1891a05a7b606f8fb7d8786a94997b996a372e82478d7a',
    binary: `node-v${nodeVersion}-win-arm64/node.exe`,
  },
  'win32-x64': {
    archive: `node-v${nodeVersion}-win-x64.zip`,
    sha256: 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a',
    binary: `node-v${nodeVersion}-win-x64/node.exe`,
  },
}

async function run(command, args, cwd, shell = false, env = process.env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell, env })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} exited with ${code ?? signal}`))
    })
  })
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function ensureArchive(distribution) {
  const cache = join(desktopDir, '.runtime-cache')
  const archive = join(cache, distribution.archive)
  const partial = `${archive}.part`
  await mkdir(cache, { recursive: true })
  let valid = false
  try {
    valid = await sha256(archive) === distribution.sha256
  } catch {}
  if (!valid) {
    try { await rename(archive, partial) } catch {}
    await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--retry', '10', '--retry-all-errors',
      '--continue-at', '-', '--output', partial,
      `https://nodejs.org/dist/v${nodeVersion}/${distribution.archive}`,
    ], repoRoot)
    await rename(partial, archive)
  }
  const actual = await sha256(archive)
  if (actual !== distribution.sha256) {
    await rm(archive, { force: true })
    throw new Error(`Node.js archive checksum mismatch: expected ${distribution.sha256}, got ${actual}`)
  }
  return archive
}

/**
 * Copy the Claude SDK's per-platform native payload into the deployed closure.
 *
 * `pnpm deploy` carries direct dependencies over but drops the SDK's OPTIONAL
 * platform packages, so the closure holds the SDK without the native payload
 * it loads and agentProbeManifest fails resolving it. @openai/codex, a direct
 * dependency, survives the same deploy untouched -- which is what isolates
 * this to optional dependencies rather than to the target platform.
 * @param {string} appOutput - Deployed application root.
 */
async function materializeAgentPayload(appOutput) {
  const name = `@anthropic-ai/claude-agent-sdk-${targetPlatform}-${targetArch}`
  const destination = join(appOutput, 'node_modules', name)
  if (await stat(destination).then(() => true, () => false)) return
  const sdk = createRequire(join(repoRoot, 'packages/subagent/subagent-claude-code/lib/index.js'))
    .resolve('@anthropic-ai/claude-agent-sdk')
  const source = dirname(createRequire(sdk).resolve(`${name}/package.json`))
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

async function installNodeRuntime() {
  const key = `${targetPlatform}-${targetArch}`
  const distribution = nodeDistributions[key]
  if (distribution === undefined) {
    throw new Error(`Unsupported desktop target ${key}; supported targets: ${Object.keys(nodeDistributions).join(', ')}`)
  }
  const archive = await ensureArchive(distribution)
  const unpack = join(desktopDir, '.runtime-cache', `unpack-${key}`)
  await rm(unpack, { recursive: true, force: true })
  await mkdir(unpack, { recursive: true })
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archive, '-C', unpack], repoRoot)
  await copyFile(join(unpack, distribution.binary), nodeOutput)
  if (targetPlatform !== 'win32') {
    const mode = (await stat(join(unpack, distribution.binary))).mode & 0o777
    await import('node:fs/promises').then(fs => fs.chmod(nodeOutput, mode | 0o500))
  }
  await rm(unpack, { recursive: true, force: true })
}

async function materializeLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if ((await lstat(path)).isSymbolicLink()) {
      const target = await realpath(path)
      const targetStat = await stat(target)
      await unlink(path)
      if (targetStat.isDirectory()) {
        await cp(target, path, { recursive: true, dereference: true })
      } else {
        await copyFile(target, path)
      }
      continue
    }
    if (entry.isDirectory()) await materializeLinks(path)
  }
}

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`Desktop runtime still contains a symbolic link: ${path}`)
    }
    if (entry.isDirectory()) await assertNoLinks(path)
  }
}

async function assertRuntimeTarget() {
  const required = [
    nodeOutput,
    join(
      appOutput,
      'node_modules',
      '@koromix',
      `koffi-${targetPlatform}-${targetArch}`,
      'package.json',
    ),
    join(
      appOutput,
      'node_modules',
      '@img',
      `sharp-${targetPlatform}-${targetArch}`,
      'package.json',
    ),
  ]
  if (targetPlatform === 'win32') {
    required.push(join(
      appOutput,
      'node_modules',
      'node-pty',
      'prebuilds',
      `win32-${targetArch}`,
      'conpty.node',
    ))
  }
  for (const path of required) {
    try {
      await stat(path)
    } catch (error) {
      throw new Error(`Desktop runtime target file is missing: ${path}`, { cause: error })
    }
  }
  await assertNoLinks(join(appOutput, 'node_modules'))
  await run(nodeOutput, [
    '--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { rejects } from 'node:assert/strict';
      const require = createRequire(import.meta.url);
      for (const name of ['node-pty', 'koffi', 'sharp']) require(name);
      if (process.platform !== 'win32') {
        const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock');
        await rejects(tryLockExclusive(-1), { code: 'EBADF', syscall: 'flock' });
      }
    `,
  ], appOutput)
}

async function pruneForeignNodePtyPrebuilds() {
  const prebuilds = join(appOutput, 'node_modules', 'node-pty', 'prebuilds')
  const keep = `${targetPlatform}-${targetArch}`
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== keep) {
      await rm(join(prebuilds, entry.name), { recursive: true, force: true })
    }
  }
}

async function pruneDevelopmentArtifacts(directory) {
  let pruned = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      pruned += await pruneDevelopmentArtifacts(path)
      continue
    }
    if (
      entry.name.endsWith('.map')
      || entry.name.endsWith('.d.ts')
      || entry.name.endsWith('.d.mts')
      || entry.name.endsWith('.d.cts')
    ) {
      await rm(path, { force: true })
      pruned += 1
    }
  }
  return pruned
}

function includeInStaging(source) {
  const path = relative(repoRoot, source)
  if (path === '') return true
  const segments = path.split(sep)
  if (segments.includes('.git') || segments.includes('node_modules')) return false
  if (path === join('apps', 'desktop', '.runtime-cache') || path.startsWith(`${join('apps', 'desktop', '.runtime-cache')}${sep}`)) return false
  if (path === join('apps', 'desktop', 'resources', 'runtime') || path.startsWith(`${join('apps', 'desktop', 'resources', 'runtime')}${sep}`)) return false
  if (path === join('apps', 'desktop', 'resources', 'marketplace') || path.startsWith(`${join('apps', 'desktop', 'resources', 'marketplace')}${sep}`)) return false
  if (path === join('apps', 'desktop', 'src-tauri', 'target') || path.startsWith(`${join('apps', 'desktop', 'src-tauri', 'target')}${sep}`)) return false
  return true
}

async function deployRuntime() {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-deploy-'))
  const stagingWorkspace = join(stagingRoot, 'workspace')
  try {
    await cp(repoRoot, stagingWorkspace, {
      recursive: true,
      dereference: false,
      filter: includeInStaging,
    })
    await run(
      process.platform === 'win32' ? 'corepack.cmd' : 'corepack',
      [
        'pnpm', '--config.node-linker=hoisted', '--filter', '@deepseek-ai/dsh-desktop-runtime',
        '--os', targetPlatform, '--cpu', targetArch,
        '--ignore-scripts', '--prod', 'deploy', '--legacy', appOutput,
      ],
      stagingWorkspace,
      process.platform === 'win32',
    )
    if (targetPlatform === process.platform && targetArch === process.arch) {
      await rebuildProductionScripts()
    }
    await materializeLinks(join(appOutput, 'node_modules'))
    await materializeAgentPayload(appOutput)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

async function rebuildProductionScripts() {
  for (const name of ['node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local']) {
    await rebuildNativePackage(join(appOutput, 'node_modules', name), nodeVersion, targetArch)
  }
}

assertNativeBuildHost(targetPlatform, targetArch)
await prepareRuntimeOutput(output, [repoRoot, homedir()])
await mkdir(dirname(nodeOutput), { recursive: true })
await deployRuntime()
await installNodeRuntime()
const pnpmVersion = await preparePackageManager(output)
await pruneForeignNodePtyPrebuilds()
const prunedDevelopmentArtifacts = await pruneDevelopmentArtifacts(appOutput)
await assertRuntimeTarget()
await copyFile(join(desktopDir, 'runtime/desktop.cordis.yml'), join(output, 'desktop.cordis.yml'))
await prepareMarketplace(join(output, 'marketplace'), nodeOutput, join(output, 'tools/pnpm/bin/pnpm.mjs'), targetPlatform, targetArch)
await copyFile(join(repoRoot, 'THIRD_PARTY_NOTICES.md'), join(output, 'THIRD_PARTY_NOTICES.md'))
const rootPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
await writeFile(join(output, 'agent-runtimes.json'), `${JSON.stringify(await agentProbeManifest(output, {
  codex: join(appOutput, 'node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js'),
  claude: join(appOutput, 'node_modules/@deepseek-ai/dsh-subagent-claude-code/lib/index.js'),
}, targetPlatform, targetArch), null, 2)}\n`)
await writeFile(join(output, 'runtime-manifest.json'), `${JSON.stringify({
  harnessVersion: rootPackage.version,
  nodeVersion: `v${nodeVersion}`,
  pnpmVersion,
  platform: targetPlatform,
  arch: targetArch,
}, null, 2)}\n`)

console.log(`desktop runtime (${targetPlatform}-${targetArch}): ${output}`)
console.log(`pruned ${prunedDevelopmentArtifacts} declaration/source-map file(s) from the desktop runtime`)
