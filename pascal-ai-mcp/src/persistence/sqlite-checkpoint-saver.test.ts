import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { AppDatabase } from './database'
import {
  CheckpointGraphVersionMismatchError,
  SqliteCheckpointSaver,
} from './sqlite-checkpoint-saver'
import { ChatRequestRepository, SqliteSessionPersistence } from './session-repository'
import type { WorkflowSession } from '../types'
import { WORKFLOW_GRAPH_VERSION } from '../workflow-identity'

const ProbeState = Annotation.Root({
  count: Annotation<number>,
})

function compileProbe(saver: SqliteCheckpointSaver) {
  return new StateGraph(ProbeState)
    .addNode('increment', state => ({ count: state.count + 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile({ checkpointer: saver })
}

function sessionFixture(sessionId: string): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId,
    inputType: 'text',
    phase: 'intake',
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

function saver(database: AppDatabase, ttlMs = 60_000, graphVersion = WORKFLOW_GRAPH_VERSION) {
  return new SqliteCheckpointSaver(database, { ttlMs, graphVersion })
}

describe('SqliteCheckpointSaver (T2.6b)', () => {
  test('persists a real StateGraph checkpoint across database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'langgraph-saver-'))
    const file = join(dir, 'ai.db')
    const threadId = crypto.randomUUID()
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        graph_version: WORKFLOW_GRAPH_VERSION,
      },
    }
    try {
      const firstDatabase = new AppDatabase(file)
      const firstSaver = saver(firstDatabase)
      expect(await compileProbe(firstSaver).invoke({ count: 1 }, config)).toEqual({ count: 2 })
      expect((firstDatabase.connection.query(
        'SELECT COUNT(*) AS count FROM langgraph_checkpoints WHERE thread_id = ?',
      ).get(threadId) as { count: number }).count).toBeGreaterThan(0)
      firstSaver.close()
      firstDatabase.close()

      const reopened = new AppDatabase(file)
      const reopenedSaver = saver(reopened)
      const state = await compileProbe(reopenedSaver).getState(config)
      expect(state.values).toEqual({ count: 2 })
      expect(reopenedSaver.isWritable()).toBe(true)
      reopenedSaver.close()
      expect(reopenedSaver.isWritable()).toBe(false)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rejects checkpoints created by a different graph version', async () => {
    const database = new AppDatabase(':memory:')
    const threadId = crypto.randomUUID()
    try {
      const first = saver(database, 60_000, 'pascal-ai:v1')
      await compileProbe(first).invoke({ count: 1 }, {
        configurable: { thread_id: threadId, graph_version: 'pascal-ai:v1' },
      })
      const incompatible = saver(database, 60_000, 'pascal-ai:v2')
      await expect(incompatible.getTuple({ configurable: { thread_id: threadId } }))
        .rejects.toBeInstanceOf(CheckpointGraphVersionMismatchError)
    } finally {
      database.close()
    }
  })

  test('accepts the nested checkpoint namespace format used by LangGraph subgraphs', async () => {
    const database = new AppDatabase(':memory:')
    try {
      expect(await saver(database).getTuple({
        configurable: {
          thread_id: crypto.randomUUID(),
          checkpoint_ns: `parent:${crypto.randomUUID()}|child:${crypto.randomUUID()}`,
          graph_version: WORKFLOW_GRAPH_VERSION,
        },
      })).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('session deletion cascades checkpoints but preserves request audit', async () => {
    const database = new AppDatabase(':memory:')
    try {
      const sessions = new SqliteSessionPersistence(database)
      sessions.save(sessionFixture('s1'), 0)
      const requests = new ChatRequestRepository(database)
      const request = requests.enqueue({
        requestId: 'req-1',
        traceId: 'trace-1',
        sessionId: 's1',
        kind: 'chat',
        startedAt: '2026-07-22T00:00:00.000Z',
      }, { sessionId: 's1', message: 'design' }, 10).request
      expect(request.workflowRunId).toBeDefined()
      await compileProbe(saver(database)).invoke({ count: 1 }, {
        configurable: {
          thread_id: request.workflowRunId!,
          graph_version: WORKFLOW_GRAPH_VERSION,
        },
      })
      expect(sessions.delete('s1')).toBe(true)
      expect((database.connection.query(
        'SELECT COUNT(*) AS count FROM langgraph_checkpoints',
      ).get() as { count: number }).count).toBe(0)
      expect(requests.find('req-1')?.workflowRunId).toBe(request.workflowRunId)
    } finally {
      database.close()
    }
  })

  test('prunes an inactive workflow as one complete thread', async () => {
    const database = new AppDatabase(':memory:')
    try {
      const checkpointSaver = saver(database, 10)
      const threadId = crypto.randomUUID()
      await compileProbe(checkpointSaver).invoke({ count: 1 }, {
        configurable: { thread_id: threadId, graph_version: WORKFLOW_GRAPH_VERSION },
      })
      const before = (database.connection.query(
        'SELECT COUNT(*) AS count FROM langgraph_checkpoints WHERE thread_id = ?',
      ).get(threadId) as { count: number }).count
      expect(before).toBeGreaterThan(1)
      expect(checkpointSaver.pruneExpired(new Date(Date.now() + 1_000).toISOString())).toBe(1)
      expect(await checkpointSaver.getTuple({ configurable: { thread_id: threadId } })).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('reports incompatible graph versions and deletes them only through the explicit path', async () => {
    const database = new AppDatabase(':memory:')
    const threadId = crypto.randomUUID()
    try {
      await compileProbe(saver(database, 60_000, 'pascal-ai:legacy')).invoke({ count: 1 }, {
        configurable: { thread_id: threadId, graph_version: 'pascal-ai:legacy' },
      })
      const current = saver(database)
      expect(current.maintenanceReport().incompatible).toEqual([{
        threadId,
        graphVersions: ['pascal-ai:legacy'],
      }])
      expect(current.deleteIncompatibleThreads()).toBe(1)
      expect(current.maintenanceReport().incompatible).toEqual([])
    } finally {
      database.close()
    }
  })
})
