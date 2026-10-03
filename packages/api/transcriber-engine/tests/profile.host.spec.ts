/** The app-owned MCP patch resolves source and frozen engines without a skill checkout. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { expect, it, vi } from 'vitest'
import TranscriberEngine from '../src/index.ts'

interface McpConfig { readonly command: string; readonly args: readonly string[]; readonly cwd: string }
const repo = resolve(import.meta.dirname, '../../../..')
const patch = load(readFileSync(join(repo, 'engine/transcriber.cordis.yml'), 'utf8'), { schema: entryListSchema }) as {
  insert: { config: { __jsExpr: string } }[]
}[]
const expression = patch[0]!.insert[0]!.config.__jsExpr
const context = { transcriberEngine: new TranscriberEngine(new Context()) }

it('uses the bundled source default regardless of cwd, and accepts both root overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'qabas-profile-'))
  vi.stubEnv('TRANSCRIBER_ENGINE_ROOT', '')
  vi.stubEnv('TRANSCRIBER_SKILL_ROOT', '')
  vi.stubEnv('TRANSCRIBER_WORKSPACE', root)
  try {
    const source = evaluate(context, expression) as McpConfig
    expect(source).toMatchObject({ command: 'python3', cwd: root })
    expect(source.args[0]).toBe(join(repo, 'engine/scripts/mcp_server.py'))
    const binary = join(root, process.platform === 'win32' ? 'transcriber-engine.exe' : 'transcriber-engine')
    writeFileSync(binary, '')
    vi.stubEnv('TRANSCRIBER_SKILL_ROOT', root)
    expect(evaluate(context, expression)).toMatchObject({ command: binary, args: ['mcp-server', '--workspace', root, '--workspace-file', expect.any(String)] })
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'scripts/mcp_server.py'), '')
    vi.stubEnv('TRANSCRIBER_ENGINE_ROOT', root)
    vi.stubEnv('TRANSCRIBER_SKILL_ROOT', join(root, 'missing'))
    expect((evaluate(context, expression) as McpConfig).args[0]).toBe(join(root, 'scripts/mcp_server.py'))
    vi.stubEnv('TRANSCRIBER_ENGINE_ROOT', join(root, 'missing'))
    expect(() => { evaluate(context, expression) }).toThrow('TRANSCRIBER_ENGINE_ROOT')
  } finally {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
