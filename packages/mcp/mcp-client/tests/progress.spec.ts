/** MCP wire progress stays attached to its running native or nested call. */
import { Context } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { expect, it } from 'vitest'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { syncTools } from '../src/tools.ts'

it('requests tokens and records fake-server progress before the result for native and nested calls', async () => {
  const ctx = new Context()
  const client = new Client({ name: 'progress-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('progress-session'), { provider: 'fixture', model: 'fixture' })
    let requests = 0
    const reply = async (message: JSONRPCMessage): Promise<void> => {
      if (!('id' in message) || !('method' in message)) return
      if (message.method === 'initialize') {
        await serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'progress-server', version: '1' },
        } })
      } else if (message.method === 'tools/list') {
        await serverTransport.send({ jsonrpc: '2.0', id: message.id, result: {
          tools: [{ name: 'write', inputSchema: { type: 'object' } }],
        } })
      } else if (message.method === 'tools/call') {
        const token = message.params?._meta?.progressToken
        expect(token).toBeDefined()
        for (const done of [0, 1, 1, 2]) {
          await serverTransport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
            progressToken: token as number, progress: done, total: 2, message: `part ${Math.min(done + 1, 2)} of 2`,
          } })
        }
        requests += 1
        expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/progress')).toHaveLength(requests * 4)
        await serverTransport.send({ jsonrpc: '2.0', id: message.id,
          result: { content: [{ type: 'text', text: 'saved' }] } })
      }
    }
    serverTransport.onmessage = (message) => {
      void reply(message).catch((error: unknown) => {
        if (!('id' in message)) return
        void serverTransport.send({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
      })
    }
    await serverTransport.start()
    await client.connect(clientTransport)
    await syncTools(client, ctx, { registrationFailure: 'throw', serverName: 'fixture', toolCallTimeoutMs: 5000 }, new Map())
    for (const nested of [false, true]) {
      const callId = ToolCallId(nested ? 'nested' : 'native')
      const result = await ctx.tools.execute({ agent, signal: new AbortController().signal, callId,
        ...nested ? { rootCallId: ToolCallId('root') } : {}, name: 'mcp__fixture__write', arguments: {} })
      expect(result.isError).toBe(false)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/progress' && event.data.callId === callId))
        .toMatchObject([0, 1, 1, 2].map(done => ({ ignorable: true, data: {
          callId, rootCallId: nested ? 'root' : 'native', done, total: 2,
        } })))
    }
  } finally {
    await client.close()
    await serverTransport.close()
    await ctx.fiber.dispose()
  }
})
