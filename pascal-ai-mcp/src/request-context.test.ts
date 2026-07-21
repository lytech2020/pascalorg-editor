import { describe, expect, test } from 'bun:test'
import { createRequestContext } from './request-context'

describe('createRequestContext', () => {
  test('always mints a fresh server-side requestId, ignoring body ids', () => {
    const body = { requestId: 'forged-id', traceId: 'forged-trace' }
    const first = createRequestContext(new Headers(), body)
    const second = createRequestContext(new Headers(), body)
    expect(first.requestId).not.toBe('forged-id')
    expect(first.traceId).not.toBe('forged-trace')
    // Unique per call — a replayed body must not reuse the key.
    expect(first.requestId).not.toBe(second.requestId)
  })

  test('adopts a well-formed x-trace-id from the proxy', () => {
    const context = createRequestContext(
      new Headers({ 'x-trace-id': 'trace-abc-12345678' }),
      {},
    )
    expect(context.traceId).toBe('trace-abc-12345678')
  })

  test('replaces a malformed x-trace-id', () => {
    for (const bad of ['short', 'has spaces here!', 'x'.repeat(65), '<script>alert(1)</script>']) {
      const context = createRequestContext(new Headers({ 'x-trace-id': bad }), {})
      expect(context.traceId).not.toBe(bad)
      expect(context.traceId).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  test('echoes a valid clientRequestId and drops invalid ones', () => {
    expect(createRequestContext(new Headers(), { clientRequestId: 'ui-123' }).clientRequestId).toBe(
      'ui-123',
    )
    expect(createRequestContext(new Headers(), {}).clientRequestId).toBeUndefined()
    expect(
      createRequestContext(new Headers(), { clientRequestId: 'x'.repeat(65) }).clientRequestId,
    ).toBeUndefined()
    expect(createRequestContext(new Headers(), { clientRequestId: 42 }).clientRequestId).toBeUndefined()
  })
})
