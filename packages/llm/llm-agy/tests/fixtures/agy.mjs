// Fake CLI only: no credentials, model or network access.
import { readFileSync, writeFileSync, readdirSync, writeSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'models') {
  writeSync(1, 'gemini-3.8-flash-low\tGemini Flash\nother\tOther model\n')
  process.exit(0)
}
if (readdirSync(process.cwd()).length !== 0) throw new Error('model workspace must be empty')
if (!args.includes('--input-format') || !args.includes('stream-json') || !args.includes('--disable-slash-commands')) throw new Error('stdin protocol flags missing')
const input = readFileSync(0, 'utf8')
const message = JSON.parse(input)
if (message.event !== 'user') throw new Error('stdin must contain one user event')
const prompt = message.message.content
if (!prompt.includes('"messages"')) throw new Error('stdin must hold the rendered conversation')
const emit = event => writeSync(1, JSON.stringify(event) + '\n')
const delta = text => emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } })
const schema = JSON.parse(readFileSync(args[args.indexOf('--json-schema') + 1], 'utf8'))
if (!schema.properties.tool_calls || !args.includes('--sandbox')) throw new Error('missing model-only flags')
const model = args[args.indexOf('--model') + 1]
if (model.startsWith('wait:')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  delta('{"text":"Hello')
  writeFileSync(model.slice(5), JSON.stringify({ parent: process.pid, child: child.pid, cwd: process.cwd() }))
  setInterval(() => {}, 1000)
} else {
  const answer = { text: model === 'size' ? `prompt bytes ${Buffer.byteLength(prompt)}` : 'Hello student', tool_calls: [] }
  if (model === 'tool') answer.tool_calls = [{ name: 'library', arguments_json: '{"query":"shock"}' }]
  if (model === 'partial-unknown') delta('{"text":"Hello')
  if (model === 'mismatch') delta('{"text":"Different')
  if (model === 'unknown' || model === 'partial-unknown') answer.tool_calls = [{ name: 'shell', arguments_json: '{}' }]
  if (model === 'array') answer.tool_calls = [{ name: 'library', arguments_json: '[]' }]
  if (model === 'invalid-json') answer.tool_calls = [{ name: 'library', arguments_json: '{' }]
  if (model === 'nested') { delete answer.tool_calls; answer.text = '```json\n' + JSON.stringify({ text: 'Unwrapped answer', tool_calls: [] }) + '\n```' }
  const errors = { reset: 'connection reset by peer', eligibility: 'Eligibility check failed', signin: 'not-signed-in', quota: 'quota exhausted' }
  if (model in errors) process.exitCode = 3
  const result = model in errors ? { status: 'ERROR', errors: [errors[model]] }
    : { status: 'SUCCESS', structured_output: answer, usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } }
  if (model.startsWith('stream:')) {
    delta('{"text":"Hello')
    writeFileSync(model.slice(7), JSON.stringify({ parent: process.pid, cwd: process.cwd() }))
    const timer = setInterval(() => {
      if (!existsSync(model.slice(7) + '.release')) return
      clearInterval(timer)
      delta(' student","tool_calls":[]}')
      emit({ event: 'result', result })
    }, 10)
  } else {
    // agy closes every schema answer with its internal finish tool before the result.
    emit({ event: 'step_update', step_update: { step_index: 4, step_type: 'tool', tool_name: 'finish', state: 'DONE' } })
    emit({ event: 'result', result })
  }
}
