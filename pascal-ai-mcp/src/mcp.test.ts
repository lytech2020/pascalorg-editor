import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AppConfig } from './config'
import { mcpErrorMessage, PascalMcpClient, type McpConnectionFactory } from './mcp'

class FakeClient {
  onclose?: () => void
  onerror?: (error: Error) => void
  connectCalls = 0
  closeCalls = 0
  pingCalls = 0
  toolCalls = 0
  connectError?: Error
  toolError?: Error

  async connect(): Promise<void> {
    this.connectCalls++
    if (this.connectError) throw this.connectError
  }

  async close(): Promise<void> {
    this.closeCalls++
  }

  async ping(): Promise<Record<string, never>> {
    this.pingCalls++
    return {}
  }

  async listTools(): Promise<{ tools: [] }> {
    return { tools: [] }
  }

  async callTool(): Promise<{ isError: false; content: [] }> {
    this.toolCalls++
    if (this.toolError) throw this.toolError
    return { isError: false, content: [] }
  }

  async readResource(): Promise<{ contents: [] }> {
    return { contents: [] }
  }

  async getPrompt(): Promise<{ messages: [] }> {
    return { messages: [] }
  }
}

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mcpRequestTimeoutMs: 100,
    mcpReconnectMaxAttempts: 2,
    mcpReconnectBaseDelayMs: 1,
    mcpCircuitCooldownMs: 1,
    ...overrides,
  } as AppConfig
}

function factory(...clients: FakeClient[]): McpConnectionFactory {
  let index = 0
  return () => {
    const client = clients[index++]
    if (!client) throw new Error('fake connection factory exhausted')
    return {
      client: client as unknown as Client,
      transport: {} as Transport,
    }
  }
}

describe('PascalMcpClient connection lifecycle (T2.5)', () => {
  test('bounds initial connection attempts and exposes only a stable error code', async () => {
    const first = new FakeClient()
    first.connectError = new Error('ECONNREFUSED secret-hostname')
    const second = new FakeClient()
    second.connectError = new Error('ECONNREFUSED secret-hostname')
    const mcp = new PascalMcpClient(config(), factory(first, second))

    await expect(mcp.connect()).rejects.toThrow('secret-hostname')
    expect(first.connectCalls).toBe(1)
    expect(second.connectCalls).toBe(1)
    expect(mcp.status()).toMatchObject({
      ready: false,
      state: 'degraded',
      failureCount: 1,
      lastErrorCode: 'connection_refused',
    })
    expect(JSON.stringify(mcp.status())).not.toContain('secret-hostname')
  })

  test('recovers after the initial bounded connection attempts fail', async () => {
    const first = new FakeClient()
    first.connectError = new Error('ECONNREFUSED first-secret-host')
    const second = new FakeClient()
    second.connectError = new Error('ECONNREFUSED second-secret-host')
    const recovered = new FakeClient()
    const mcp = new PascalMcpClient(config(), factory(first, second, recovered))

    await expect(mcp.connect()).rejects.toThrow('second-secret-host')
    expect(mcp.status()).toMatchObject({ ready: false, state: 'degraded', generation: 2 })

    await Bun.sleep(2)
    expect(await mcp.checkReady()).toBe(true)
    expect(recovered.connectCalls).toBe(1)
    expect(recovered.pingCalls).toBe(1)
    expect(mcp.status()).toMatchObject({ ready: true, state: 'ready', generation: 3 })
  })

  test('retires a closed generation and reconnects without reusing it', async () => {
    const first = new FakeClient()
    const second = new FakeClient()
    const mcp = new PascalMcpClient(config({ mcpCircuitCooldownMs: 20 }), factory(first, second))
    await mcp.connect()
    expect(mcp.status()).toMatchObject({ ready: true, state: 'ready', generation: 1 })

    first.onclose?.()
    expect(mcp.status()).toMatchObject({
      ready: false,
      state: 'degraded',
      lastErrorCode: 'connection_closed',
    })
    expect(await mcp.checkReady()).toBe(false)

    await Bun.sleep(25)
    expect(await mcp.checkReady()).toBe(true)
    expect(second.connectCalls).toBe(1)
    expect(second.pingCalls).toBe(1)
    expect(mcp.status()).toMatchObject({ ready: true, state: 'ready', generation: 2 })

    first.onclose?.()
    expect(mcp.status()).toMatchObject({ ready: true, state: 'ready', generation: 2 })
    await mcp.close()
    expect(mcp.status()).toMatchObject({ ready: false, state: 'closed' })
  })

  test('never replays a failed mutating tool call on the replacement connection', async () => {
    const first = new FakeClient()
    first.toolError = new Error('EPIPE while writing request')
    const second = new FakeClient()
    const mcp = new PascalMcpClient(config(), factory(first, second))
    await mcp.connect()

    await expect(mcp.callTool('create_room', { name: 'Bedroom' })).rejects.toThrow('EPIPE')
    expect(first.toolCalls).toBe(1)
    expect(second.toolCalls).toBe(0)
    expect(mcp.status().ready).toBe(false)

    await Bun.sleep(2)
    await mcp.callTool('create_room', { name: 'Bedroom' })
    expect(first.toolCalls).toBe(1)
    expect(second.toolCalls).toBe(1)
  })
})

describe('MCP errors', () => {
  test('extracts textual tool failure details', () => {
    expect(
      mcpErrorMessage({
        isError: true,
        content: [{ type: 'text', text: 'save_failed: database unavailable' }],
      }),
    ).toBe('save_failed: database unavailable')
  })

  test('falls back when a server omits error details', () => {
    expect(mcpErrorMessage({ isError: true })).toBe('unknown error')
  })

  test('redacts secrets from textual tool failures before they reach callers', () => {
    const output = mcpErrorMessage({
      isError: true,
      content: [{
        type: 'text',
        text: 'save_failed Authorization:Bearer-secret Cookie=session-secret data:image/png;base64,cHJpdmF0ZQ==',
      }],
    })
    expect(output).toContain('save_failed')
    expect(output).not.toContain('Bearer-secret')
    expect(output).not.toContain('session-secret')
    expect(output).not.toContain('cHJpdmF0ZQ==')
  })
})
