import { describe, expect, test } from 'bun:test'
import {
  publicErrorEnvelope,
  publicErrorMessage,
  redactSensitiveText,
  SafeServiceError,
  safeErrorLogFields,
} from './error-policy'

describe('public error policy (T1.7)', () => {
  test('builds a stable attributable envelope without exposing internal errors', () => {
    const identity = { requestId: 'req-1', traceId: 'trace-1', clientRequestId: 'ui-1' }
    expect(publicErrorEnvelope(identity, 'queue_full', 'queue', 'Please retry shortly.')).toEqual({
      error: 'queue_full',
      errorCode: 'queue_full',
      stage: 'queue',
      message: 'Please retry shortly.',
      ...identity,
    })
    expect(publicErrorMessage(new Error('private prompt and key'))).not.toContain('private')
  })

  test('preserves only explicitly public service errors', () => {
    const error = new SafeServiceError(
      'model_rate_limited',
      'model',
      'The AI provider is busy. Please retry shortly.',
    )
    expect(publicErrorMessage(error)).toBe('The AI provider is busy. Please retry shortly.')
    expect(safeErrorLogFields(error)).toEqual({
      errorCode: 'model_rate_limited', stage: 'model', errorType: 'SafeServiceError',
    })
  })

  test('redacts credentials, cookies, base64, prompts and replies from defensive logs', () => {
    const secrets = [
      'Bearer sk-private-token',
      'Authorization:Basic-private',
      'Cookie=session-secret',
      'api_key=api-secret',
      'data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==',
      '"prompt":"private prompt"',
      '"reply":"private reply"',
      '"content":"private content"',
    ].join(' ')
    const output = redactSensitiveText(secrets)
    for (const secret of [
      'sk-private-token', 'Basic-private', 'session-secret', 'api-secret',
      'cHJpdmF0ZS1pbWFnZQ==', 'private prompt', 'private reply', 'private content',
    ]) expect(output).not.toContain(secret)
  })
})
