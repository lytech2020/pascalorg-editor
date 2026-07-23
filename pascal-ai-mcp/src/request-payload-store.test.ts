import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactRepository } from './persistence/artifact-repository'
import { AppDatabase } from './persistence/database'
import {
  ChatRequestRepository,
  SqliteSessionPersistence,
} from './persistence/session-repository'
import { RequestPayloadStore } from './request-payload-store'
import type { WorkflowSession } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='

function fixture(sessionId: string): WorkflowSession {
  const now = '2026-07-22T00:00:00.000Z'
  return {
    sessionId,
    inputType: 'text',
    phase: 'completed',
    availability: 'partially_usable',
    brief: {
      existingCondition: [], designGoals: [], hardConstraints: [],
      assumptions: [], uncertainties: [], conflicts: [],
    },
    questions: [], reasons: [], summary: '',
    messages: [{ role: 'user', content: 'private request' }],
    clarificationRounds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

describe('private request artifacts (T1.6)', () => {
  test('stores only an artifact id in the queued request and keeps metadata in ai_artifacts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-reference-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const artifacts = new ArtifactRepository(database)
      const payloads = new RequestPayloadStore(join(dir, 'files'), artifacts, DAY_MS)
      const now = new Date()
      const artifactId = payloads.persistImage(IMAGE, {
        requestId: 'req-1', sessionId: 's1', now,
      })
      const record = artifacts.find(artifactId)!
      expect(record).toMatchObject({
        requestId: 'req-1', sessionId: 's1', mimeType: 'image/png',
        sizeBytes: 8, status: 'active', deleteAttempts: 0,
        expiresAt: new Date(now.getTime() + DAY_MS).toISOString(),
      })
      expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(payloads.loadImage(artifactId)).toBe(IMAGE)
      expect(statSync(join(dir, 'files', record.storageKey)).mode & 0o777).toBe(0o600)

      const requests = new ChatRequestRepository(database)
      requests.enqueue({
        requestId: 'req-1', traceId: 'trace-1', sessionId: 's1', kind: 'chat',
        startedAt: '2026-07-22T00:00:01.000Z',
      }, { sessionId: 's1', imageArtifactId: artifactId }, 10)
      const stored = database.connection.query(
        'SELECT input_json FROM ai_requests WHERE request_id = ?',
      ).get('req-1') as { input_json: string }
      expect(JSON.parse(stored.input_json)).toEqual({ sessionId: 's1', imageArtifactId: artifactId })
      expect(stored.input_json).not.toContain(record.sha256)
      expect(stored.input_json).not.toContain(record.mimeType)
      expect(stored.input_json).not.toContain('base64')
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('idempotency compares image content rather than the temporary artifact id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-idempotency-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const artifacts = new ArtifactRepository(database)
      const payloads = new RequestPayloadStore(join(dir, 'files'), artifacts, DAY_MS)
      const requests = new ChatRequestRepository(database)
      const firstId = payloads.persistImage(IMAGE, { requestId: 'req-1', sessionId: 's1' })
      const first = requests.enqueue({
        requestId: 'req-1', traceId: 'trace-1', sessionId: 's1', kind: 'chat',
        idempotencyKey: 'same-image-key', startedAt: new Date().toISOString(),
      }, { sessionId: 's1', imageArtifactId: firstId }, 10)
      const secondId = payloads.persistImage(IMAGE, { requestId: 'req-2', sessionId: 's1' })
      const second = requests.enqueue({
        requestId: 'req-2', traceId: 'trace-2', sessionId: 's1', kind: 'chat',
        idempotencyKey: 'same-image-key', startedAt: new Date().toISOString(),
      }, { sessionId: 's1', imageArtifactId: secondId }, 10)
      expect(first.created).toBe(true)
      expect(second).toMatchObject({ created: false, request: { requestId: 'req-1' } })
      payloads.deleteImage(secondId)
      expect(artifacts.find(secondId)).toBeUndefined()
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('failed deletion becomes inaccessible and a later cleanup retry removes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-delete-retry-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const artifacts = new ArtifactRepository(database)
      const files = join(dir, 'files')
      const payloads = new RequestPayloadStore(files, artifacts, DAY_MS)
      const artifactId = payloads.persistImage(IMAGE, { requestId: 'req-1', sessionId: 's1' })
      const path = join(files, artifacts.find(artifactId)!.storageKey)
      rmSync(path)
      mkdirSync(path)

      expect(() => payloads.deleteImage(artifactId)).toThrow()
      expect(artifacts.find(artifactId)).toMatchObject({
        status: 'delete_failed', deleteAttempts: 1, lastErrorCode: 'filesystem_delete_failed',
      })
      expect(() => payloads.loadImage(artifactId)).toThrow('unavailable')

      rmSync(path, { recursive: true })
      expect(payloads.cleanup()).toEqual({ deleted: 1, failed: 0 })
      expect(artifacts.find(artifactId)).toBeUndefined()
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('cleanup removes expired database records and unregistered old files idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-maintenance-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const artifacts = new ArtifactRepository(database)
      const files = join(dir, 'files')
      const payloads = new RequestPayloadStore(files, artifacts, 1_000)
      payloads.persistImage(IMAGE, {
        requestId: 'req-expired', sessionId: 's1', now: new Date('2026-07-22T00:00:00.000Z'),
      })
      const orphanId = crypto.randomUUID()
      const orphan = join(files, `${orphanId}.png`)
      const temporary = join(files, `${crypto.randomUUID()}.jpg.${crypto.randomUUID()}.tmp`)
      writeFileSync(orphan, 'orphan')
      writeFileSync(temporary, 'temporary')
      const old = new Date('2026-07-22T00:00:00.000Z')
      utimesSync(orphan, old, old)
      utimesSync(temporary, old, old)
      const now = new Date('2026-07-23T00:00:00.000Z')

      const report = payloads.maintenanceReport(now)
      expect(report.databaseCandidates).toHaveLength(1)
      expect(report.orphanStorageKeys).toHaveLength(2)
      expect(payloads.cleanup(now)).toEqual({ deleted: 3, failed: 0 })
      expect(payloads.cleanup(now)).toEqual({ deleted: 0, failed: 0 })
      expect(readdirSync(files)).toEqual([])
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('session deletion removes messages and images while retaining request audit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-session-delete-'))
    const database = new AppDatabase(join(dir, 'ai.db'))
    try {
      const sessions = new SqliteSessionPersistence(database)
      sessions.save(fixture('s1'), 0)
      const artifacts = new ArtifactRepository(database)
      const files = join(dir, 'files')
      const payloads = new RequestPayloadStore(files, artifacts, DAY_MS)
      const artifactId = payloads.persistImage(IMAGE, { requestId: 'req-1', sessionId: 's1' })
      const requests = new ChatRequestRepository(database)
      requests.start({
        requestId: 'req-1', traceId: 'trace-1', sessionId: 's1', kind: 'chat',
        startedAt: '2026-07-22T00:00:00.000Z',
      })
      requests.finish('req-1', 'succeeded', '2026-07-22T00:00:01.000Z')

      expect(sessions.delete('s1')).toBe(true)
      expect(payloads.deleteSessionImages('s1')).toEqual({ deleted: 1, failed: 0 })
      expect(artifacts.find(artifactId)).toBeUndefined()
      expect(readdirSync(files)).toEqual([])
      expect(database.connection.query('SELECT COUNT(*) AS count FROM ai_messages').get())
        .toEqual({ count: 0 })
      expect(requests.find('req-1')).toMatchObject({ status: 'succeeded', kind: 'chat' })
      expect(payloads.deleteSessionImages('s1')).toEqual({ deleted: 0, failed: 0 })
    } finally {
      database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
