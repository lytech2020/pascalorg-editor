import type { ChatCompletionResponse, ChatMessage, OpenAiTool } from './types'

// Normalized token usage. Absent fields mean the provider did not report the
// number — callers must not read them as 0 (T1.1).
export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
}

// One telemetry record per REAL HTTP attempt — success, HTTP error, network
// failure and cancel all emit, so internal retries and fallback calls are
// individually visible. This is the source of truth for metering
// (ai_model_calls in T1.2); business logs and the session are not.
export type ModelAttemptResult = {
  provider: 'openai-compatible' | 'azure-openai'
  // What we asked for vs. what the provider says actually served the call.
  requestedModel: string
  model?: string
  attemptNo: number
  status: 'ok' | 'http_error' | 'network_error' | 'cancelled'
  httpStatus?: number
  // Short provider error code (e.g. "context_length_exceeded"), never the
  // raw response body.
  providerErrorCode?: string
  errorSummary?: string
  providerRequestId?: string
  finishReason?: string
  usage?: ModelUsage
  startedAt: string
  latencyMs: number
}

// Optional per-call hooks: `signal` lets a caller abort an in-flight request
// (e.g. on user cancel); `onAttemptFinished` fires once per real HTTP
// attempt with the full attempt result (replaces the old count-only
// `onAttempt`); `temperature` overrides the client default for this one call
// (plan-first temperature split, 批次 D).
export type RequestHooks = {
  signal?: AbortSignal
  onAttemptFinished?: (result: ModelAttemptResult) => void
  temperature?: number
}

// Uniform return contract for text/JSON model calls: the parsed output plus
// the response metadata callers need for tracing and cost attribution.
export type ModelCallResult<T> = {
  output: T
  model?: string
  providerRequestId?: string
  usage?: ModelUsage
  finishReason?: string
}

export type ModelClientOptions = {
  provider: 'openai-compatible' | 'azure-openai'
  apiKey: string
  baseUrl: string
  model: string
  referer?: string
  title: string
  temperature: number
  azureDeployment?: string
  azureApiVersion?: string
  requestTimeoutMs?: number
  // Base for the exponential retry backoff (default 2000ms). Tests dial it
  // down so the 5-attempt path completes quickly.
  retryBaseDelayMs?: number
}

export class OpenAiCompatibleClient {
  constructor(private readonly options: ModelClientOptions) {}

  async chat(
    messages: ChatMessage[],
    tools: OpenAiTool[],
    sessionId: string,
    hooks: RequestHooks = {},
  ): Promise<ChatCompletionResponse> {
    return this.request(messages, sessionId, {
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }, hooks)
  }

  async complete(
    messages: ChatMessage[],
    sessionId: string,
    hooks: RequestHooks = {},
  ): Promise<ModelCallResult<string>> {
    const completion = await this.request(messages, sessionId, {}, hooks)
    return callResult(completion, completion.choices[0]?.message.content ?? '')
  }

  async json<T>(
    messages: ChatMessage[],
    sessionId: string,
    hooks: RequestHooks = {},
  ): Promise<ModelCallResult<T>> {
    const completion = await this.request(messages, sessionId, {
      response_format: { type: 'json_object' },
    }, hooks)
    const raw = completion.choices[0]?.message.content ?? ''
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    return callResult(completion, JSON.parse(cleaned) as T)
  }

  private async request(
    messages: ChatMessage[],
    sessionId: string,
    extras: Record<string, unknown> = {},
    hooks: RequestHooks = {},
  ): Promise<ChatCompletionResponse> {
    const body = JSON.stringify({
      ...(this.options.provider === 'azure-openai' ? {} : { model: this.options.model }),
      messages,
      temperature: hooks.temperature ?? this.options.temperature,
      ...(this.options.provider === 'azure-openai' ? {} : { session_id: sessionId }),
      ...extras,
    })
    const timeoutMs = this.options.requestTimeoutMs ?? 60_000
    for (let attempt = 0; attempt < 5; attempt++) {
      // Every real HTTP attempt (including internal retries and, since the
      // fallback model reuses this method, fallback calls) reports one
      // ModelAttemptResult so metering reflects actual API usage rather than
      // logical call count.
      const startedAt = new Date().toISOString()
      const startedMs = performance.now()
      const finished = (
        partial: Omit<ModelAttemptResult, 'provider' | 'requestedModel' | 'attemptNo' | 'startedAt' | 'latencyMs'>,
      ): void => {
        hooks.onAttemptFinished?.({
          provider: this.options.provider,
          requestedModel: this.requestedModel(),
          attemptNo: attempt + 1,
          startedAt,
          latencyMs: Math.round(performance.now() - startedMs),
          ...partial,
        })
      }
      let response: Response
      try {
        response = await fetch(this.requestUrl(), {
          method: 'POST',
          headers: this.headers(),
          body,
          // Combine the per-attempt timeout with the caller's cancel signal
          // (if any) so a user cancel aborts the in-flight request instead of
          // waiting for it (or its retries) to finish.
          signal: anySignal(AbortSignal.timeout(timeoutMs), hooks.signal),
        })
      } catch (error) {
        // A cancel is not a transient failure — do not burn retries on it,
        // surface it immediately so the caller can unwind.
        if (hooks.signal?.aborted) {
          finished({ status: 'cancelled', errorSummary: 'cancelled by caller' })
          throw new Error('Model API request cancelled')
        }
        // Network-level failures (DNS, connection reset, timeout) never hit
        // the response.ok branch below, so without this catch they were not
        // retried at all — only HTTP-level 429/5xx were.
        finished({ status: 'network_error', errorSummary: truncate(errorMessage(error)) })
        if (attempt === 4) {
          throw new Error(
            `Model API request failed after ${attempt + 1} attempt(s): ${errorMessage(error)}`,
          )
        }
        await delay(retryDelayMs(undefined, attempt, this.options.retryBaseDelayMs), hooks.signal)
        continue
      }
      if (response.ok) {
        const payload = (await response.json()) as ChatCompletionResponse
        finished({
          status: 'ok',
          httpStatus: response.status,
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.id ? { providerRequestId: payload.id } : {}),
          ...(payload.choices[0]?.finish_reason
            ? { finishReason: payload.choices[0].finish_reason }
            : {}),
          ...(usageFrom(payload) ? { usage: usageFrom(payload) } : {}),
        })
        return payload
      }

      const responseBody = await response.text()
      finished({
        status: 'http_error',
        httpStatus: response.status,
        errorSummary: truncate(`${response.status} ${response.statusText}`),
        ...(providerErrorCode(responseBody) ? { providerErrorCode: providerErrorCode(responseBody) } : {}),
      })
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === 4) {
        throw new Error(
          `Model API failed after ${attempt + 1} attempt(s): ${response.status} ${response.statusText} ${responseBody}`,
        )
      }
      await delay(retryDelayMs(response.headers, attempt, this.options.retryBaseDelayMs), hooks.signal)
    }
    throw new Error('Model API request exhausted retries')
  }

  // For Azure the deployment name is what we actually request; `model` is
  // only metadata there.
  private requestedModel(): string {
    return this.options.provider === 'azure-openai'
      ? (this.options.azureDeployment ?? this.options.model)
      : this.options.model
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.options.provider === 'azure-openai') {
      headers['api-key'] = this.options.apiKey
    } else {
      headers.Authorization = `Bearer ${this.options.apiKey}`
    }
    if (this.options.referer) headers['HTTP-Referer'] = this.options.referer
    if (this.options.title) headers['X-OpenRouter-Title'] = this.options.title
    return headers
  }

  private requestUrl(): string {
    if (this.options.provider !== 'azure-openai') {
      return `${this.options.baseUrl}/chat/completions`
    }
    if (!this.options.azureDeployment) {
      throw new Error('AZURE_OPENAI_DEPLOYMENT is not configured')
    }
    const version = this.options.azureApiVersion || '2024-10-21'
    return `${this.options.baseUrl}/openai/deployments/${encodeURIComponent(this.options.azureDeployment)}/chat/completions?api-version=${encodeURIComponent(version)}`
  }
}

// Combine a timeout signal with an optional external (cancel) signal into one
// signal that aborts when either does. Implemented manually rather than via
// AbortSignal.any for portability across runtimes/type libs.
function anySignal(primary: AbortSignal, external?: AbortSignal): AbortSignal {
  if (!external) return primary
  if (primary.aborted) return primary
  if (external.aborted) return external
  const controller = new AbortController()
  const abortFrom = (source: AbortSignal) => () => controller.abort(source.reason)
  primary.addEventListener('abort', abortFrom(primary), { once: true })
  external.addEventListener('abort', abortFrom(external), { once: true })
  return controller.signal
}

function retryDelayMs(headers: Headers | undefined, attempt: number, baseMs = 2000): number {
  const retryAfterMs = Number(headers?.get('retry-after-ms'))
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return Math.min(retryAfterMs, 30_000)
  const retryAfterSeconds = Number(headers?.get('retry-after'))
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000)
  }
  return Math.min(baseMs * 2 ** attempt, 30_000)
}

// Abortable sleep: resolves after `milliseconds`, or rejects immediately if
// `signal` is (or becomes) aborted, so a user cancel doesn't have to wait out
// the full retry backoff (up to ~30s) before it takes effect.
function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Model API request cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('Model API request cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// Extracts the short machine-readable error code from an OpenAI-compatible
// error body without ever forwarding the body itself.
function providerErrorCode(responseBody: string): string | undefined {
  try {
    const parsed = JSON.parse(responseBody) as { error?: { code?: unknown; type?: unknown } }
    const code = parsed.error?.code ?? parsed.error?.type
    return typeof code === 'string' && code ? truncate(code, 80) : undefined
  } catch {
    return undefined
  }
}

// Maps the raw usage block to normalized fields; absent numbers stay absent
// (never 0) so downstream metering can tell "reported zero" from "not
// reported".
function usageFrom(payload: ChatCompletionResponse): ModelUsage | undefined {
  const raw = payload.usage
  if (!raw) return undefined
  const usage: ModelUsage = {
    ...(typeof raw.prompt_tokens === 'number' ? { inputTokens: raw.prompt_tokens } : {}),
    ...(typeof raw.completion_tokens === 'number' ? { outputTokens: raw.completion_tokens } : {}),
    ...(typeof raw.completion_tokens_details?.reasoning_tokens === 'number'
      ? { reasoningTokens: raw.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(typeof raw.prompt_tokens_details?.cached_tokens === 'number'
      ? { cacheReadTokens: raw.prompt_tokens_details.cached_tokens }
      : {}),
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function callResult<T>(completion: ChatCompletionResponse, output: T): ModelCallResult<T> {
  return {
    output,
    ...(completion.model ? { model: completion.model } : {}),
    ...(completion.id ? { providerRequestId: completion.id } : {}),
    ...(usageFrom(completion) ? { usage: usageFrom(completion) } : {}),
    ...(completion.choices[0]?.finish_reason
      ? { finishReason: completion.choices[0].finish_reason }
      : {}),
  }
}
