/** Compact transport projection of the committed Omar Session request. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { renderPrompt } from '../src/prompt.ts'

it('pins the compact prompt reconstructed from the Omar recorded Session', async () => {
  const root = new URL('../../../../snapshots/session/omar-google-fallback/', import.meta.url)
  const [log, system, schemas] = await Promise.all([
    readFile(new URL('session.v3.jsonl', root), 'utf8'),
    readFile(new URL('system-prompt.expected.md', root), 'utf8'),
    readFile(new URL('tool-schemas.expected.json', root), 'utf8'),
  ])
  const messages: Message[] = []
  for (const line of log.trim().split('\n')) {
    const event = JSON.parse(line) as { type: string; data: Message & { message: Message } }
    if (event.type === 'request/header') break
    if (event.type === 'system/message') messages.push({ ...event.data.message, content: [{ type: 'text', text: system }] })
    if (event.type === 'user/message') messages.push(event.data)
  }
  const tools = JSON.parse(schemas) as ToolSchema[]
  const request: GenerateOptions = { provider: 'agy', model: 'gemini-3.8-flash-low', messages, tools }
  const prompt = renderPrompt(request)
  const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as unknown
  expect(payload).toEqual({ system: null, messages: messages.map(({ role, content }) => ({ role, content })), tools })
  expect({ bytes: Buffer.byteLength(prompt), sha256: createHash('sha256').update(prompt).digest('hex') }).toMatchSnapshot()
})
