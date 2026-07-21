// Request identity for the AI API (ARCHITECTURE_TASKS.md T1.3).
//
// Ownership rules (task-list global constraint): `requestId` is ALWAYS
// created server-side and is the business key for one /chat call — a
// client-supplied requestId/traceId in the body must never become the key.
// The browser may only send `clientRequestId` (echoed back for UI
// correlation) and a trusted proxy/BFF may supply `x-trace-id`.

export type RequestContext = {
  // Server-authoritative id for this business request.
  requestId: string
  // Cross-service correlation id: taken from the trusted proxy header when
  // well-formed, minted here otherwise.
  traceId: string
  // Browser-side correlation tag; echo-only, never a key.
  clientRequestId?: string
}

const TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

export function createRequestContext(
  headers: Headers,
  body: Record<string, unknown>,
): RequestContext {
  const headerTrace = headers.get('x-trace-id')
  const clientRequestId = body.clientRequestId
  return {
    requestId: crypto.randomUUID(),
    traceId: headerTrace && TRACE_ID_PATTERN.test(headerTrace) ? headerTrace : crypto.randomUUID(),
    ...(typeof clientRequestId === 'string' &&
    clientRequestId.length > 0 &&
    clientRequestId.length <= 64
      ? { clientRequestId }
      : {}),
  }
}
