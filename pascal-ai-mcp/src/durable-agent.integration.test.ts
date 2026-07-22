import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PascalAiAgent } from './agent'
import { loadConfig } from './config'
import { DurableWorkflowRuntime, type DurableWorkflowNodes } from './durable-workflow'
import type { PascalMcpClient } from './mcp'
import { AppDatabase } from './persistence/database'
import { ModelCallRepository } from './persistence/model-call-repository'
import { SceneBuildRepository } from './persistence/scene-build-repository'
import { AiAuditRepository } from './persistence/audit-repository'
import { ChatRequestRepository, SqliteSessionPersistence } from './persistence/session-repository'
import { SqliteCheckpointSaver } from './persistence/sqlite-checkpoint-saver'
import { WorkflowStepRepository } from './persistence/workflow-step-repository'
import { SqliteModelAttemptRecorder } from './telemetry/model-attempt-recorder'
import type { WorkflowSession } from './types'
import { WORKFLOW_GRAPH_VERSION } from './workflow-identity'

test('a clarification interrupt resumes the same compact workflow after process reconstruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-agent-'))
  const databaseFile = join(dir, 'ai.db')
  const originalFetch = globalThis.fetch
  const secretFirst = 'first-private-requirement'
  const secretSecond = 'second-private-requirement'
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: crypto.randomUUID(),
    model: 'test-model',
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify({
          relevant: true,
          existingCondition: [],
          designGoals: [],
          hardConstraints: [],
          assumptions: [],
          uncertainties: [],
          conflicts: [],
          questions: ['How many bedrooms?'],
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch

  const createAgent = (database: AppDatabase, checkpointSaver: SqliteCheckpointSaver) => {
    const config = {
      ...loadConfig(),
      databaseFile,
      aiApiKey: 'test-key',
      aiBaseUrl: 'http://model.invalid/v1',
      aiModel: 'test-model',
      aiFastModel: 'test-model',
    }
    const sessions = new SqliteSessionPersistence(database)
    const requests = new ChatRequestRepository(database)
    const steps = new WorkflowStepRepository(database)
    return {
      agent: new PascalAiAgent(
        config,
        {} as PascalMcpClient,
        new SqliteModelAttemptRecorder(new ModelCallRepository(database)),
        sessions,
        requests,
        steps,
        new SceneBuildRepository(database),
        checkpointSaver,
        new AiAuditRepository(database),
      ),
      requests,
    }
  }

  try {
    const firstDatabase = new AppDatabase(databaseFile)
    const firstSaver = new SqliteCheckpointSaver(firstDatabase, {
      graphVersion: WORKFLOW_GRAPH_VERSION,
      ttlMs: 60_000,
    })
    const first = createAgent(firstDatabase, firstSaver)
    const firstResult = await first.agent.chat({ sessionId: 'session-1', message: secretFirst })
    expect(firstResult.session.phase).toBe('clarifying')
    const firstRequest = first.requests.findBySessionId('session-1')[0]
    expect(firstRequest?.workflowRunId).toBeDefined()
    firstSaver.close()
    firstDatabase.close()

    const reopened = new AppDatabase(databaseFile)
    const reopenedSaver = new SqliteCheckpointSaver(reopened, {
      graphVersion: WORKFLOW_GRAPH_VERSION,
      ttlMs: 60_000,
    })
    const second = createAgent(reopened, reopenedSaver)
    const secondResult = await second.agent.chat({ sessionId: 'session-1', message: secretSecond })
    expect(secondResult.session.phase).toBe('clarifying')
    const requests = second.requests.findBySessionId('session-1')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.workflowRunId).toBe(firstRequest?.workflowRunId)

    const checkpointBytes = (reopened.connection.query(`
      SELECT checkpoint_blob, metadata_blob FROM langgraph_checkpoints
      WHERE thread_id = ?
    `).all(firstRequest!.workflowRunId!) as Array<{
      checkpoint_blob: Uint8Array
      metadata_blob: Uint8Array
    }>).flatMap(row => [row.checkpoint_blob, row.metadata_blob])
    const serialized = checkpointBytes.map(blob => new TextDecoder().decode(blob)).join('\n')
    expect(serialized).not.toContain(secretFirst)
    expect(serialized).not.toContain(secretSecond)
    expect(serialized).not.toContain('messages')
    await reopenedSaver.deleteThread(firstRequest!.workflowRunId!)
    await expect(second.agent.chat({
      sessionId: 'session-1',
      message: 'continue after checkpoint deletion',
    })).rejects.toMatchObject({
      name: 'WorkflowResumeBoundaryError',
      code: 'workflow_checkpoint_unavailable',
    })
    reopenedSaver.close()
    reopened.close()
  } finally {
    globalThis.fetch = originalFetch
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

test('expired recovery directly enforces the safe plan boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-recovery-boundary-'))
  const databaseFile = join(dir, 'ai.db')
  const database = new AppDatabase(databaseFile)
  const checkpointSaver = new SqliteCheckpointSaver(database, {
    graphVersion: WORKFLOW_GRAPH_VERSION,
    ttlMs: 60_000,
  })
  const config = {
    ...loadConfig(),
    databaseFile,
  }
  const sessions = new SqliteSessionPersistence(database)
  const requests = new ChatRequestRepository(database)
  const steps = new WorkflowStepRepository(database)
  const sceneBuilds = new SceneBuildRepository(database)
  const agent = new PascalAiAgent(
    config,
    {} as PascalMcpClient,
    new SqliteModelAttemptRecorder(new ModelCallRepository(database)),
    sessions,
    requests,
    steps,
    sceneBuilds,
    checkpointSaver,
    new AiAuditRepository(database),
  )
  const nodes: DurableWorkflowNodes = {
    route: async () => ({ next: 'plan' }),
    legacy: async () => ({ phase: 'failed', next: 'finish' }),
    plan: async () => ({ phase: 'generating', sessionVersion: 1, next: 'construct' }),
    construct: async () => { throw new Error('stop at durable plan boundary') },
  }
  const seedPendingConstruct = async (requestId: string, sessionId: string) => {
    const request = requests.enqueue({
      requestId,
      traceId: `trace-${requestId}`,
      sessionId,
      kind: 'chat',
      startedAt: '2026-07-22T00:00:00.000Z',
    }, { sessionId, message: 'design' }, 100).request
    const runtime = new DurableWorkflowRuntime(nodes, checkpointSaver)
    await expect(runtime.start({
      sessionId,
      sessionVersion: 0,
      requestId,
      phase: 'awaiting_confirmation',
      next: 'plan',
    }, request.workflowRunId!)).rejects.toThrow('stop at durable plan boundary')
    for (const operationKey of ['route', 'plan'] as const) {
      const step = steps.start({
        requestId,
        sessionId,
        operationKey,
        startedAt: '2026-07-22T00:00:00.000Z',
      })
      steps.finish(step.stepId, 'succeeded', '2026-07-22T00:00:01.000Z')
    }
    return request
  }

  try {
    const safe = await seedPendingConstruct('req-safe', 'session-safe')
    expect(await agent.expiredRequestRecovery(safe)).toBe('resume')

    const withSceneBuild = await seedPendingConstruct('req-scene', 'session-scene')
    sceneBuilds.start({
      buildId: 'build-scene',
      requestId: withSceneBuild.requestId,
      traceId: withSceneBuild.traceId,
      sessionId: withSceneBuild.sessionId,
      startedAt: '2026-07-22T00:00:02.000Z',
    })
    expect(await agent.expiredRequestRecovery(withSceneBuild)).toBe('fail_recoverable')

    const withUnsafeStep = await seedPendingConstruct('req-unsafe', 'session-unsafe')
    const scaffold = steps.start({
      requestId: withUnsafeStep.requestId,
      sessionId: withUnsafeStep.sessionId,
      operationKey: 'scaffold',
      startedAt: '2026-07-22T00:00:02.000Z',
    })
    steps.finish(scaffold.stepId, 'succeeded', '2026-07-22T00:00:03.000Z')
    expect(await agent.expiredRequestRecovery(withUnsafeStep)).toBe('fail_recoverable')

    const completed = await seedPendingConstruct('req-complete', 'session-complete')
    const completedSession = sessionFixture(completed.sessionId, 'generating')
    sessions.save(completedSession, 0)
    completedSession.phase = 'completed'
    completedSession.messages.push({ role: 'assistant', content: 'done' })
    sessions.save(completedSession, 1)
    expect(await agent.expiredRequestRecovery(completed)).toBe('complete')

    const unadvanced = await seedPendingConstruct('req-unadvanced', 'session-unadvanced')
    sessions.save(sessionFixture(unadvanced.sessionId, 'completed'), 0)
    expect(await agent.expiredRequestRecovery(unadvanced)).not.toBe('complete')
  } finally {
    checkpointSaver.close()
    database.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

function sessionFixture(
  sessionId: string,
  phase: WorkflowSession['phase'],
): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId,
    inputType: 'text',
    phase,
    availability: 'partially_usable',
    brief: {
      existingCondition: [],
      designGoals: [],
      hardConstraints: [],
      assumptions: [],
      uncertainties: [],
      conflicts: [],
    },
    questions: [],
    reasons: [],
    summary: '',
    messages: [],
    clarificationRounds: 0,
    createdAt: now,
    updatedAt: now,
  }
}
