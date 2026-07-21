import type { AppDatabase } from './database'

export type ModelCallRecord = {
  id: string
  requestId: string
  traceId: string
  sessionId: string
  sessionKey: string
  callId: string
  operation: string
  provider: string
  requestedModel: string
  model?: string
  attemptNo: number
  status: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  latencyMs: number
  finishReason?: string
  httpStatus?: number
  providerErrorCode?: string
  errorSummary?: string
  providerRequestId?: string
  promptVersion?: string
  promptHash: string
  requestParams: string
  startedAt: string
  completedAt: string
}

export type ModelCallRow = {
  id: string
  request_id: string
  trace_id: string
  session_id: string
  session_key: string
  call_id: string
  operation: string
  provider: string
  requested_model: string
  model: string | null
  attempt_no: number
  status: string
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  reasoning_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  latency_ms: number
  finish_reason: string | null
  http_status: number | null
  provider_error_code: string | null
  error_summary: string | null
  provider_request_id: string | null
  prompt_version: string | null
  prompt_hash: string
  request_params: string
  started_at: string
  completed_at: string
}

export interface ModelCallWriter {
  insert(record: ModelCallRecord): void
}

export class ModelCallRepository implements ModelCallWriter {
  private readonly insertStatement
  private readonly byRequestStatement

  constructor(private readonly database: AppDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO ai_model_calls (
        id, request_id, trace_id, session_id, session_key, call_id,
        operation, provider, requested_model, model, attempt_no, status,
        input_tokens, output_tokens, total_tokens, reasoning_tokens,
        cache_read_tokens, cache_creation_tokens, latency_ms, finish_reason,
        http_status, provider_error_code, error_summary, provider_request_id,
        prompt_version, prompt_hash, request_params, started_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `)
    this.byRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_model_calls
      WHERE request_id = ?
      ORDER BY started_at, call_id, attempt_no
    `)
  }

  insert(record: ModelCallRecord): void {
    this.database.transaction(() => {
      this.insertStatement.run(
        record.id,
        record.requestId,
        record.traceId,
        record.sessionId,
        record.sessionKey,
        record.callId,
        record.operation,
        record.provider,
        record.requestedModel,
        record.model ?? null,
        record.attemptNo,
        record.status,
        record.inputTokens ?? null,
        record.outputTokens ?? null,
        record.totalTokens ?? null,
        record.reasoningTokens ?? null,
        record.cacheReadTokens ?? null,
        record.cacheCreationTokens ?? null,
        record.latencyMs,
        record.finishReason ?? null,
        record.httpStatus ?? null,
        record.providerErrorCode ?? null,
        record.errorSummary ?? null,
        record.providerRequestId ?? null,
        record.promptVersion ?? null,
        record.promptHash,
        record.requestParams,
        record.startedAt,
        record.completedAt,
      )
    })
  }

  findByRequestId(requestId: string): ModelCallRow[] {
    return this.byRequestStatement.all(requestId) as ModelCallRow[]
  }
}
