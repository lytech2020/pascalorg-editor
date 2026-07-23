import { createHash } from 'node:crypto'
import { SafeServiceError, safeErrorLogFields } from './error-policy'
import type { ChatCompletionResponse, ChatMessage, OpenAiTool } from './types'
import type {
  ModelAttemptResult,
  ModelCallResult,
  ModelRequestParams,
  ModelUsage,
  RequestHooks,
} from './ports/model-client'

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
    try {
      return callResult(completion, JSON.parse(cleaned) as T)
    } catch {
      throw new SafeServiceError(
        'model_invalid_response',
        'model',
        'The AI provider returned an invalid response. Please retry.',
      )
    }
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
    const promptHash = systemPromptHash(messages)
    const requestParams = requestParamsFrom(
      extras,
      hooks.temperature ?? this.options.temperature,
    )
    const timeoutMs = this.options.requestTimeoutMs ?? 60_000
    const callId = crypto.randomUUID()
    for (let attempt = 0; attempt < 5; attempt++) {
      // Budget gate BEFORE any money is spent: a throw here must abort the
      // call without an HTTP request (the pre-T1.1 `onAttempt` semantics).
      hooks.onAttemptStarted?.()
      // Every real HTTP attempt (including internal retries and, since the
      // fallback model reuses this method, fallback calls) reports one
      // ModelAttemptResult so metering reflects actual API usage rather than
      // logical call count.
      const startedAt = new Date().toISOString()
      const startedMs = performance.now()
      const finished = (
        partial: Omit<
          ModelAttemptResult,
          'provider' | 'operation' | 'sessionKey' | 'callId' | 'requestedModel' | 'attemptNo' | 'promptVersion' | 'promptHash' | 'requestParams' | 'startedAt' | 'latencyMs'
        >,
      ): void => {
        try {
          hooks.onAttemptFinished?.({
            provider: this.options.provider,
            ...(hooks.operation ? { operation: hooks.operation } : {}),
            sessionKey: sessionId,
            callId,
            requestedModel: this.requestedModel(),
            attemptNo: attempt + 1,
            ...(hooks.promptVersion ? { promptVersion: hooks.promptVersion } : {}),
            promptHash,
            requestParams,
            startedAt,
            latencyMs: Math.round(performance.now() - startedMs),
            ...partial,
          })
        } catch (error) {
          // Telemetry must never change the business outcome of a call that
          // already happened — the budget gate lives in onAttemptStarted.
          console.error('onAttemptFinished hook failed:', safeErrorLogFields(error, 'telemetry_sink_failed'))
        }
      }
      // Combine the per-attempt timeout with the caller's cancel signal (if
      // any) so a user cancel aborts the in-flight request instead of
      // waiting for it (or its retries) to finish. Saved so the body-read
      // phase below can classify its own abort correctly.
      const attemptSignal = anySignal(AbortSignal.timeout(timeoutMs), hooks.signal)
      // Body reads (json()/text()) can fail after the provider already
      // served — and billed — the request, so every outcome must still emit
      // exactly one attempt record: caller cancel → cancelled, timeout →
      // network_error, anything else → invalid_response.
      const readBody = async <T>(read: () => Promise<T>, httpStatus: number): Promise<T> => {
        try {
          return await read()
        } catch (error) {
          if (hooks.signal?.aborted) {
            finished({ status: 'cancelled', httpStatus, errorSummary: 'cancelled during body read' })
            throw modelCancelledError()
          }
          if (attemptSignal.aborted) {
            finished({
              status: 'network_error',
              httpStatus,
              errorSummary: 'request_timeout',
            })
            throw modelUnavailableError()
          }
          finished({
            status: 'invalid_response',
            httpStatus,
            errorSummary: `unreadable response body (${errorKind(error)})`,
          })
          throw new SafeServiceError(
            'model_invalid_response',
            'model',
            'The AI provider returned an invalid response. Please retry.',
          )
        }
      }
      let response: Response
      try {
        response = await fetch(this.requestUrl(), {
          method: 'POST',
          headers: this.headers(),
          body,
          signal: attemptSignal,
        })
      } catch (error) {
        // A cancel is not a transient failure — do not burn retries on it,
        // surface it immediately so the caller can unwind.
        if (hooks.signal?.aborted) {
          finished({ status: 'cancelled', errorSummary: 'cancelled by caller' })
          throw modelCancelledError()
        }
        // Network-level failures (DNS, connection reset, timeout) never hit
        // the response.ok branch below, so without this catch they were not
        // retried at all — only HTTP-level 429/5xx were.
        finished({ status: 'network_error', errorSummary: networkErrorCode(error) })
        if (attempt === 4) {
          throw modelUnavailableError()
        }
        await delay(retryDelayMs(undefined, attempt, this.options.retryBaseDelayMs), hooks.signal)
        continue
      }
      if (response.ok) {
        const payload = await readBody(
          () => response.json() as Promise<ChatCompletionResponse>,
          response.status,
        )
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

      const responseBody = await readBody(() => response.text(), response.status)
      const errorCode = providerErrorCode(responseBody)
      finished({
        status: 'http_error',
        httpStatus: response.status,
        errorSummary: `${response.status} ${httpErrorCategory(response.status)}`,
        ...(errorCode ? { providerErrorCode: errorCode } : {}),
      })
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === 4) {
        throw modelHttpError(response.status)
      }
      await delay(retryDelayMs(response.headers, attempt, this.options.retryBaseDelayMs), hooks.signal)
    }
    throw modelUnavailableError()
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
      reject(modelCancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    function onAbort() {
      clearTimeout(timer)
      reject(modelCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function errorKind(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError'
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function systemPromptHash(messages: ChatMessage[]): string {
  const systemMessages = messages
    .filter(message => message.role === 'system')
    .map(message => message.content ?? null)
  return createHash('sha256').update(JSON.stringify(systemMessages)).digest('hex')
}

function requestParamsFrom(
  extras: Record<string, unknown>,
  temperature: number,
): ModelRequestParams {
  const responseFormat = extras.response_format
  const toolChoice = extras.tool_choice
  return {
    temperature,
    ...(Array.isArray(extras.tools) ? { toolCount: extras.tools.length } : {}),
    ...(typeof toolChoice === 'string' ? { toolChoice } : {}),
    ...(typeof extras.parallel_tool_calls === 'boolean'
      ? { parallelToolCalls: extras.parallel_tool_calls }
      : {}),
    ...(responseFormat !== null && typeof responseFormat === 'object'
      && typeof (responseFormat as { type?: unknown }).type === 'string'
      ? { responseFormat: (responseFormat as { type: string }).type }
      : {}),
  }
}

// Extracts the short machine-readable error code from an OpenAI-compatible
// error body without ever forwarding the body itself.
function providerErrorCode(responseBody: string): string | undefined {
  try {
    const parsed = JSON.parse(responseBody) as { error?: { code?: unknown; type?: unknown } }
    const code = parsed.error?.code ?? parsed.error?.type
    return typeof code === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function modelCancelledError(): SafeServiceError {
  return new SafeServiceError('model_cancelled', 'model', 'The AI model request was cancelled.')
}

function modelUnavailableError(): SafeServiceError {
  return new SafeServiceError(
    'model_unavailable',
    'model',
    'The AI provider is temporarily unavailable. Please retry.',
  )
}

function modelHttpError(status: number): SafeServiceError {
  if (status === 429) {
    return new SafeServiceError(
      'model_rate_limited',
      'model',
      'The AI provider is busy. Please retry shortly.',
    )
  }
  if (status === 401 || status === 403) {
    return new SafeServiceError(
      'model_authentication_failed',
      'model',
      'The AI provider is not configured correctly. Contact support with the request ID.',
    )
  }
  if (status >= 500) return modelUnavailableError()
  return new SafeServiceError(
    'model_request_rejected',
    'model',
    'The AI provider rejected the request. Review the input or contact support with the request ID.',
  )
}

function httpErrorCategory(status: number): string {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'authentication_failed'
  if (status >= 500) return 'provider_unavailable'
  return 'request_rejected'
}

function networkErrorCode(error: unknown): string {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/abort/i.test(text)) return 'aborted'
  if (/timed?\s*out|timeout/i.test(text)) return 'request_timeout'
  if (/ECONNREFUSED|connection refused/i.test(text)) return 'connection_refused'
  if (/EPIPE|broken pipe/i.test(text)) return 'broken_pipe'
  return 'network_error'
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
    ...(typeof raw.total_tokens === 'number' ? { totalTokens: raw.total_tokens } : {}),
    ...(typeof raw.completion_tokens_details?.reasoning_tokens === 'number'
      ? { reasoningTokens: raw.completion_tokens_details.reasoning_tokens }
      : {}),
    ...(typeof raw.prompt_tokens_details?.cached_tokens === 'number'
      ? { cacheReadTokens: raw.prompt_tokens_details.cached_tokens }
      : {}),
    ...(typeof raw.prompt_tokens_details?.cache_write_tokens === 'number'
      ? { cacheCreationTokens: raw.prompt_tokens_details.cache_write_tokens }
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
