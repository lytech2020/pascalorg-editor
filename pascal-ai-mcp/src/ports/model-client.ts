import type { ChatCompletionResponse, ChatMessage, OpenAiTool } from '../types'

export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export type ModelRequestParams = {
  temperature: number
  toolCount?: number
  toolChoice?: string
  parallelToolCalls?: boolean
  responseFormat?: string
}

export type ModelAttemptResult = {
  provider: 'openai-compatible' | 'azure-openai'
  operation?: string
  sessionKey: string
  callId: string
  requestedModel: string
  model?: string
  attemptNo: number
  status: 'ok' | 'http_error' | 'network_error' | 'cancelled' | 'invalid_response'
  httpStatus?: number
  providerErrorCode?: string
  errorSummary?: string
  providerRequestId?: string
  finishReason?: string
  usage?: ModelUsage
  promptVersion?: string
  promptHash: string
  requestParams: ModelRequestParams
  startedAt: string
  latencyMs: number
}

export type RequestHooks = {
  signal?: AbortSignal
  onAttemptStarted?: () => void
  onAttemptFinished?: (result: ModelAttemptResult) => void
  temperature?: number
  operation?: string
  promptVersion?: string
  promptHash?: string
}

export type ModelCallResult<T> = {
  output: T
  model?: string
  providerRequestId?: string
  usage?: ModelUsage
  finishReason?: string
}

export interface ModelClient {
  chat(
    messages: ChatMessage[],
    tools: OpenAiTool[],
    sessionId: string,
    hooks?: RequestHooks,
  ): Promise<ChatCompletionResponse>
  complete(
    messages: ChatMessage[],
    sessionId: string,
    hooks?: RequestHooks,
  ): Promise<ModelCallResult<string>>
  json<T>(
    messages: ChatMessage[],
    sessionId: string,
    hooks?: RequestHooks,
  ): Promise<ModelCallResult<T>>
}

export type ModelClients = {
  main?: ModelClient
  fallback?: ModelClient
  fast?: ModelClient
}
