import { afterEach, describe, expect, test } from 'bun:test'
import { AppDatabase } from '../persistence/database'
import {
  ModelCallRepository,
  type ModelCallRecord,
  type ModelCallWriter,
} from '../persistence/model-call-repository'
import { OpenAiCompatibleClient, type ModelAttemptResult } from '../openai-compatible'
import { SqliteModelAttemptRecorder } from './model-attempt-recorder'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function attempt(overrides: Partial<ModelAttemptResult> = {}): ModelAttemptResult {
  return {
    provider: 'openai-compatible',
    operation: 'extract',
    sessionKey: 'session-1:extract:0',
    callId: 'call-1',
    requestedModel: 'requested-model',
    attemptNo: 1,
    status: 'ok',
    promptHash: 'a'.repeat(64),
    requestParams: { temperature: 0.2 },
    startedAt: '2026-07-21T00:00:00.000Z',
    latencyMs: 25,
    ...overrides,
  }
}

const identity = {
  requestId: 'request-1',
  traceId: 'trace-12345678',
  sessionId: 'session-1',
}

describe('SqliteModelAttemptRecorder', () => {
  test('persists one row per real retry with nullable usage and no prompt content', async () => {
    const database = new AppDatabase(':memory:')
    const repository = new ModelCallRepository(database)
    const recorder = new SqliteModelAttemptRecorder(repository)
    let providerCalls = 0
    let budgetCount = 0
    globalThis.fetch = (async () => {
      providerCalls++
      if (providerCalls === 1) {
        return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after-ms': '1' },
        })
      }
      return Response.json({
        id: 'provider-request-1',
        model: 'actual-model',
        choices: [{ message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      })
    }) as unknown as typeof fetch

    const client = new OpenAiCompatibleClient({
      provider: 'openai-compatible',
      apiKey: 'secret',
      baseUrl: 'https://model.example/v1',
      model: 'requested-model',
      title: 'test',
      temperature: 0.2,
      retryBaseDelayMs: 1,
    })
    try {
      await client.complete(
        [
          { role: 'system', content: 'system prompt must not be stored' },
          { role: 'user', content: 'user question must not be stored' },
        ],
        'session-1:extract:0',
        {
          operation: 'extract',
          promptVersion: 'extract-v1',
          onAttemptStarted: () => budgetCount++,
          onAttemptFinished: result => recorder.record(identity, result),
        },
      )

      const rows = repository.findByRequestId(identity.requestId)
      expect(rows).toHaveLength(2)
      expect(rows.map(row => row.status)).toEqual(['http_error', 'ok'])
      expect(rows.map(row => row.attempt_no)).toEqual([1, 2])
      expect(rows).toHaveLength(budgetCount)
      expect(rows[0]?.model).toBeNull()
      expect(rows[0]?.input_tokens).toBeNull()
      expect(rows[1]?.input_tokens).toBe(10)
      expect(rows[1]?.total_tokens).toBe(14)
      expect(rows[1]?.model).toBe('actual-model')
      expect(rows[1]?.provider_request_id).toBe('provider-request-1')
      expect(rows[1]?.prompt_version).toBe('extract-v1')
      expect(rows[1]?.prompt_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.parse(rows[1]?.request_params ?? '{}')).toEqual({ temperature: 0.2 })
      expect(JSON.stringify(rows)).not.toContain('system prompt must not be stored')
      expect(JSON.stringify(rows)).not.toContain('user question must not be stored')
      expect(recorder.status()).toEqual({ ok: true, failureCount: 0 })
    } finally {
      database.close()
    }
  })

  test('marks persistence degraded and never reports a failed write as healthy', () => {
    let shouldFail = true
    const records: ModelCallRecord[] = []
    const writer: ModelCallWriter = {
      insert(record) {
        if (shouldFail) throw new Error('database is read-only')
        records.push(record)
      },
    }
    const recorder = new SqliteModelAttemptRecorder(writer)
    expect(() => recorder.record(identity, attempt())).toThrow('database is read-only')
    expect(recorder.status()).toMatchObject({
      ok: false,
      failureCount: 1,
      lastError: 'database is read-only',
    })

    shouldFail = false
    recorder.record(identity, attempt({ callId: 'call-2' }))
    expect(records).toHaveLength(1)
    expect(recorder.status()).toEqual({ ok: true, failureCount: 1 })
  })

  test('rejects unknown high-cardinality operation labels', () => {
    const writer: ModelCallWriter = { insert() {} }
    const recorder = new SqliteModelAttemptRecorder(writer)
    expect(() => recorder.record(identity, attempt({ operation: 'extract:session-1' })))
      .toThrow('Unknown model operation')
    expect(recorder.status().ok).toBe(false)
  })
})
