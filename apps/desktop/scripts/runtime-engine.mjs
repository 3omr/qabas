/** Copy the target-native Python sidecar into Tauri's existing runtime resource tree. */
import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Install the app-owned engine and its profile patch; refuse a missing build.
 * @param repoRoot - repository holding engine/dist.
 * @param appOutput - deployed desktop app directory.
 * @param target - native platform and architecture already verified by preparation.
 * @returns completion after both runtime files are copied.
 */
export async function prepareEngine(repoRoot, appOutput, target) {
  const architecture = { x64: 'x86_64', arm64: 'aarch64' }[target.arch]
  const system = { linux: 'unknown-linux-gnu', darwin: 'apple-darwin', win32: 'pc-windows-msvc' }[target.platform]
  if (architecture === undefined || system === undefined) throw new Error(`Unsupported engine target ${target.platform}-${target.arch}`)
  const extension = target.platform === 'win32' ? '.exe' : ''
  const artifact = join(repoRoot, 'engine/dist', `transcriber-engine-${architecture}-${system}${extension}`)
  const engine = join(appOutput, 'engine')
  await mkdir(engine, { recursive: true })
  try {
    await copyFile(artifact, join(engine, `transcriber-engine${extension}`))
  } catch (error) {
    throw new Error(`Missing native engine build at ${artifact}; run pnpm run engine:build on this target first`, { cause: error })
  }
  await copyFile(join(repoRoot, 'engine/transcriber.cordis.yml'), join(engine, 'transcriber.cordis.yml'))
}
