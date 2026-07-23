import { afterEach, describe, expect, test } from 'bun:test'
import { SafeServiceError } from './error-policy'
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

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
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

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
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

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
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

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    await expect(
      makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
        onAttemptFinished: attempt => attempts.push(attempt),
      }),
    ).rejects.toThrow('temporarily unavailable')
    expect(attempts).toHaveLength(5)
    expect(attempts.every(a => a.status === 'network_error')).toBe(true)
    expect(attempts.map(a => a.attemptNo)).toEqual([1, 2, 3, 4, 5])
  })

  // The mock hangs until the request's OWN signal fires — this fails if the
  // client never wires the caller's signal through to fetch.
  test('cancellation aborts via the wired signal: one cancelled attempt, no retries', async () => {
    const controller = new AbortController()
    let sawSignal = false
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      sawSignal = signal instanceof AbortSignal
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })
    }) as unknown as typeof fetch

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    const pending = makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      signal: controller.signal,
      onAttemptFinished: attempt => attempts.push(attempt),
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toThrow('cancelled')
    expect(sawSignal).toBe(true)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('cancelled')
  })

  // The budget gate must run BEFORE any provider money is spent: a throwing
  // onAttemptStarted aborts the call with zero fetches and zero attempts.
  test('a throwing onAttemptStarted prevents the HTTP request entirely', async () => {
    let fetches = 0
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
      fetches++
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    }) as typeof fetch

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    await expect(
      makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
        onAttemptStarted: () => {
          throw new Error('budget exceeded')
        },
        onAttemptFinished: attempt => attempts.push(attempt),
      }),
    ).rejects.toThrow('budget exceeded')
    expect(fetches).toBe(0)
    expect(attempts).toHaveLength(0)
  })

  // A 2xx with an unparseable body was still served (and billed) by the
  // provider — it must be recorded, not silently lost.
  test('an unparseable 2xx body records an invalid_response attempt', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response('<html>gateway soup</html>', { status: 200 })) as typeof fetch

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    await expect(
      makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
        onAttemptFinished: attempt => attempts.push(attempt),
      }),
    ).rejects.toThrow()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('invalid_response')
    expect(attempts[0]?.httpStatus).toBe(200)
    expect(attempts[0]?.errorSummary).not.toContain('gateway soup')
  })

  test('maps total_tokens and cache_write_tokens', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 6 },
        },
      })) as typeof fetch

    const result = await makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {})
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 4,
      cacheCreationTokens: 6,
    })
  })

  test('attempts separate the stable operation label from the session key', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })) as typeof fetch

    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    const client = makeClient()
    const hooks = {
      operation: 'extract',
      onAttemptFinished: (a: import('./ports/model-client').ModelAttemptResult) => attempts.push(a),
    }
    await client.complete([{ role: 'user', content: 'hi' }], 'sess-1:extract:0', hooks)
    await client.complete([{ role: 'user', content: 'hi' }], 'sess-1:extract:1', hooks)
    expect(attempts).toHaveLength(2)
    // operation is the low-cardinality aggregation axis; the raw round-bearing
    // tag lives in sessionKey.
    expect(attempts.map(a => a.operation)).toEqual(['extract', 'extract'])
    expect(attempts[0]?.sessionKey).toBe('sess-1:extract:0')
    expect(attempts[1]?.sessionKey).toBe('sess-1:extract:1')
    expect(attempts[0]?.callId).toBeTruthy()
    // Two logical calls must not share a callId.
    expect(attempts[0]?.callId).not.toBe(attempts[1]?.callId)
  })

  // A hanging body whose read is aborted: the request DID reach the provider,
  // so exactly one attempt must be recorded — classified by why it aborted.
  function hangingBodyFetch(status: number): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      const stream = new ReadableStream({
        start(controller) {
          signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          )
        },
      })
      return Promise.resolve(new Response(stream, { status, statusText: 'x' }))
    }) as unknown as typeof fetch
  }

  test('cancel during a 2xx body read records one cancelled attempt', async () => {
    const controller = new AbortController()
    globalThis.fetch = hangingBodyFetch(200)
    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    const pending = makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      signal: controller.signal,
      onAttemptFinished: attempt => attempts.push(attempt),
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toThrow('cancelled')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('cancelled')
    expect(attempts[0]?.httpStatus).toBe(200)
  })

  // Regression: cancelling while reading a non-2xx error body used to emit
  // NOTHING for an attempt the provider had already served.
  test('cancel during an error-body read records one cancelled attempt', async () => {
    const controller = new AbortController()
    globalThis.fetch = hangingBodyFetch(500)
    const attempts: import('./ports/model-client').ModelAttemptResult[] = []
    const pending = makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      signal: controller.signal,
      onAttemptFinished: attempt => attempts.push(attempt),
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toThrow('cancelled')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('cancelled')
    expect(attempts[0]?.httpStatus).toBe(500)
  })

  // Telemetry must never change the business outcome of a finished call.
  test('a throwing onAttemptFinished does not break the call', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })) as typeof fetch

    const result = await makeClient().complete([{ role: 'user', content: 'hi' }], 's1', {
      onAttemptFinished: () => {
        throw new Error('sink exploded')
      },
    })
    expect(result.output).toBe('ok')
  })

  test('provider 4xx and 5xx bodies never escape through errors or telemetry', async () => {
    const secret = 'private prompt Authorization=Bearer-secret Cookie=session-secret'
    for (const status of [400, 500]) {
      globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({
          error: { code: status === 400 ? 'invalid_request' : 'upstream_failure', message: secret },
        }), { status, statusText: secret })) as typeof fetch
      const attempts: import('./ports/model-client').ModelAttemptResult[] = []
      let thrown: unknown
      try {
        await makeClient().complete([{ role: 'user', content: secret }], 's1', {
          onAttemptFinished: attempt => attempts.push(attempt),
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(SafeServiceError)
      expect(String(thrown)).not.toContain(secret)
      expect(JSON.stringify(attempts)).not.toContain(secret)
      expect(attempts.every(attempt => attempt.errorSummary?.includes(String(status)))).toBe(true)
    }
  })

  test('invalid structured model output does not leak the returned content', async () => {
    const secret = 'private model reply and api-key-value'
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { role: 'assistant', content: `{${secret}` } }] })) as typeof fetch
    let thrown: unknown
    try {
      await makeClient().json([{ role: 'user', content: 'hi' }], 's1')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SafeServiceError)
    expect(String(thrown)).not.toContain(secret)
  })
})
