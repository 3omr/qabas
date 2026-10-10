// Fake CLI only: no credentials, model or network access.
import { readFileSync, writeFileSync, readdirSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'models') {
  writeSync(1, 'gemini-3.8-flash-low\tGemini Flash\nother\tOther model\n')
  process.exit(0)
}
if (readdirSync(process.cwd()).join() !== 'prompt.md') throw new Error('model workspace must hold only prompt.md')
if (args[args.indexOf('-p') + 1].length > 1_000) throw new Error('prompt must not travel through argv')
const prompt = readFileSync('prompt.md', 'utf8')
if (!prompt.includes('"messages"')) throw new Error('prompt.md must hold the rendered conversation')
const schema = JSON.parse(readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8'))
if (!schema.properties.tool_calls || !args.includes('--sandbox')) throw new Error('missing model-only flags')
const model = args[args.indexOf('--model') + 1]
if (model.startsWith('wait:')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync(model.slice(5), JSON.stringify({ parent: process.pid, child: child.pid, cwd: process.cwd() }))
  setInterval(() => {}, 1000)
} else {
  const answer = { text: model === 'size' ? `prompt bytes ${Buffer.byteLength(prompt)}` : 'Hello student', tool_calls: [] }
  if (model === 'tool') answer.tool_calls = [{ name: 'library', arguments_json: '{"query":"shock"}' }]
  if (model === 'unknown') answer.tool_calls = [{ name: 'shell', arguments_json: '{}' }]
  if (model === 'array') answer.tool_calls = [{ name: 'library', arguments_json: '[]' }]
  if (model === 'invalid-json') answer.tool_calls = [{ name: 'library', arguments_json: '{' }]
  if (model === 'nested') { delete answer.tool_calls; answer.text = '```json\n' + JSON.stringify({ text: 'Unwrapped answer', tool_calls: [] }) + '\n```' }
  const errors = { reset: 'connection reset by peer', eligibility: 'Eligibility check failed', signin: 'not-signed-in', quota: 'quota exhausted' }
  writeSync(1, JSON.stringify(model in errors ? { status: 'ERROR', errors: [errors[model]] }
    : { status: 'SUCCESS', structured_output: answer, usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } }) + "\n")
}
