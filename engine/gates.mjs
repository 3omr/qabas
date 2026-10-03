/** Run the Python engine's checks independently of the caller's working directory. */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const venv = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const python = existsSync(venv) ? venv : 'python3'
const commands = {
  test: ['-m', 'unittest', 'discover', '-s', 'tests', '-t', 'tests', '-v'],
  lint: ['-m', 'ruff', 'check', '.'],
  typecheck: ['-m', 'mypy'],
}
const args = commands[process.argv[2]]
if (args === undefined) throw new Error('Expected test, lint, or typecheck')
const result = spawnSync(python, args, { cwd: root, stdio: 'inherit', env: { ...process.env, TRANSCRIBER_AGY: 'off' } })
if (result.error !== undefined) throw result.error
process.exit(result.status ?? 1)
