// Opt-in agy transport diagnostic; never imported by the offline test runner.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { renderPrompt } from '../src/prompt.ts'
import { AgyStream } from '../src/stream.ts'
import { parseResponse } from '../src/response.ts'
if (process.env.QABAS_AGY_LIVE !== '1') {
  console.log('Skipped: set QABAS_AGY_LIVE=1')
  process.exit(0)
}
const [mode = 'stdin', requestFile, ...extraFlags] = process.argv.slice(2)
if (!['file', 'stdin', 'argv'].includes(mode)) throw new Error('mode must be file, stdin or argv')
const request = requestFile ? JSON.parse(await readFile(requestFile, 'utf8')) : {
  provider: 'agy', model: 'gemini-3.8-flash-low', messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello in one sentence.' }] }],
}
const compact = renderPrompt(request)
const old = [
  'Answer the conversation below. Reading this prompt.md file was your only permitted tool use;',
  'do not use any other tools, files, shell, browser or MCP servers.',
  'Only request tools listed below by returning tool_calls. Qabas executes them and supplies their results.',
  'Return exactly the schema JSON: {"text": string, "tool_calls": [{"name": string, "arguments_json": string}]}.',
  'arguments_json must encode a JSON object. Use an empty tool_calls array for a final answer.',
  JSON.stringify({ system: request.system ?? null, messages: request.messages.map(({ role, content }) => ({ role, content })), tools: request.tools ?? [] }, null, 2),
].join('\n')
const prompt = mode === 'file' ? old : compact
const timeoutMs = Number(process.env.QABAS_AGY_TIMEOUT_MS ?? '180000')
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new Error('invalid QABAS_AGY_TIMEOUT_MS')
const directory = await mkdtemp(join(tmpdir(), 'qabas-agy-live-'))
const cwd = join(directory, 'work')
await mkdir(cwd, { mode: 0o700 })
const schema = { type: 'object', properties: { text: { type: 'string' }, tool_calls: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, arguments_json: { type: 'string' } }, required: ['name', 'arguments_json'], additionalProperties: false } } }, required: ['text', 'tool_calls'], additionalProperties: false }
await writeFile(join(directory, 'schema.json'), JSON.stringify(schema), { mode: 0o600 })
if (mode === 'file') await writeFile(join(cwd, 'prompt.md'), prompt, { mode: 0o600 })
const args = ['--model', request.model, '--effort', request.reasoningEffort ?? 'low', '--output-format', 'stream-json', '--json-schema', join(directory, 'schema.json'), '--sandbox', '--disable-slash-commands', ...extraFlags]
if (mode === 'stdin') args.push('--input-format', 'stream-json')
else args.push('-p', mode === 'file' ? 'Read the file prompt.md in the current working directory with your file-reading tool (do not run shell commands), all of it to the end, and follow its instructions exactly.' : prompt)
const started = performance.now()
const child = spawn(process.env.QABAS_AGY_EXECUTABLE ?? 'agy', args, { cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
const events = []
const decoder = new AgyStream()
let firstAnswerMs = null
let decodeMs = 0
let decodeError = null
let pending = ''
let stderr = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { stderr += chunk })
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  const decodeStarted = performance.now()
  if (decodeError === null) {
    try { decoder.feed(chunk, 4194304, () => { firstAnswerMs ??= performance.now() - started }) }
    catch (error) { decodeError = String(error) }
  }
  decodeMs += performance.now() - decodeStarted
  pending += chunk
  let end
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1)
    const parseStart = performance.now()
    let event
    try { event = JSON.parse(line) } catch { event = { raw: line } }
    const record = { ms: performance.now() - started, parseMs: performance.now() - parseStart, event }
    events.push(record)
    console.log(JSON.stringify(record))
  }
})
const terminate = () => {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL')
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
const timer = setTimeout(terminate, timeoutMs)
process.once('SIGINT', terminate)
if (mode === 'stdin') child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n')
else child.stdin.end()
try {
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  const init = events.find(({ event }) => event.event === 'init')
  const firstText = events.find(({ event }) => event.step_update?.text_delta)
  const steps = new Map()
  for (const record of events) {
    const step = record.event.step_update
    if (!step) continue
    const known = steps.get(step.step_index) ?? { firstMs: record.ms }
    steps.set(step.step_index, { ...known, lastMs: record.ms, ...step })
  }
  const result = events.find(({ event }) => event.event === 'result')?.event.result
  const parseStarted = performance.now()
  if (result && decodeError === null) {
    try { parseResponse(decoder.finish(), request) } catch (error) { decodeError = String(error) }
  }
  const outputParseMs = decodeMs + performance.now() - parseStarted
  const modelSteps = [...steps.values()].filter(step => step.step_type === 'agent_response')
  const fileReadSteps = [...steps.values()].filter(step => step.step_type === 'tool')
  const summary = { mode, oldPromptBytes: Buffer.byteLength(old), compactPromptBytes: Buffer.byteLength(compact),
    startupToInitMs: init?.ms ?? null, firstAnswerMs, outputParseMs: events.length === 0 ? null : outputParseMs, decodeError,
    modelSteps, fileReadSteps, firstTextMs: firstText?.ms ?? null, totalMs: performance.now() - started,
    parseMs: events.reduce((sum, event) => sum + event.parseMs, 0), steps: [...steps.values()],
    usage: result?.usage ?? null, conversationId: result?.conversation_id ?? init?.event.conversation_id ?? null,
    code, stderr }
  console.log(JSON.stringify(summary))
  // Tool duration is execution only; first/last times expose the preceding model wait separately.
  if (code !== 0) process.exitCode = 1
} finally {
  clearTimeout(timer)
  process.removeListener('SIGINT', terminate)
  terminate()
  await rm(directory, { recursive: true, force: true })
}
