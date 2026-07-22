export type ErrorStage =
  | 'transport'
  | 'validation'
  | 'readiness'
  | 'queue'
  | 'model'
  | 'workflow'
  | 'persistence'
  | 'internal'

export type ErrorIdentity = {
  requestId: string
  traceId: string
  clientRequestId?: string
}

export type PublicErrorEnvelope = ErrorIdentity & {
  // `error` remains for the existing editor client; errorCode is the
  // authoritative stable field for new consumers.
  error: string
  errorCode: string
  stage: ErrorStage
  message: string
  [key: string]: unknown
}

export class SafeServiceError extends Error {
  constructor(
    readonly errorCode: string,
    readonly stage: ErrorStage,
    readonly publicMessage: string,
  ) {
    super(publicMessage)
    this.name = 'SafeServiceError'
  }
}

export function publicErrorEnvelope(
  identity: ErrorIdentity,
  errorCode: string,
  stage: ErrorStage,
  message: string,
  extra: Record<string, unknown> = {},
): PublicErrorEnvelope {
  return { error: errorCode, errorCode, stage, message, ...identity, ...extra }
}

export function publicErrorMessage(error: unknown): string {
  return error instanceof SafeServiceError
    ? error.publicMessage
    : 'The request could not be completed. Please retry or contact support with the request ID.'
}

export function stableErrorCode(error: unknown, fallback = 'internal_error'): string {
  return error instanceof SafeServiceError ? error.errorCode : fallback
}

export function stableErrorStage(error: unknown, fallback: ErrorStage = 'internal'): ErrorStage {
  return error instanceof SafeServiceError ? error.stage : fallback
}

// This is defense in depth for text that reaches ordinary logs. Callers
// should still log stable codes instead of arbitrary upstream payloads.
export function redactSensitiveText(value: unknown, maxLength = 500): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  const redacted = raw
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=_-]+/gi, '[REDACTED_BASE64]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|cookie|set-cookie|api[-_]?key)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(["'](?:prompt|reply|content|message)["']\s*:\s*)["'][\s\S]*?["']/gi, '$1"[REDACTED]"')
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted
}

export function safeErrorLogFields(
  error: unknown,
  fallbackCode = 'internal_error',
): { errorCode: string; stage: ErrorStage; errorType: string } {
  return {
    errorCode: stableErrorCode(error, fallbackCode),
    stage: stableErrorStage(error),
    errorType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
      ? error.name
      : 'UnknownError',
  }
}
