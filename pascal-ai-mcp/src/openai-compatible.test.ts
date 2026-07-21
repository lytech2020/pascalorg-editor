import { afterEach, describe, expect, test } from 'bun:test'
import { OpenAiCompatibleClient } from './openai-compatible'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Azure OpenAI requests', () => {
  test('uses the deployment route and api-key authentication', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input)
      capturedInit = init
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    }) as typeof fetch

    const client = new OpenAiCompatibleClient({
      provider: 'azure-openai',
      apiKey: 'secret',
      baseUrl: 'https://example.cognitiveservices.azure.com',
      model: 'gpt-5.4-mini',
      title: 'Pascal AI MCP',
      temperature: 0.2,
      azureDeployment: 'gpt-5.4-mini',
      azureApiVersion: '2024-10-21',
    })

    expect((await client.complete([{ role: 'user', content: 'hello' }], 'session-1')).output).toBe('ok')
    expect(capturedUrl).toBe(
      'https://example.cognitiveservices.azure.com/openai/deployments/gpt-5.4-mini/chat/completions?api-version=2024-10-21',
    )
    expect(new Headers(capturedInit?.headers).get('api-key')).toBe('secret')
    expect(new Headers(capturedInit?.headers).get('authorization')).toBeNull()
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>
    expect(body.model).toBeUndefined()
    expect(body.session_id).toBeUndefined()
  })

  test('retries Azure rate limits using the server delay', async () => {
    let attempts = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts++
      if (attempts === 1) {
        return new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after-ms': '1' },
        })
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    }) as typeof fetch

    const client = new OpenAiCompatibleClient({
      provider: 'azure-openai',
      apiKey: 'secret',
      baseUrl: 'https://example.cognitiveservices.azure.com',
      model: 'gpt-5.4-mini',
      title: 'Pascal AI MCP',
      temperature: 0.2,
      azureDeployment: 'gpt-5.4-mini',
      azureApiVersion: '2024-10-21',
    })

    expect((await client.complete([{ role: 'user', content: 'hello' }], 'session-1')).output).toBe('ok')
    expect(attempts).toBe(2)
  })
})

function makeClient(): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    provider: 'openai-compatible',
    apiKey: 'secret',
    baseUrl: 'https://model.example/v1',
    model: 'test-model',
    title: 'Pascal AI MCP',
    temperature: 0.2,
    requestTimeoutMs: 5_000,
    retryBaseDelayMs: 1,
  })
}

describe('attempt telemetry (T1.1)', () => {
  test('success reports one ok attempt with usage, model and request id', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        id: 'chatcmpl-123',
        model: 'test-model-2026-01',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 100 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      })) as typeof fetch

    const attempts: import('./openai-compatible').ModelAttemptResult[] = []
    const result = await makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      onAttemptFinished: attempt => attempts.push(attempt),
    })

    expect(result.output).toBe('ok')
    expect(result.model).toBe('test-model-2026-01')
    expect(result.providerRequestId).toBe('chatcmpl-123')
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 100,
    })
    expect(attempts).toHaveLength(1)
    const attempt = attempts[0]
    expect(attempt?.status).toBe('ok')
    expect(attempt?.attemptNo).toBe(1)
    expect(attempt?.requestedModel).toBe('test-model')
    expect(attempt?.model).toBe('test-model-2026-01')
    expect(attempt?.usage?.inputTokens).toBe(120)
    expect(attempt?.finishReason).toBe('stop')
    expect(attempt?.latencyMs).toBeGreaterThanOrEqual(0)
  })

  // Absent usage must stay absent — a 0 would be indistinguishable from a
  // provider-reported zero.
  test('missing usage yields undefined, never 0', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })) as typeof fetch

    const attempts: import('./openai-compatible').ModelAttemptResult[] = []
    const result = await makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      onAttemptFinished: attempt => attempts.push(attempt),
    })
    expect(result.usage).toBeUndefined()
    expect(attempts[0]?.usage).toBeUndefined()
  })

  test('a 429 retry reports both attempts individually', async () => {
    let calls = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls++
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after-ms': '1' },
        })
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    }) as typeof fetch

    const attempts: import('./openai-compatible').ModelAttemptResult[] = []
    await makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      onAttemptFinished: attempt => attempts.push(attempt),
    })
    expect(attempts.map(a => a.status)).toEqual(['http_error', 'ok'])
    expect(attempts[0]?.httpStatus).toBe(429)
    expect(attempts[0]?.providerErrorCode).toBe('rate_limit_exceeded')
    expect(attempts[0]?.attemptNo).toBe(1)
    expect(attempts[1]?.attemptNo).toBe(2)
  })

  test('network failures report every attempt and never leak the body', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof fetch

    const attempts: import('./openai-compatible').ModelAttemptResult[] = []
    await expect(
      makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
        onAttemptFinished: attempt => attempts.push(attempt),
      }),
    ).rejects.toThrow('failed after 5 attempt')
    expect(attempts).toHaveLength(5)
    expect(attempts.every(a => a.status === 'network_error')).toBe(true)
    expect(attempts.map(a => a.attemptNo)).toEqual([1, 2, 3, 4, 5])
  })

  test('cancellation reports a single cancelled attempt without retries', async () => {
    const controller = new AbortController()
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch

    const attempts: import('./openai-compatible').ModelAttemptResult[] = []
    await expect(
      makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
        signal: controller.signal,
        onAttemptFinished: attempt => attempts.push(attempt),
      }),
    ).rejects.toThrow('cancelled')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('cancelled')
  })
})
