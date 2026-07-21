import { describe, expect, test } from 'bun:test'
import { AppDatabase } from './database'
import { ChatRequestRepository } from './session-repository'
import { WorkflowStepRepository } from './workflow-step-repository'

function seedRequest(database: AppDatabase, requestId = 'req-1'): void {
  new ChatRequestRepository(database).enqueue({
    requestId,
    traceId: `trace-${requestId}`,
    sessionId: 'session-1',
    kind: 'chat',
    startedAt: '2026-07-21T00:00:00.000Z',
  }, { sessionId: 'session-1', message: 'test' }, 10)
}

describe('WorkflowStepRepository (T2.2)', () => {
  test('records ordered attempts and terminal outcomes', () => {
    const database = new AppDatabase(':memory:')
    try {
      seedRequest(database)
      const steps = new WorkflowStepRepository(database)
      const first = steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'plan',
        startedAt: '2026-07-21T00:00:01.000Z',
      })
      expect(steps.finish(first.stepId, 'failed', '2026-07-21T00:00:02.000Z', 'step_failed')).toBe(true)
      const retry = steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'plan',
        startedAt: '2026-07-21T00:00:03.000Z',
      })
      expect(steps.finish(retry.stepId, 'succeeded', '2026-07-21T00:00:04.000Z')).toBe(true)
      expect(steps.findByRequestId('req-1')).toMatchObject([
        { operationKey: 'plan', attemptNo: 1, status: 'failed', errorCode: 'step_failed' },
        { operationKey: 'plan', attemptNo: 2, status: 'succeeded' },
      ])
    } finally {
      database.close()
    }
  })

  test('marks only running steps failed-recoverable after an interrupted request', () => {
    const database = new AppDatabase(':memory:')
    try {
      seedRequest(database)
      const steps = new WorkflowStepRepository(database)
      const running = steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'structure-openings',
        startedAt: '2026-07-21T00:00:01.000Z',
      })
      expect(steps.failRunningForRequest(
        'req-1', '2026-07-21T00:00:05.000Z', 'process_interrupted',
      )).toBe(1)
      expect(steps.finish(running.stepId, 'succeeded', '2026-07-21T00:00:06.000Z')).toBe(false)
      expect(steps.findByRequestId('req-1')[0]).toMatchObject({
        status: 'failed_recoverable', errorCode: 'process_interrupted',
      })
    } finally {
      database.close()
    }
  })

  test('rejects high-cardinality operation keys', () => {
    const database = new AppDatabase(':memory:')
    try {
      seedRequest(database)
      const steps = new WorkflowStepRepository(database)
      expect(() => steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'room 3 / user text',
        startedAt: '2026-07-21T00:00:01.000Z',
      })).toThrow('invalid workflow operation key')
      expect(() => steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'plausible-but-unknown',
        startedAt: '2026-07-21T00:00:01.000Z',
      })).toThrow('invalid workflow operation key')
      expect(steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'repair:2',
        startedAt: '2026-07-21T00:00:01.000Z',
      })).toMatchObject({ operationKey: 'repair:2', attemptNo: 1 })
    } finally {
      database.close()
    }
  })

  test('recovers running steps whose parent request is already terminal', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      seedRequest(database)
      requests.claimNext(
        'worker:dead',
        '2026-07-21T00:00:00.000Z',
        '2026-07-21T00:00:01.000Z',
      )
      const steps = new WorkflowStepRepository(database)
      steps.start({
        requestId: 'req-1', sessionId: 'session-1', operationKey: 'structure-openings',
        startedAt: '2026-07-21T00:00:00.000Z',
      })
      requests.failExpiredWorkerRequests('2026-07-21T00:00:02.000Z')

      expect(steps.findByRequestId('req-1')[0]?.status).toBe('running')
      expect(steps.failOrphanedRunningSteps('2026-07-21T00:00:03.000Z')).toBe(1)
      expect(steps.findByRequestId('req-1')[0]).toMatchObject({
        status: 'failed_recoverable', errorCode: 'process_interrupted',
      })
    } finally {
      database.close()
    }
  })

  test('direct request completion atomically reconciles any running step', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      requests.start({
        requestId: 'req-direct',
        traceId: 'trace-direct',
        sessionId: 'session-1',
        kind: 'chat',
        startedAt: '2026-07-21T00:00:00.000Z',
      })
      const steps = new WorkflowStepRepository(database)
      steps.start({
        requestId: 'req-direct', sessionId: 'session-1', operationKey: 'verification',
        startedAt: '2026-07-21T00:00:01.000Z',
      })

      requests.finish('req-direct', 'succeeded', '2026-07-21T00:00:02.000Z')

      expect(requests.find('req-direct')).toMatchObject({ status: 'succeeded' })
      expect(steps.findByRequestId('req-direct')[0]).toMatchObject({
        status: 'failed_recoverable', errorCode: 'step_persistence_incomplete',
        completedAt: '2026-07-21T00:00:02.000Z',
      })
    } finally {
      database.close()
    }
  })
})
