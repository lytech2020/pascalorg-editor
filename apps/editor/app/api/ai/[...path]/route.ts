import { type NextRequest, NextResponse } from 'next/server'

const AI_AGENT_URL = (process.env.AI_AGENT_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '')

// Trace propagation (T1.3): adopt a well-formed upstream x-trace-id (a
// future authenticated BFF) or mint one here; the browser's own headers are
// deliberately NOT forwarded. The AI service mints the authoritative
// requestId — this layer only carries the trace.
function resolveTraceId(request: NextRequest): string {
  const upstream = request.headers.get('x-trace-id')
  return upstream && /^[A-Za-z0-9-]{8,64}$/.test(upstream) ? upstream : crypto.randomUUID()
}

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  const target = `${AI_AGENT_URL}/${path.map(encodeURIComponent).join('/')}`
  const traceId = resolveTraceId(request)
  try {
    const response = await fetch(target, {
      method: request.method,
      headers:
        request.method === 'GET' || request.method === 'DELETE'
          ? { 'x-trace-id': traceId }
          : {
              'Content-Type': request.headers.get('content-type') ?? 'application/json',
              'x-trace-id': traceId,
            },
      body:
        request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text(),
      cache: 'no-store',
    })
    // Buffer the full upstream body before responding. Streaming
    // `response.body` through for a multi-minute /chat generation risked the
    // client receiving a truncated/empty body (then failing `response.json()`
    // with "Unexpected end of JSON input") even though the agent finished and
    // saved the session. Reading it fully here avoids that truncation.
    const bodyText = await response.text()
    console.log(
      `[ai-proxy] [trace ${traceId}] ${request.method} /${path.join('/')} -> ${response.status} (${bodyText.length}B)`,
    )
    return new NextResponse(bodyText, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'x-trace-id': traceId,
      },
    })
  } catch (error) {
    console.error(`[ai-proxy] [trace ${traceId}] agent unavailable:`, error)
    return NextResponse.json(
      { error: 'AI agent is unavailable. Start pascal-ai-mcp and try again.' },
      { status: 503 },
    )
  }
}

export const GET = proxy
export const POST = proxy
export const DELETE = proxy
