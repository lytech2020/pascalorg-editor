import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LangGraphWorkflowRuntime } from './adapters/workflow/langgraph-workflow-runtime'
import type { WorkflowNodes } from './ports/workflow-runtime'
import { AppDatabase } from './persistence/database'
import { SqliteCheckpointSaver } from './persistence/sqlite-checkpoint-saver'
import { WORKFLOW_GRAPH_VERSION } from './workflow-identity'

function saver(database: AppDatabase) {
  return new SqliteCheckpointSaver(database, {
    graphVersion: WORKFLOW_GRAPH_VERSION,
    ttlMs: 60_000,
  })
}

describe('DurableWorkflowRuntime (T2.6c/d)', () => {
  test('parks at an interrupt and resumes the same workflow after database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'durable-workflow-'))
    const file = join(dir, 'ai.db')
    const workflowRunId = crypto.randomUUID()
    const nodes: WorkflowNodes = {
      route: async state => ({ next: 'legacy', phase: state.phase }),
      legacy: async state => state.requestId === 'request-1'
        ? { phase: 'awaiting_confirmation', sessionVersion: 2, next: 'finish' }
        : { phase: 'completed', sessionVersion: 3, next: 'finish' },
      plan: async () => ({ next: 'construct' }),
      construct: async () => ({ phase: 'completed', next: 'finish' }),
    }
    try {
      const firstDatabase = new AppDatabase(file)
      const firstSaver = saver(firstDatabase)
      const firstRuntime = new LangGraphWorkflowRuntime(nodes, firstSaver)
      await firstRuntime.start({
        sessionId: 'session-1',
        sessionVersion: 1,
        requestId: 'request-1',
        phase: 'intake',
        next: 'legacy',
      }, workflowRunId)
      expect(await firstRuntime.snapshot(workflowRunId)).toMatchObject({
        interrupted: true,
        next: ['wait'],
        values: { sessionId: 'session-1', sessionVersion: 2 },
      })
      firstSaver.close()
      firstDatabase.close()

      const reopened = new AppDatabase(file)
      const reopenedSaver = saver(reopened)
      const resumedRuntime = new LangGraphWorkflowRuntime(nodes, reopenedSaver)
      const result = await resumedRuntime.resume(workflowRunId, 'request-2')
      expect(result).toMatchObject({
        sessionId: 'session-1',
        sessionVersion: 3,
        requestId: 'request-2',
        phase: 'completed',
      })
      expect((await resumedRuntime.snapshot(workflowRunId))?.next).toEqual([])
      reopenedSaver.close()
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('retries only the pending construct node after a persisted plan boundary', async () => {
    const database = new AppDatabase(':memory:')
    let constructAttempts = 0
    const nodes: WorkflowNodes = {
      route: async () => ({ next: 'plan' }),
      legacy: async () => ({ phase: 'failed', next: 'finish' }),
      plan: async () => ({ phase: 'generating', sessionVersion: 2, next: 'construct' }),
      construct: async () => {
        constructAttempts++
        if (constructAttempts === 1) throw new Error('simulated process interruption')
        return { phase: 'completed', sessionVersion: 3, next: 'finish' }
      },
    }
    const runtime = new LangGraphWorkflowRuntime(nodes, saver(database))
    const workflowRunId = crypto.randomUUID()
    try {
      await expect(runtime.start({
        sessionId: 'session-1',
        sessionVersion: 1,
        requestId: 'request-1',
        phase: 'awaiting_confirmation',
        next: 'plan',
      }, workflowRunId)).rejects.toThrow('simulated process interruption')
      expect(await runtime.snapshot(workflowRunId)).toMatchObject({
        interrupted: false,
        next: ['construct'],
        values: { sessionVersion: 2, phase: 'generating' },
      })
      expect(await runtime.retryPending(workflowRunId)).toMatchObject({
        sessionVersion: 3,
        phase: 'completed',
      })
      expect(constructAttempts).toBe(2)
    } finally {
      database.close()
    }
  })
})
