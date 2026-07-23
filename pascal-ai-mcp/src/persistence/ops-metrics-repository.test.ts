import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './database'
import { ChatRequestRepository } from './session-repository'
import { OpsMetricsRepository } from './ops-metrics-repository'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('ops metrics repository', () => {
  test('summarizes queue age, expired leases and recent stable failure codes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ops-metrics-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const base = {
        traceId: 'trace',
        sessionId: 'session',
        kind: 'chat' as const,
        startedAt: '2026-07-23T09:50:00.000Z',
      }
      requests.enqueue(
        { ...base, requestId: 'queued', startedAt: '2026-07-23T09:58:00.000Z' },
        { sessionId: 'session', message: 'queued input' },
        10,
      )
      requests.enqueue(
        { ...base, requestId: 'expired' },
        { sessionId: 'other-session', message: 'running input' },
        10,
      )
      requests.claimNext('worker:test', '2026-07-23T09:59:00.000Z', '2026-07-23T09:59:30.000Z')
      requests.start({
        requestId: 'direct-running',
        traceId: 'direct-trace',
        sessionId: 'direct-session',
        kind: 'chat',
        startedAt: '2026-07-23T09:55:00.000Z',
      })
      requests.finish(
        'direct-running',
        'failed',
        '2026-07-23T09:59:45.000Z',
        'direct_failure',
      )
      database.connection.query(`
        INSERT INTO ai_requests (
          request_id, trace_id, session_id, kind, status, run_attempts,
          queued_at, completed_at, error_code, execution_source
        ) VALUES (?, ?, ?, 'chat', 'failed', 1, ?, ?, ?, 'worker')
      `).run(
        'failed',
        'trace-failed',
        'failed-session',
        '2026-07-23T09:55:00.000Z',
        '2026-07-23T09:59:40.000Z',
        'model_unavailable',
      )
      const snapshot = new OpsMetricsRepository(database.connection).snapshot(
        new Date('2026-07-23T10:00:00.000Z'),
        300_000,
      )
      expect(snapshot).toEqual({
        queuedCount: 1,
        oldestQueuedAt: '2026-07-23T09:58:00.000Z',
        expiredRunningLeases: 1,
        recentTerminalCount: 1,
        recentFailureCount: 1,
        failureCodes: [{ code: 'model_unavailable', count: 1 }],
      })
    } finally {
      database.close()
    }
  })
})
