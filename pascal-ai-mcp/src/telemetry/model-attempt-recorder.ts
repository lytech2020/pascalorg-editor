import type { ModelAttemptResult } from '../openai-compatible'
import type { ModelCallRecord, ModelCallWriter } from '../persistence/model-call-repository'
import type { RequestContext } from '../request-context'

export const MODEL_OPERATIONS = [
  'extract',
  'modify-ops',
  'inspect',
  'scene-agent',
  'scene-intent',
  'plan:intent',
  'plan:geometry',
] as const

export type ModelOperation = typeof MODEL_OPERATIONS[number]

export type ModelAttemptIdentity = RequestContext & {
  sessionId: string
}

export type TelemetryStatus = {
  ok: boolean
  failureCount: number
  lastError?: string
  lastErrorAt?: string
}

export interface ModelAttemptSink {
  record(identity: ModelAttemptIdentity, attempt: ModelAttemptResult): void
  status(): TelemetryStatus
}

export class SqliteModelAttemptRecorder implements ModelAttemptSink {
  private failureCount = 0
  private lastError?: string
  private lastErrorAt?: string

  constructor(private readonly writer: ModelCallWriter) {}

  record(identity: ModelAttemptIdentity, attempt: ModelAttemptResult): void {
    try {
      this.writer.insert(toRecord(identity, attempt))
      this.lastError = undefined
      this.lastErrorAt = undefined
    } catch (error) {
      this.failureCount++
      this.lastError = errorMessage(error)
      this.lastErrorAt = new Date().toISOString()
      throw error
    }
  }

  status(): TelemetryStatus {
    return {
      ok: this.lastError === undefined,
      failureCount: this.failureCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastErrorAt ? { lastErrorAt: this.lastErrorAt } : {}),
    }
  }
}

function toRecord(
  identity: ModelAttemptIdentity,
  attempt: ModelAttemptResult,
): ModelCallRecord {
  if (!isModelOperation(attempt.operation)) {
    throw new Error(`Unknown model operation: ${attempt.operation ?? '<missing>'}`)
  }
  const completedAt = new Date(
    Date.parse(attempt.startedAt) + Math.max(0, attempt.latencyMs),
  ).toISOString()
  return {
    id: `${attempt.callId}:${attempt.attemptNo}`,
    requestId: identity.requestId,
    traceId: identity.traceId,
    sessionId: identity.sessionId,
    sessionKey: attempt.sessionKey,
    callId: attempt.callId,
    operation: attempt.operation,
    provider: attempt.provider,
    requestedModel: attempt.requestedModel,
    ...(attempt.model ? { model: attempt.model } : {}),
    attemptNo: attempt.attemptNo,
    status: attempt.status,
    ...(attempt.usage?.inputTokens !== undefined
      ? { inputTokens: attempt.usage.inputTokens }
      : {}),
    ...(attempt.usage?.outputTokens !== undefined
      ? { outputTokens: attempt.usage.outputTokens }
      : {}),
    ...(attempt.usage?.totalTokens !== undefined
      ? { totalTokens: attempt.usage.totalTokens }
      : {}),
    ...(attempt.usage?.reasoningTokens !== undefined
      ? { reasoningTokens: attempt.usage.reasoningTokens }
      : {}),
    ...(attempt.usage?.cacheReadTokens !== undefined
      ? { cacheReadTokens: attempt.usage.cacheReadTokens }
      : {}),
    ...(attempt.usage?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: attempt.usage.cacheCreationTokens }
      : {}),
    latencyMs: attempt.latencyMs,
    ...(attempt.finishReason ? { finishReason: attempt.finishReason } : {}),
    ...(attempt.httpStatus !== undefined ? { httpStatus: attempt.httpStatus } : {}),
    ...(attempt.providerErrorCode
      ? { providerErrorCode: attempt.providerErrorCode }
      : {}),
    ...(attempt.errorSummary ? { errorSummary: attempt.errorSummary } : {}),
    ...(attempt.providerRequestId
      ? { providerRequestId: attempt.providerRequestId }
      : {}),
    ...(attempt.promptVersion ? { promptVersion: attempt.promptVersion } : {}),
    promptHash: attempt.promptHash,
    requestParams: JSON.stringify(attempt.requestParams),
    startedAt: attempt.startedAt,
    completedAt,
  }
}

function isModelOperation(value: string | undefined): value is ModelOperation {
  return MODEL_OPERATIONS.some(operation => operation === value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
