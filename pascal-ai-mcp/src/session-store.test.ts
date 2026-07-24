import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './persistence/database'
import {
  ChatRequestRepository,
  SessionVersionConflictError,
  SqliteSessionPersistence,
  WorkflowRunResolutionError,
} from './persistence/session-repository'
import type { ChatMessage, WorkflowSession } from './types'

function sessionFixture(sessionId: string, messages: ChatMessage[] = []): WorkflowSession {
  const now = '2026-07-21T00:00:00.000Z'
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
    messages,
    clarificationRounds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

describe('SQLite session persistence (T1.5)', () => {
  test('restores sessions after reopen while keeping messages out of state_json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-sqlite-'))
    const filePath = join(dir, 'ai.db')
    try {
      const database = new AppDatabase(filePath)
      const persistence = new SqliteSessionPersistence(database)
      const session = sessionFixture('s1', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ])
      expect(persistence.save(session, 0)).toBe(1)
      const state = database.connection.query(
        'SELECT state_json FROM ai_sessions WHERE session_id = ?',
      ).get('s1') as { state_json: string }
      expect(state.state_json).not.toContain('messages')
      expect((database.connection.query('SELECT COUNT(*) AS count FROM ai_messages').get() as { count: number }).count).toBe(2)
      database.close()

      const reopened = new AppDatabase(filePath)
      const restored = new SqliteSessionPersistence(reopened).load('s1')
      expect(restored?.version).toBe(1)
      expect(restored?.session).toEqual(session)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('compare-and-swap rejects a stale writer and preserves the winner', () => {
    const database = new AppDatabase(':memory:')
    try {
      const first = new SqliteSessionPersistence(database)
      const second = new SqliteSessionPersistence(database)
      first.save(sessionFixture('s1'), 0)
      const firstRead = first.load('s1')!
      const staleRead = second.load('s1')!
      firstRead.session.summary = 'winner'
      expect(first.save(firstRead.session, firstRead.version)).toBe(2)
      staleRead.session.summary = 'stale'
      expect(() => second.save(staleRead.session, staleRead.version)).toThrow(SessionVersionConflictError)
      expect(first.load('s1')?.session.summary).toBe('winner')
    } finally {
      database.close()
    }
  })

  test('persists the canonical pending modification plan across a process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-pending-modify-'))
    const filePath = join(dir, 'ai.db')
    try {
      const database = new AppDatabase(filePath)
      const session = sessionFixture('pending-1')
      session.phase = 'awaiting_modification_confirmation'
      session.pendingModification = '把主卧扩大到16平方米'
      session.pendingModificationMode = 'plan_rebuild'
      session.pendingModificationReasonCode = 'resize_room'
      session.pendingModificationPlanHash = 'canonical-hash'
      session.pendingModifyPlan = {
        ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 16 }],
        preservation: {
          mode: 'allow_rebuild',
          allowedRoomRefs: ['主卧'],
          preserveFootprint: false,
        },
      }
      new SqliteSessionPersistence(database).save(session, 0)
      database.close()

      const reopened = new AppDatabase(filePath)
      expect(new SqliteSessionPersistence(reopened).load('pending-1')?.session)
        .toMatchObject({
          pendingModificationPlanHash: 'canonical-hash',
          pendingModifyPlan: session.pendingModifyPlan,
        })
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('legacy sessions.json imports once, never overwrites SQLite, and remains unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-legacy-'))
    const legacyPath = join(dir, 'sessions.json')
    const legacyText = `${JSON.stringify({
      sessions: {
        s1: { ...sessionFixture('s1'), summary: 'legacy-loses' },
        s2: { ...sessionFixture('s2'), summary: 'legacy-imported' },
      },
    }, null, 2)}\n`
    writeFileSync(legacyPath, legacyText)
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const persistence = new SqliteSessionPersistence(database)
      persistence.save({ ...sessionFixture('s1'), summary: 'database-wins' }, 0)
      expect(persistence.importLegacyFile(legacyPath)).toEqual({
        status: 'imported', imported: 1, skipped: 1,
      })
      expect(persistence.importLegacyFile(legacyPath)).toEqual({
        status: 'already_imported', imported: 0, skipped: 0,
      })
      expect(persistence.load('s1')?.session.summary).toBe('database-wins')
      expect(persistence.load('s2')?.session.summary).toBe('legacy-imported')
      expect(readFileSync(legacyPath, 'utf8')).toBe(legacyText)
      const imports = database.connection.query('SELECT COUNT(*) AS count FROM legacy_session_imports').get() as { count: number }
      expect(imports.count).toBe(1)
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('legacy import skips a session with unsafe messages without losing valid siblings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-legacy-invalid-'))
    const legacyPath = join(dir, 'sessions.json')
    writeFileSync(legacyPath, JSON.stringify({
      sessions: {
        valid: sessionFixture('valid', [{ role: 'user', content: 'safe' }]),
        unsafe: sessionFixture('unsafe', [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
        }]),
      },
    }))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const persistence = new SqliteSessionPersistence(database)
      expect(persistence.importLegacyFile(legacyPath)).toEqual({
        status: 'imported', imported: 1, skipped: 1,
      })
      expect(persistence.load('valid')?.session.messages).toEqual([{ role: 'user', content: 'safe' }])
      expect(persistence.load('unsafe')).toBeUndefined()
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('messages cascade on session delete while request audit remains separate', () => {
    const database = new AppDatabase(':memory:')
    try {
      const sessions = new SqliteSessionPersistence(database)
      sessions.save(sessionFixture('s1', [{ role: 'user', content: 'private question' }]), 0)
      const requests = new ChatRequestRepository(database)
      requests.start({
        requestId: 'req-1',
        traceId: 'trace-1',
        clientRequestId: 'client-1',
        sessionId: 's1',
        kind: 'chat',
        startedAt: '2026-07-21T00:00:00.000Z',
      })
      requests.finish('req-1', 'succeeded', '2026-07-21T00:00:01.000Z')
      expect(sessions.delete('s1')).toBe(true)
      expect((database.connection.query('SELECT COUNT(*) AS count FROM ai_messages').get() as { count: number }).count).toBe(0)
      const request = database.connection.query('SELECT * FROM ai_requests WHERE request_id = ?').get('req-1') as {
        status: string
        kind: string
      }
      expect(request.status).toBe('succeeded')
      expect(request.kind).toBe('chat')
    } finally {
      database.close()
    }
  })

  test('inline image Base64 is rejected atomically', () => {
    const database = new AppDatabase(':memory:')
    try {
      const persistence = new SqliteSessionPersistence(database)
      const session = sessionFixture('s1', [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }],
      }])
      expect(() => persistence.save(session, 0)).toThrow('inline image data')
      expect(persistence.load('s1')).toBeUndefined()
    } finally {
      database.close()
    }
  })

  test('workflowRunId resumes clarifying work and changes for a new workflow', () => {
    const database = new AppDatabase(':memory:')
    try {
      const sessions = new SqliteSessionPersistence(database)
      const session = sessionFixture('s1')
      sessions.save(session, 0)
      const requests = new ChatRequestRepository(database)
      const first = requests.enqueue({
        requestId: 'req-1', traceId: 'trace-1', sessionId: 's1', kind: 'chat',
        startedAt: '2026-07-22T00:00:00.000Z',
      }, { sessionId: 's1', message: 'first clarification' }, 10).request

      const clarifying = sessions.load('s1')!
      clarifying.session.phase = 'clarifying'
      sessions.save(clarifying.session, clarifying.version)
      const second = requests.enqueue({
        requestId: 'req-2', traceId: 'trace-2', sessionId: 's1', kind: 'chat',
        startedAt: '2026-07-22T00:00:01.000Z',
      }, { sessionId: 's1', message: 'second clarification' }, 10).request
      expect(first.workflowRunId).toMatch(/^[0-9a-f-]{36}$/)
      expect(second.workflowRunId).toBe(first.workflowRunId)

      const stored = sessions.load('s1')!
      stored.session.phase = 'completed'
      sessions.save(stored.session, stored.version)
      const next = requests.enqueue({
        requestId: 'req-3', traceId: 'trace-3', sessionId: 's1', kind: 'chat',
        startedAt: '2026-07-22T00:00:02.000Z',
      }, { sessionId: 's1', message: 'new workflow' }, 10).request
      expect(next.workflowRunId).not.toBe(first.workflowRunId)
    } finally {
      database.close()
    }
  })

  test('workflow continuation rejects a phase mismatch or a missing workflow association', () => {
    const database = new AppDatabase(':memory:')
    try {
      const sessions = new SqliteSessionPersistence(database)
      const requests = new ChatRequestRepository(database)
      sessions.save(sessionFixture('completed'), 0)
      expect(() => requests.enqueue({
        requestId: 'req-invalid-phase',
        traceId: 'trace-invalid-phase',
        sessionId: 'completed',
        kind: 'confirm',
        startedAt: '2026-07-22T00:00:00.000Z',
      }, { sessionId: 'completed', action: 'confirm' }, 10)).toThrow(WorkflowRunResolutionError)

      const awaiting = sessionFixture('legacy-awaiting')
      awaiting.phase = 'awaiting_confirmation'
      sessions.save(awaiting, 0)
      expect(() => requests.enqueue({
        requestId: 'req-missing-workflow',
        traceId: 'trace-missing-workflow',
        sessionId: 'legacy-awaiting',
        kind: 'confirm',
        startedAt: '2026-07-22T00:00:01.000Z',
      }, { sessionId: 'legacy-awaiting', action: 'confirm' }, 10)).toThrow(
        'the session has no workflow run to resume',
      )
    } finally {
      database.close()
    }
  })
})
