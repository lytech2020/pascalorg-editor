import { type NextRequest, NextResponse } from 'next/server'

const AI_AGENT_URL = (process.env.AI_AGENT_URL ?? 'http://127.0.0.1:8788').replace(/\/+$/, '')

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params
  const target = `${AI_AGENT_URL}/${path.map(encodeURIComponent).join('/')}`
  // This proxy faces the browser, so the traceId is ALWAYS minted here — a
  // client-supplied x-trace-id is untrusted and never forwarded (T1.3). A
  // future BFF integration must pass its trace over an authenticated
  // service-to-service boundary, not a same-named header.
  const traceId = crypto.randomUUID()
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
    const requestId = response.headers.get('x-request-id')
    const responseTraceId = response.headers.get('x-trace-id') ?? traceId
    console.log(
      `[ai-proxy] [req ${requestId ?? '-'}] [trace ${responseTraceId}] ${request.method} /${path.join('/')} -> ${response.status}`,
    )
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'x-trace-id': responseTraceId,
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
    })
  } catch (error) {
    console.error(`[ai-proxy] [trace ${traceId}] agent unavailable:`, error)
    return NextResponse.json(
      { error: 'AI agent is unavailable. Start pascal-ai-mcp and try again.', traceId },
      { status: 503, headers: { 'x-trace-id': traceId } },
    )
  }
}

export const GET = proxy
export const POST = proxy
export const DELETE = proxy
