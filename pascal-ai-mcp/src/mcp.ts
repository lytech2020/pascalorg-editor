import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { AppConfig } from './config'
import { redactSensitiveText } from './error-policy'
import type { OpenAiTool } from './types'

export type McpConnectionState = 'disconnected' | 'connecting' | 'ready' | 'degraded' | 'closed'

export type McpClientStatus = {
  ready: boolean
  state: McpConnectionState
  generation: number
  failureCount: number
  lastErrorCode?: string
  nextRetryAt?: string
}

export type McpConnectionFactory = () => { client: Client; transport: Transport }

type ActiveConnection = { client: Client; generation: number }

export class PascalMcpClient {
  private active?: ActiveConnection
  private connecting?: Promise<ActiveConnection>
  private state: McpConnectionState = 'disconnected'
  private generation = 0
  private failureCount = 0
  private lastErrorCode?: string
  private nextRetryAtMs = 0
  private closing = false
  private statusListener?: (status: McpClientStatus) => void

  constructor(
    private readonly config: AppConfig,
    private readonly connectionFactory: McpConnectionFactory = () => createConnection(config),
  ) {}

  async connect(): Promise<void> {
    await this.ensureConnection()
  }

  async checkReady(): Promise<boolean> {
    let connection: ActiveConnection
    try {
      connection = await this.ensureConnection()
    } catch {
      return false
    }
    try {
      await connection.client.ping({ timeout: Math.min(this.config.mcpRequestTimeoutMs, 5_000) })
      return this.active === connection && this.state === 'ready'
    } catch (error) {
      this.invalidate(connection, connectionErrorCode(error))
      return false
    }
  }

  status(): McpClientStatus {
    return {
      ready: this.state === 'ready' && this.active !== undefined,
      state: this.state,
      generation: this.generation,
      failureCount: this.failureCount,
      ...(this.lastErrorCode ? { lastErrorCode: this.lastErrorCode } : {}),
      ...(this.nextRetryAtMs > Date.now()
        ? { nextRetryAt: new Date(this.nextRetryAtMs).toISOString() }
        : {}),
    }
  }

  onStatusChange(listener: (status: McpClientStatus) => void): void {
    this.statusListener = listener
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.generation++
    const active = this.active
    this.active = undefined
    this.setState('closed')
    if (active) await closeQuietly(active.client)
    if (this.connecting) await this.connecting.catch(() => undefined)
    this.connecting = undefined
  }

  async listOpenAiTools(): Promise<OpenAiTool[]> {
    const result = await this.withConnection(client =>
      client.listTools(undefined, { timeout: this.config.mcpRequestTimeoutMs }))
    return result.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >,
      },
    }))
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const result = await this.withConnection(
      client => client.callTool({ name, arguments: args }, undefined, {
        timeout: this.config.mcpRequestTimeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      options.signal,
    )
    if (result.isError) {
      throw new Error(`MCP tool ${name} failed: ${mcpErrorMessage(result)}`)
    }
    return result
  }

  async readResourceText(uri: string): Promise<string | undefined> {
    const result = await this.withConnection(client =>
      client.readResource({ uri }, { timeout: this.config.mcpRequestTimeoutMs }))
    const textContent = result.contents.find(
      (content): content is typeof content & { text: string } =>
        'text' in content && typeof content.text === 'string',
    )
    return textContent?.text
  }

  async getPrompt(
    name: string,
    args: Record<string, string>,
  ): Promise<Array<{ role: string; content: unknown }>> {
    const result = await this.withConnection(client =>
      client.getPrompt(
        { name, arguments: args },
        { timeout: this.config.mcpRequestTimeoutMs },
      ))
    return result.messages
  }

  private async withConnection<T>(
    operation: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = await this.ensureConnection()
    try {
      return await operation(connection.client)
    } catch (error) {
      if (!signal?.aborted) this.invalidate(connection, connectionErrorCode(error))
      throw error
    }
  }

  private ensureConnection(): Promise<ActiveConnection> {
    if (this.closing) return Promise.reject(new Error('Pascal MCP client is closed'))
    if (this.active) return Promise.resolve(this.active)
    if (this.connecting) return this.connecting
    if (Date.now() < this.nextRetryAtMs) {
      return Promise.reject(new Error('Pascal MCP reconnect circuit is open'))
    }

    this.setState('connecting')
    const connecting = this.connectWithRetries()
    this.connecting = connecting
    void connecting.finally(() => {
      if (this.connecting === connecting) this.connecting = undefined
    }).catch(() => undefined)
    return connecting
  }

  private async connectWithRetries(): Promise<ActiveConnection> {
    let lastError: unknown = new Error('MCP connection failed')
    for (let attempt = 1; attempt <= this.config.mcpReconnectMaxAttempts; attempt++) {
      if (this.closing) throw new Error('Pascal MCP client is closed')
      const generation = ++this.generation
      const { client, transport } = this.connectionFactory()
      client.onclose = () => this.handleClose(client, generation)
      client.onerror = error => this.handleOutOfBandError(client, generation, error)
      try {
        await client.connect(transport, { timeout: this.config.mcpRequestTimeoutMs })
        if (this.closing || generation !== this.generation) {
          await closeQuietly(client)
          throw new Error('MCP connection generation was superseded')
        }
        const connection = { client, generation }
        this.active = connection
        this.nextRetryAtMs = 0
        this.lastErrorCode = undefined
        this.setState('ready')
        return connection
      } catch (error) {
        lastError = error
        await closeQuietly(client)
        if (this.closing) throw error
        if (attempt < this.config.mcpReconnectMaxAttempts) {
          await Bun.sleep(this.config.mcpReconnectBaseDelayMs * 2 ** (attempt - 1))
        }
      }
    }
    this.recordFailure(connectionErrorCode(lastError))
    throw lastError
  }

  private handleClose(client: Client, generation: number): void {
    const connection = this.active
    if (!connection || connection.client !== client || connection.generation !== generation) return
    this.active = undefined
    if (!this.closing) this.recordFailure('connection_closed')
  }

  private handleOutOfBandError(client: Client, generation: number, error: Error): void {
    const connection = this.active
    if (!connection || connection.client !== client || connection.generation !== generation) return
    this.lastErrorCode = connectionErrorCode(error)
    this.emitStatus()
  }

  private invalidate(connection: ActiveConnection, errorCode: string): void {
    if (this.active !== connection) return
    this.active = undefined
    this.recordFailure(errorCode)
    void closeQuietly(connection.client)
  }

  private recordFailure(errorCode: string): void {
    this.failureCount++
    this.lastErrorCode = errorCode
    this.nextRetryAtMs = Date.now() + this.config.mcpCircuitCooldownMs
    this.setState('degraded')
  }

  private setState(state: McpConnectionState): void {
    this.state = state
    this.emitStatus()
  }

  private emitStatus(): void {
    this.statusListener?.(this.status())
  }
}

function createConnection(config: AppConfig): { client: Client; transport: Transport } {
  const client = new Client({ name: 'pascal-ai-mcp', version: '0.1.0' })
  const transport = config.mcpMode === 'http'
    ? new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
        requestInit: config.mcpToken
          ? {
              headers: {
                Authorization: `Bearer ${config.mcpToken}`,
                'x-pascal-mcp-token': config.mcpToken,
              },
            }
          : undefined,
      })
    : new StdioClientTransport({
        command: config.mcpCommand,
        args: config.mcpArgs,
        cwd: process.cwd(),
        env: config.pascalDataDir
          ? { ...cleanEnv(process.env), PASCAL_DATA_DIR: config.pascalDataDir }
          : cleanEnv(process.env),
        stderr: 'inherit',
      })
  return { client, transport }
}

export function mcpErrorMessage(result: unknown): string {
  if (!result || typeof result !== 'object') return 'unknown error'
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return 'unknown error'
  const messages = content.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const text = (item as { text?: unknown }).text
    return typeof text === 'string' && text.trim() ? [text.trim()] : []
  })
  return messages.length > 0 ? redactSensitiveText(messages.join('; '), 300) : 'unknown error'
}

function connectionErrorCode(error: unknown): string {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/abort/i.test(message)) return 'aborted'
  if (/timed?\s*out|timeout/i.test(message)) return 'timeout'
  if (/ECONNREFUSED|connection refused/i.test(message)) return 'connection_refused'
  if (/EPIPE|broken pipe/i.test(message)) return 'broken_pipe'
  if (/closed|not connected|disconnected/i.test(message)) return 'connection_closed'
  return 'connection_error'
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close()
  } catch {
    // The connection is already unusable; closing is best-effort retirement.
  }
}

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}
