import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './persistence/database'
import {
  ChatRequestRepository,
  RequestCancellationTargetNotFoundError,
  RequestIdempotencyConflictError,
  RequestQueueFullError,
  SqliteSessionPersistence,
  type ChatRequestStart,
  type QueuedChatInput,
} from './persistence/session-repository'
import { RequestPayloadStore } from './request-payload-store'
import { RequestWorker } from './request-worker'
import { WorkflowStepRepository } from './persistence/workflow-step-repository'
import type { ChatInput, ChatResult, WorkflowSession } from './types'

function start(requestId: string, sessionId: string, kind: 'chat' | 'confirm' | 'cancel' = 'chat', sceneId?: string): ChatRequestStart {
  return {
    requestId,
    traceId: `trace-${requestId}`,
    sessionId,
    kind,
    ...(sceneId ? { sceneId } : {}),
    startedAt: `2026-07-21T00:00:0${requestId.slice(-1)}.000Z`,
  }
}

function input(sessionId: string, action?: 'confirm' | 'cancel'): QueuedChatInput {
  return { sessionId, ...(action ? { action } : { message: `message-${sessionId}` }) }
}

function sessionFixture(sessionId: string): WorkflowSession {
  const now = new Date().toISOString()
  return {
    sessionId,
    inputType: 'text',
    phase: 'cancelled',
    availability: 'partially_usable',
    brief: {
      existingCondition: [], designGoals: [], hardConstraints: [],
      assumptions: [], uncertainties: [], conflicts: [],
    },
    questions: [], reasons: [], summary: '',
    messages: [{ role: 'assistant', content: 'done' }],
    clarificationRounds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

async function waitForTerminal(requests: ChatRequestRepository, requestId: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const status = requests.find(requestId)?.status
    if (status && status !== 'queued' && status !== 'running') return
    await Bun.sleep(10)
  }
  throw new Error(`request ${requestId} did not finish`)
}

describe('durable request queue (T2.1)', () => {
  test('idempotency reuses one scoped request and rejects a changed payload', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      const first = requests.enqueue({
        ...start('req-first', 's1'), idempotencyKey: 'idem-key-0001',
      }, input('s1'), 10)
      const repeated = requests.enqueue({
        ...start('req-repeat', 's1'), idempotencyKey: 'idem-key-0001',
      }, input('s1'), 10)
      expect(first).toMatchObject({ created: true, request: { requestId: 'req-first' } })
      expect(repeated).toMatchObject({ created: false, request: { requestId: 'req-first' } })
      expect(() => requests.enqueue({
        ...start('req-conflict', 's1'), idempotencyKey: 'idem-key-0001',
      }, { sessionId: 's1', message: 'different' }, 10)).toThrow(RequestIdempotencyConflictError)

      const otherScene = requests.enqueue({
        ...start('req-other-scene', 's1', 'chat', 'scene-b'),
        idempotencyKey: 'idem-key-0001',
      }, { ...input('s1'), sceneId: 'scene-b' }, 10)
      expect(otherScene.created).toBe(true)

      const firstSubject = requests.enqueue({
        ...start('req-user-a', 'shared-session'),
        idempotencyKey: 'idem-key-0002',
        idempotencySubject: 'user:a',
      }, input('shared-session'), 10)
      const secondSubject = requests.enqueue({
        ...start('req-user-b', 'shared-session'),
        idempotencyKey: 'idem-key-0002',
        idempotencySubject: 'user:b',
      }, input('shared-session'), 10)
      expect(firstSubject).toMatchObject({ created: true, request: { requestId: 'req-user-a' } })
      expect(secondSubject).toMatchObject({ created: true, request: { requestId: 'req-user-b' } })
    } finally {
      database.close()
    }
  })

  test('two processes submitting the same key concurrently create one request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-idempotency-race-'))
    const file = join(dir, 'ai.db')
    new AppDatabase(file).close()
    const databaseUrl = new URL('./persistence/database.ts', import.meta.url).href
    const repositoryUrl = new URL('./persistence/session-repository.ts', import.meta.url).href
    const script = `
      import { AppDatabase } from ${JSON.stringify(databaseUrl)}
      import { ChatRequestRepository } from ${JSON.stringify(repositoryUrl)}
      while (Date.now() < Number(process.env.TEST_START_AT)) await Bun.sleep(1)
      const database = new AppDatabase(process.env.TEST_DATABASE_FILE)
      try {
        const result = new ChatRequestRepository(database).enqueue({
          requestId: process.env.TEST_REQUEST_ID,
          traceId: 'trace-concurrent',
          sessionId: 'shared-session',
          kind: 'chat',
          idempotencyKey: 'concurrent-key-0001',
          startedAt: '2026-07-21T00:00:00.000Z',
        }, { sessionId: 'shared-session', message: 'same input' }, 10)
        console.log(JSON.stringify({ created: result.created, requestId: result.request.requestId }))
      } finally {
        database.close()
      }
    `
    const startAt = String(Date.now() + 300)
    const children = ['request-a', 'request-b'].map(requestId => Bun.spawn(
      [process.execPath, '-e', script],
      {
        env: {
          ...process.env,
          TEST_DATABASE_FILE: file,
          TEST_REQUEST_ID: requestId,
          TEST_START_AT: startAt,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ))
    try {
      const results = await Promise.all(children.map(async child => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exitCode, stderr).toBe(0)
        return JSON.parse(stdout.trim()) as { created: boolean; requestId: string }
      }))
      expect(results.map(result => result.created).sort()).toEqual([false, true])
      expect(new Set(results.map(result => result.requestId)).size).toBe(1)

      const database = new AppDatabase(file)
      try {
        expect(database.connection.query(`
          SELECT COUNT(*) AS count FROM ai_requests
          WHERE idempotency_key = 'concurrent-key-0001'
        `).get()).toEqual({ count: 1 })
      } finally {
        database.close()
      }
    } finally {
      for (const child of children) child.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('enforces queue depth and never accepts inline image Base64', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      requests.enqueue(start('req-1', 's1'), input('s1'), 1)
      expect(() => requests.enqueue(start('req-2', 's2'), input('s2'), 1)).toThrow(RequestQueueFullError)
      expect(requests.enqueue(
        start('req-cancel', 's1', 'cancel'), input('s1', 'cancel'), 1,
      ).cancelled.map(record => record.requestId)).toEqual(['req-1'])
      expect(requests.hasQueuedCancel()).toBe(true)
      expect(requests.find('req-1')).toMatchObject({
        status: 'cancelled', errorCode: 'cancelled_by_user',
      })
      expect(() => requests.enqueue(
        start('req-no-target', 'missing', 'cancel'), input('missing', 'cancel'), 1,
      )).toThrow(RequestCancellationTargetNotFoundError)
      expect(() => requests.enqueue(start('req-3', 's3'), {
        sessionId: 's3',
        message: 'data:image/png;base64,aGVsbG8=',
      }, 5)).toThrow('inline image data')
    } finally {
      database.close()
    }
  })

  test('claiming prioritizes cancel and serializes matching session or scene', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      requests.enqueue(start('req-1', 's1', 'chat', 'scene-a'), input('s1'), 10)
      requests.enqueue(start('req-2', 's1'), input('s1'), 10)
      requests.enqueue(start('req-3', 's2', 'chat', 'scene-a'), input('s2'), 10)
      requests.enqueue(start('req-4', 's3', 'chat', 'scene-b'), input('s3'), 10)
      new SqliteSessionPersistence(database).save(sessionFixture('s5'), 0)
      requests.enqueue(start('req-5', 's5', 'cancel'), input('s5', 'cancel'), 10)

      const cancel = requests.claimNext('worker:a', '2026-07-21T00:01:00.000Z', '2026-07-21T00:02:00.000Z')
      expect(cancel?.requestId).toBe('req-5')
      requests.complete('req-5', 'worker:a', 'succeeded', '2026-07-21T00:01:01.000Z')

      const first = requests.claimNext('worker:a', '2026-07-21T00:01:02.000Z', '2026-07-21T00:02:02.000Z')
      expect(first?.requestId).toBe('req-1')
      const parallel = requests.claimNext('worker:b', '2026-07-21T00:01:03.000Z', '2026-07-21T00:02:03.000Z')
      expect(parallel?.requestId).toBe('req-4')
    } finally {
      database.close()
    }
  })

  test('expired worker leases become process_interrupted and are never reclaimed', () => {
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      requests.enqueue(start('req-1', 's1'), input('s1'), 10)
      requests.claimNext('worker:dead', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:01.000Z')
      const expired = requests.failExpiredWorkerRequests('2026-07-21T00:00:02.000Z')
      expect(expired.map(record => record.requestId)).toEqual(['req-1'])
      expect(expired[0]?.input?.message).toBe('message-s1')
      expect(requests.find('req-1')).toMatchObject({
        status: 'failed', errorCode: 'process_interrupted',
      })
      expect(requests.find('req-1')?.input).toBeUndefined()
      expect(requests.claimNext('worker:new', '2026-07-21T00:00:03.000Z', '2026-07-21T00:00:04.000Z')).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('expired request recovery marks its running workflow step failed-recoverable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-step-recovery-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const steps = new WorkflowStepRepository(database)
      requests.enqueue(start('req-step', 's1'), input('s1'), 10)
      requests.claimNext('worker:dead', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:01.000Z')
      steps.start({
        requestId: 'req-step', sessionId: 's1', operationKey: 'structure-openings',
        startedAt: '2026-07-21T00:00:00.000Z',
      })
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        { executeQueued: async () => { throw new Error('not called') }, requestCancellation: () => undefined },
        { concurrency: 1, leaseMs: 1_000, pollMs: 10 },
        steps,
      )
      await worker.recoverExpired()
      expect(requests.find('req-step')).toMatchObject({
        status: 'failed', errorCode: 'process_interrupted',
      })
      expect(steps.findByRequestId('req-step')[0]).toMatchObject({
        status: 'failed_recoverable', errorCode: 'process_interrupted',
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an expired request at a verified durable plan boundary is requeued with its input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-durable-resume-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      requests.enqueue(start('req-resume-plan', 's1'), input('s1'), 10)
      requests.claimNext(
        'worker:dead',
        '2026-07-21T00:00:00.000Z',
        '2026-07-21T00:00:01.000Z',
      )
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        {
          executeQueued: async () => { throw new Error('not called') },
          requestCancellation: () => undefined,
          expiredRequestRecovery: async () => 'resume',
        },
        { concurrency: 1, leaseMs: 1_000, pollMs: 10 },
      )
      await worker.recoverExpired()
      expect(requests.find('req-resume-plan')).toMatchObject({
        status: 'queued',
        input: { sessionId: 's1', message: 'message-s1' },
        runAttempts: 1,
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an expired lease after session commit is finalized without replaying execution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-durable-terminal-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const completed = sessionFixture('s1')
      completed.phase = 'completed'
      completed.messages.push({ role: 'assistant', content: 'already finished' })
      sessions.save(completed, 0)
      requests.enqueue(start('req-terminal', 's1'), input('s1'), 10)
      requests.claimNext(
        'worker:dead',
        '2026-07-21T00:00:00.000Z',
        '2026-07-21T00:00:01.000Z',
      )
      let executions = 0
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        {
          executeQueued: async () => {
            executions++
            throw new Error('must not replay')
          },
          requestCancellation: () => undefined,
          expiredRequestRecovery: async () => 'complete',
        },
        { concurrency: 1, leaseMs: 1_000, pollMs: 10 },
      )
      await worker.recoverExpired()
      expect(executions).toBe(0)
      expect(requests.find('req-terminal')).toMatchObject({
        status: 'succeeded',
        result: { reply: 'already finished', sessionVersion: 1 },
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a later startup repairs a step left running after request recovery committed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-step-orphan-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const steps = new WorkflowStepRepository(database)
      requests.enqueue(start('req-orphan', 's1'), input('s1'), 10)
      requests.claimNext('worker:dead', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:01.000Z')
      steps.start({
        requestId: 'req-orphan', sessionId: 's1', operationKey: 'structure-openings',
        startedAt: '2026-07-21T00:00:00.000Z',
      })

      requests.failExpiredWorkerRequests('2026-07-21T00:00:02.000Z')
      expect(steps.findByRequestId('req-orphan')[0]?.status).toBe('running')

      const restartedWorker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        { executeQueued: async () => { throw new Error('not called') }, requestCancellation: () => undefined },
        { concurrency: 1, leaseMs: 1_000, pollMs: 10 },
        steps,
      )
      await restartedWorker.recoverExpired()
      expect(steps.findByRequestId('req-orphan')[0]).toMatchObject({
        status: 'failed_recoverable', errorCode: 'process_interrupted',
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('orphan reconciliation runs at startup but not on every poll tick', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-orphan-throttle-'))
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const steps = new WorkflowStepRepository(database)
      const originalSweep = steps.failOrphanedRunningSteps.bind(steps)
      let sweeps = 0
      steps.failOrphanedRunningSteps = (completedAt: string): number => {
        sweeps++
        return originalSweep(completedAt)
      }
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        { executeQueued: async () => { throw new Error('not called') }, requestCancellation: () => undefined },
        { concurrency: 1, leaseMs: 1_000, pollMs: 5 },
        steps,
      )

      worker.start()
      await Bun.sleep(40)
      worker.stopAccepting()
      await worker.drain()

      expect(sweeps).toBe(1)
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('queued work survives a database reopen and can be claimed only once across connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-queue-reopen-'))
    const file = join(dir, 'ai.db')
    const initial = new AppDatabase(file)
    try {
      new ChatRequestRepository(initial).enqueue(start('req-1', 's1'), input('s1'), 10)
    } finally {
      initial.close()
    }

    const firstDatabase = new AppDatabase(file)
    const secondDatabase = new AppDatabase(file)
    try {
      const first = new ChatRequestRepository(firstDatabase)
      const second = new ChatRequestRepository(secondDatabase)
      expect(first.find('req-1')).toMatchObject({ status: 'queued', runAttempts: 0 })
      expect(first.claimNext(
        'worker:first',
        '2026-07-21T00:01:00.000Z',
        '2026-07-21T00:02:00.000Z',
      )).toMatchObject({ requestId: 'req-1', status: 'running', runAttempts: 1 })
      expect(second.claimNext(
        'worker:second',
        '2026-07-21T00:01:00.000Z',
        '2026-07-21T00:02:00.000Z',
      )).toBeUndefined()
      expect(second.hasActiveRequest('s1')).toBe(true)
    } finally {
      secondDatabase.close()
      firstDatabase.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a restarted worker executes work that was persisted before shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-worker-restart-'))
    const file = join(dir, 'ai.db')
    const beforeRestart = new AppDatabase(file)
    try {
      new ChatRequestRepository(beforeRestart).enqueue(start('req-restart', 's1'), input('s1'), 10)
    } finally {
      beforeRestart.close()
    }

    const afterRestart = new AppDatabase(file)
    try {
      const requests = new ChatRequestRepository(afterRestart)
      const sessions = new SqliteSessionPersistence(afterRestart)
      const payloads = new RequestPayloadStore(join(dir, 'artifacts'))
      const worker = new RequestWorker(requests, sessions, payloads, {
        requestCancellation: () => undefined,
        executeQueued: async (chat: ChatInput): Promise<ChatResult> => {
          const session = sessionFixture(chat.sessionId)
          sessions.save(session, 0)
          return { sessionId: chat.sessionId, reply: 'resumed', session }
        },
      }, { concurrency: 1, leaseMs: 1_000, pollMs: 10 })
      worker.start()
      await waitForTerminal(requests, 'req-restart')
      worker.stopAccepting()
      await worker.drain()
      expect(requests.find('req-restart')).toMatchObject({
        status: 'cancelled',
        result: { reply: 'resumed', sessionVersion: 1 },
      })
    } finally {
      afterRestart.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('pauses ordinary work while its dependency is unavailable but still runs cancel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-worker-ready-'))
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      requests.enqueue(start('req-ready', 's1'), input('s1'), 10)
      let canClaim = false
      let executions = 0
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        {
          requestCancellation: () => undefined,
          executeQueued: async (chat: ChatInput): Promise<ChatResult> => {
            executions++
            const session = sessionFixture(chat.sessionId)
            sessions.save(session, 0)
            return { sessionId: chat.sessionId, reply: 'ready', session }
          },
        },
        {
          concurrency: 1,
          leaseMs: 1_000,
          pollMs: 5,
          canClaim: () => canClaim || requests.hasQueuedCancel(),
        },
      )

      worker.start()
      await Bun.sleep(30)
      expect(requests.find('req-ready')).toMatchObject({ status: 'queued', runAttempts: 0 })
      expect(executions).toBe(0)

      requests.enqueue(start('req-stop', 's1', 'cancel'), input('s1', 'cancel'), 10)
      worker.notify()
      await waitForTerminal(requests, 'req-stop')
      expect(requests.find('req-ready')).toMatchObject({ status: 'cancelled' })
      expect(executions).toBe(1)

      requests.enqueue(start('req-resume', 's2'), input('s2'), 10)
      await Bun.sleep(20)
      expect(requests.find('req-resume')).toMatchObject({ status: 'queued', runAttempts: 0 })
      canClaim = true
      worker.notify()
      await waitForTerminal(requests, 'req-resume')
      worker.stopAccepting()
      await worker.drain()
      expect(executions).toBe(2)
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('stopAccepting drains a claimed request to a persisted terminal state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-worker-drain-'))
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      requests.enqueue(start('req-drain', 's1'), input('s1'), 10)
      let release: (() => void) | undefined
      let started: (() => void) | undefined
      const claimed = new Promise<void>(resolve => { started = resolve })
      const worker = new RequestWorker(
        requests,
        sessions,
        new RequestPayloadStore(join(dir, 'artifacts')),
        {
          requestCancellation: () => undefined,
          executeQueued: async (chat: ChatInput): Promise<ChatResult> => {
            started?.()
            await new Promise<void>(resolve => { release = resolve })
            const session = sessionFixture(chat.sessionId)
            sessions.save(session, 0)
            return { sessionId: chat.sessionId, reply: 'drained', session }
          },
        },
        { concurrency: 1, leaseMs: 1_000, pollMs: 5 },
      )

      worker.start()
      await claimed
      worker.stopAccepting()
      let drained = false
      const draining = worker.drain().then(() => { drained = true })
      await Bun.sleep(20)
      expect(drained).toBe(false)
      expect(requests.find('req-drain')?.status).toBe('running')

      release?.()
      await draining
      expect(requests.find('req-drain')).toMatchObject({
        status: 'cancelled',
        result: { reply: 'drained', sessionVersion: 1 },
      })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('worker reconstructs a private image artifact, persists the result and cleans the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-worker-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const payloads = new RequestPayloadStore(join(dir, 'artifacts'))
      const artifact = payloads.persistImage('data:image/png;base64,iVBORw0KGgo=')
      requests.enqueue(start('req-1', 's1'), { sessionId: 's1', imageArtifact: artifact }, 10)
      const executor = {
        requestCancellation: () => undefined,
        executeQueued: async (chat: ChatInput): Promise<ChatResult> => {
          expect(chat.imageDataUrl).toBe('data:image/png;base64,iVBORw0KGgo=')
          const session = sessionFixture(chat.sessionId)
          sessions.save(session, 0)
          return { sessionId: chat.sessionId, reply: 'done', session }
        },
      }
      const worker = new RequestWorker(requests, sessions, payloads, executor, {
        concurrency: 1, leaseMs: 1_000, pollMs: 10,
      })
      worker.start()
      await waitForTerminal(requests, 'req-1')
      worker.stopAccepting()
      await worker.drain()
      expect(requests.find('req-1')).toMatchObject({
        status: 'cancelled',
        result: { reply: 'done', sessionVersion: 1 },
      })
      expect(requests.find('req-1')?.input).toBeUndefined()
      expect(readdirSync(join(dir, 'artifacts'))).toEqual([])
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('losing a heartbeat asks the executor to stop local work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'request-heartbeat-'))
    const database = new AppDatabase(':memory:')
    try {
      const requests = new ChatRequestRepository(database)
      const sessions = new SqliteSessionPersistence(database)
      const payloads = new RequestPayloadStore(dir)
      requests.enqueue(start('req-heartbeat', 's1'), input('s1'), 10)
      requests.heartbeat = () => false
      let resolveExecution: (() => void) | undefined
      let cancellations = 0
      const worker = new RequestWorker(requests, sessions, payloads, {
        executeQueued: (chat: ChatInput) => new Promise<ChatResult>((resolve) => {
          resolveExecution = () => {
            const session = sessionFixture(chat.sessionId)
            sessions.save(session, 0)
            resolve({ sessionId: chat.sessionId, reply: 'stopped', session })
          }
        }),
        requestCancellation: () => {
          cancellations++
          resolveExecution?.()
        },
      }, { concurrency: 1, leaseMs: 300, pollMs: 10 })
      worker.start()
      await waitForTerminal(requests, 'req-heartbeat')
      worker.stopAccepting()
      await worker.drain()
      expect(cancellations).toBe(1)
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
