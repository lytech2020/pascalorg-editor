import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChatMessage, WorkflowSession } from '../types'
import type { AppDatabase } from './database'

export type StoredSession = { session: WorkflowSession; version: number }

export class SessionVersionConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number | null,
  ) {
    super(`session ${sessionId} version conflict: expected ${expectedVersion}, actual ${actualVersion ?? 'missing'}`)
    this.name = 'SessionVersionConflictError'
  }
}

class SessionPersistenceDataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionPersistenceDataError'
  }
}

type SessionRow = {
  session_id: string
  version: number
  phase: WorkflowSession['phase']
  state_json: string
  created_at: string
  updated_at: string
}

type MessageRow = {
  sequence: number
  message_json: string
}

export class SessionStateRepository {
  private readonly findStatement
  private readonly allStatement
  private readonly insertStatement
  private readonly updateStatement
  private readonly deleteStatement
  private readonly versionStatement

  constructor(private readonly database: AppDatabase) {
    this.findStatement = database.connection.prepare('SELECT * FROM ai_sessions WHERE session_id = ?')
    this.allStatement = database.connection.prepare('SELECT * FROM ai_sessions ORDER BY created_at, session_id')
    this.insertStatement = database.connection.prepare(`
      INSERT INTO ai_sessions (
        session_id, version, user_id, org_id, project_id,
        phase, state_json, created_at, updated_at
      ) VALUES (?, 1, NULL, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO NOTHING
    `)
    this.updateStatement = database.connection.prepare(`
      UPDATE ai_sessions
      SET version = version + 1, phase = ?, state_json = ?, updated_at = ?
      WHERE session_id = ? AND version = ?
    `)
    this.deleteStatement = database.connection.prepare('DELETE FROM ai_sessions WHERE session_id = ?')
    this.versionStatement = database.connection.prepare('SELECT version FROM ai_sessions WHERE session_id = ?')
  }

  findRow(sessionId: string): SessionRow | undefined {
    return this.findStatement.get(sessionId) as SessionRow | undefined
  }

  allRows(): SessionRow[] {
    return this.allStatement.all() as SessionRow[]
  }

  saveState(session: WorkflowSession, expectedVersion: number): number {
    const stateJson = serializeSessionState(session)
    const result = expectedVersion === 0
      ? this.insertStatement.run(
          session.sessionId,
          session.phase,
          stateJson,
          session.createdAt,
          session.updatedAt,
        )
      : this.updateStatement.run(
          session.phase,
          stateJson,
          session.updatedAt,
          session.sessionId,
          expectedVersion,
        )
    if (result.changes !== 1) {
      const current = this.versionStatement.get(session.sessionId) as { version: number } | undefined
      throw new SessionVersionConflictError(session.sessionId, expectedVersion, current?.version ?? null)
    }
    return expectedVersion + 1
  }

  delete(sessionId: string): boolean {
    return this.deleteStatement.run(sessionId).changes > 0
  }
}

export class SessionMessageRepository {
  private readonly bySessionStatement
  private readonly upsertStatement
  private readonly deleteTailStatement

  constructor(private readonly database: AppDatabase) {
    this.bySessionStatement = database.connection.prepare(`
      SELECT sequence, message_json FROM ai_messages
      WHERE session_id = ? ORDER BY sequence
    `)
    this.upsertStatement = database.connection.prepare(`
      INSERT INTO ai_messages (session_id, sequence, role, message_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, sequence) DO UPDATE SET
        role = excluded.role,
        message_json = excluded.message_json
    `)
    this.deleteTailStatement = database.connection.prepare(`
      DELETE FROM ai_messages WHERE session_id = ? AND sequence >= ?
    `)
  }

  findBySessionId(sessionId: string): ChatMessage[] {
    return (this.bySessionStatement.all(sessionId) as MessageRow[]).map((row, index) => {
      if (row.sequence !== index) throw new Error(`session ${sessionId} message sequence has a gap at ${index}`)
      return JSON.parse(row.message_json) as ChatMessage
    })
  }

  replaceForSession(session: WorkflowSession): void {
    for (let sequence = 0; sequence < session.messages.length; sequence++) {
      const message = session.messages[sequence]!
      const messageJson = JSON.stringify(message)
      this.upsertStatement.run(
        session.sessionId,
        sequence,
        message.role,
        messageJson,
        session.updatedAt,
      )
    }
    this.deleteTailStatement.run(session.sessionId, session.messages.length)
  }
}

export interface SessionPersistence {
  all(): StoredSession[]
  load(sessionId: string): StoredSession | undefined
  save(session: WorkflowSession, expectedVersion: number): number
  delete(sessionId: string): boolean
  importLegacyFile(filePath: string): LegacyImportResult
}

export type LegacyImportResult = {
  status: 'absent' | 'already_imported' | 'imported'
  imported: number
  skipped: number
}

export class SqliteSessionPersistence implements SessionPersistence {
  private readonly states: SessionStateRepository
  private readonly messages: SessionMessageRepository
  private readonly importedStatement
  private readonly recordImportStatement
  private readonly scrubRequestPayloadsStatement

  constructor(private readonly database: AppDatabase) {
    this.states = new SessionStateRepository(database)
    this.messages = new SessionMessageRepository(database)
    this.importedStatement = database.connection.prepare(`
      SELECT source_path FROM legacy_session_imports WHERE source_path = ?
    `)
    this.recordImportStatement = database.connection.prepare(`
      INSERT INTO legacy_session_imports (
        source_path, source_hash, imported_sessions, skipped_sessions, imported_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    this.scrubRequestPayloadsStatement = database.connection.prepare(`
      UPDATE ai_requests SET input_json = NULL, result_json = NULL WHERE session_id = ?
    `)
  }

  all(): StoredSession[] {
    return this.states.allRows().map(row => this.hydrate(row))
  }

  load(sessionId: string): StoredSession | undefined {
    const row = this.states.findRow(sessionId)
    return row ? this.hydrate(row) : undefined
  }

  save(session: WorkflowSession, expectedVersion: number): number {
    return this.database.transaction(() => this.saveWithinTransaction(session, expectedVersion))
  }

  delete(sessionId: string): boolean {
    return this.database.transaction(() => {
      const deleted = this.states.delete(sessionId)
      this.scrubRequestPayloadsStatement.run(sessionId)
      return deleted
    })
  }

  importLegacyFile(filePath: string): LegacyImportResult {
    const sourcePath = resolve(filePath)
    if (!existsSync(sourcePath)) return { status: 'absent', imported: 0, skipped: 0 }
    const raw = readFileSync(sourcePath, 'utf8')
    const sourceHash = createHash('sha256').update(raw).digest('hex')
    try {
      return this.database.connection.transaction(() => {
        if (this.importedStatement.get(sourcePath)) {
          return { status: 'already_imported', imported: 0, skipped: 0 } as LegacyImportResult
        }
        const parsed = raw.trim() ? JSON.parse(raw) as { sessions?: Record<string, unknown> } : {}
        let imported = 0
        let skipped = 0
        for (const [sessionId, value] of Object.entries(parsed.sessions ?? {})) {
          if (!isWorkflowSession(value) || this.states.findRow(sessionId)) {
            skipped++
            continue
          }
          const session = {
            ...structuredClone(value),
            sessionId,
            messages: Array.isArray(value.messages) ? structuredClone(value.messages) : [],
          }
          try {
            this.saveWithinTransaction(session, 0)
            imported++
          } catch (error) {
            if (!(error instanceof SessionPersistenceDataError)) throw error
            skipped++
            console.warn(`legacy-sessions: skipped invalid session ${sessionId} from ${sourcePath}: ${error.message}`)
          }
        }
        this.recordImportStatement.run(
          sourcePath,
          sourceHash,
          imported,
          skipped,
          new Date().toISOString(),
        )
        return { status: 'imported', imported, skipped } as LegacyImportResult
      }).immediate()
    } catch (error) {
      throw new Error(`Failed to import legacy session file ${sourcePath}: ${errorMessage(error)}`)
    }
  }

  private saveWithinTransaction(session: WorkflowSession, expectedVersion: number): number {
    validateSessionMessages(session)
    const version = this.states.saveState(session, expectedVersion)
    this.messages.replaceForSession(session)
    return version
  }

  private hydrate(row: SessionRow): StoredSession {
    const state = JSON.parse(row.state_json) as Omit<
      WorkflowSession,
      'sessionId' | 'phase' | 'messages' | 'createdAt' | 'updatedAt'
    >
    return {
      version: row.version,
      session: {
        sessionId: row.session_id,
        phase: row.phase,
        ...state,
        messages: this.messages.findBySessionId(row.session_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    }
  }
}

export type ChatRequestKind = 'chat' | 'confirm' | 'cancel'
export type ChatRequestStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type QueuedChatInput = {
  sessionId: string
  message?: string
  imageArtifact?: {
    id: string
    mimeType: 'image/png' | 'image/jpeg'
    sizeBytes: number
    sha256: string
  }
  sceneId?: string
  action?: 'confirm' | 'cancel'
}

export type QueuedChatResult = {
  sessionId: string
  reply: string
  phase: WorkflowSession['phase']
  sessionVersion: number
}

export type ChatRequestRecord = {
  requestId: string
  traceId: string
  clientRequestId?: string
  sessionId: string
  kind: ChatRequestKind
  status: ChatRequestStatus
  sceneId?: string
  idempotencyKey?: string
  idempotencySubject?: string
  input?: QueuedChatInput
  result?: QueuedChatResult
  errorCode?: string
  ownerInstanceId?: string
  leaseExpiresAt?: string
  heartbeatAt?: string
  runAttempts: number
  queuedAt: string
  startedAt?: string
  completedAt?: string
}

export type ChatRequestStart = {
  requestId: string
  traceId: string
  clientRequestId?: string
  sessionId: string
  kind: ChatRequestKind
  sceneId?: string
  idempotencyKey?: string
  // Set only by the trusted server composition root. The browser cannot
  // choose this scope; local-only deployments use the default "local".
  idempotencySubject?: string
  startedAt: string
}

export interface ChatRequestWriter {
  start(record: ChatRequestStart): void
  finish(requestId: string, status: ChatRequestStatus, completedAt: string, errorCode?: string): void
  hasLiveWorkerRequest?(sessionId: string, now: string): boolean
}

export class RequestQueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`request queue is full (${limit})`)
    this.name = 'RequestQueueFullError'
  }
}

export class RequestCancellationTargetNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} has no session or active request to cancel`)
    this.name = 'RequestCancellationTargetNotFoundError'
  }
}

export class RequestIdempotencyConflictError extends Error {
  constructor(readonly requestId: string) {
    super(`idempotency key is already used by request ${requestId} with different input`)
    this.name = 'RequestIdempotencyConflictError'
  }
}

export type EnqueueResult = {
  request: ChatRequestRecord
  created: boolean
  cancelled: ChatRequestRecord[]
}

export class ChatRequestRepository implements ChatRequestWriter {
  private readonly startStatement
  private readonly finishStatement
  private readonly reconcileDirectStepsStatement
  private readonly findStatement
  private readonly activeCountStatement
  private readonly enqueueStatement
  private readonly queuedBySessionStatement
  private readonly cancelQueuedStatement
  private readonly claimCandidateStatement
  private readonly claimStatement
  private readonly heartbeatStatement
  private readonly completeStatement
  private readonly expiredStatement
  private readonly failExpiredStatement
  private readonly liveWorkerBySessionStatement
  private readonly activeBySessionStatement
  private readonly cancellationTargetStatement
  private readonly findIdempotentStatement

  constructor(private readonly database: AppDatabase) {
    this.startStatement = database.connection.prepare(`
      INSERT INTO ai_requests (
        request_id, trace_id, client_request_id, session_id, kind,
        status, scene_id, input_json, result_json, error_code,
        owner_instance_id, lease_expires_at, heartbeat_at, run_attempts,
        queued_at, started_at, completed_at, idempotency_key, input_hash, idempotency_subject
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, NULL, NULL, NULL,
        'direct', NULL, NULL, 1, ?, ?, NULL, NULL, NULL, 'local')
    `)
    this.finishStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET status = ?, error_code = ?, completed_at = ?, owner_instance_id = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL, input_json = NULL
      WHERE request_id = ? AND status = 'running'
    `)
    this.reconcileDirectStepsStatement = database.connection.prepare(`
      UPDATE workflow_steps
      SET status = 'failed_recoverable', error_code = 'step_persistence_incomplete',
          completed_at = ?
      WHERE request_id = ? AND status = 'running'
    `)
    this.findStatement = database.connection.prepare(`
      SELECT * FROM ai_requests WHERE request_id = ?
    `)
    this.activeCountStatement = database.connection.prepare(`
      SELECT COUNT(*) AS count FROM ai_requests
      WHERE status = 'queued'
         OR (status = 'running' AND owner_instance_id LIKE 'worker:%')
    `)
    this.enqueueStatement = database.connection.prepare(`
      INSERT INTO ai_requests (
        request_id, trace_id, client_request_id, session_id, kind,
        status, scene_id, input_json, result_json, error_code,
        owner_instance_id, lease_expires_at, heartbeat_at, run_attempts,
        queued_at, started_at, completed_at, idempotency_key, input_hash, idempotency_subject
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, NULL,
        NULL, NULL, NULL, 0, ?, NULL, NULL, ?, ?, ?)
    `)
    this.queuedBySessionStatement = database.connection.prepare(`
      SELECT * FROM ai_requests
      WHERE session_id = ? AND status = 'queued'
      ORDER BY queued_at, request_id
    `)
    this.cancelQueuedStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET status = 'cancelled', error_code = 'cancelled_by_user',
          completed_at = ?, input_json = NULL
      WHERE request_id = ? AND status = 'queued'
    `)
    this.claimCandidateStatement = database.connection.prepare(`
      SELECT candidate.* FROM ai_requests AS candidate
      WHERE candidate.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM ai_requests AS active
          WHERE active.status = 'running'
            AND active.owner_instance_id LIKE 'worker:%'
            AND active.request_id <> candidate.request_id
            AND (
              active.session_id = candidate.session_id
              OR (
                candidate.scene_id IS NOT NULL
                AND active.scene_id = candidate.scene_id
              )
            )
        )
      ORDER BY CASE candidate.kind WHEN 'cancel' THEN 0 ELSE 1 END,
               candidate.queued_at, candidate.request_id
      LIMIT 1
    `)
    this.claimStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET status = 'running', owner_instance_id = ?, lease_expires_at = ?,
          heartbeat_at = ?, run_attempts = run_attempts + 1,
          started_at = COALESCE(started_at, ?)
      WHERE request_id = ? AND status = 'queued'
    `)
    this.heartbeatStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET heartbeat_at = ?, lease_expires_at = ?
      WHERE request_id = ? AND status = 'running' AND owner_instance_id = ?
    `)
    this.completeStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET status = ?, result_json = ?, error_code = ?, completed_at = ?,
          input_json = NULL, owner_instance_id = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL
      WHERE request_id = ? AND status = 'running' AND owner_instance_id = ?
    `)
    this.expiredStatement = database.connection.prepare(`
      SELECT * FROM ai_requests
      WHERE status = 'running'
        AND owner_instance_id LIKE 'worker:%'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      ORDER BY lease_expires_at, request_id
    `)
    this.failExpiredStatement = database.connection.prepare(`
      UPDATE ai_requests
      SET status = 'failed', error_code = 'process_interrupted', completed_at = ?,
          input_json = NULL, owner_instance_id = NULL,
          lease_expires_at = NULL, heartbeat_at = NULL
      WHERE request_id = ? AND status = 'running' AND owner_instance_id = ?
    `)
    this.liveWorkerBySessionStatement = database.connection.prepare(`
      SELECT 1 FROM ai_requests
      WHERE session_id = ?
        AND (
          status = 'queued'
          OR (
            status = 'running'
            AND owner_instance_id LIKE 'worker:%'
            AND lease_expires_at > ?
          )
        )
      LIMIT 1
    `)
    this.activeBySessionStatement = database.connection.prepare(`
      SELECT 1 FROM ai_requests
      WHERE session_id = ?
        AND (
          status = 'queued'
          OR (status = 'running' AND owner_instance_id LIKE 'worker:%')
        )
      LIMIT 1
    `)
    this.cancellationTargetStatement = database.connection.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM ai_sessions WHERE session_id = ?
      ) OR EXISTS (
        SELECT 1 FROM ai_requests
        WHERE session_id = ? AND status IN ('queued', 'running')
      )
    `)
    this.findIdempotentStatement = database.connection.prepare(`
      SELECT * FROM ai_requests
      WHERE idempotency_subject = ? AND session_id = ? AND kind = ?
        AND (scene_id = ? OR (scene_id IS NULL AND ? IS NULL))
        AND idempotency_key = ?
      LIMIT 1
    `)
  }

  start(record: ChatRequestStart): void {
    this.startStatement.run(
      record.requestId,
      record.traceId,
      record.clientRequestId ?? null,
      record.sessionId,
      record.kind,
      record.sceneId ?? null,
      record.startedAt,
      record.startedAt,
    )
  }

  finish(requestId: string, status: ChatRequestStatus, completedAt: string, errorCode?: string): void {
    if (status !== 'succeeded' && status !== 'failed') {
      throw new Error(`direct request cannot finish with status ${status}`)
    }
    this.database.connection.transaction(() => {
      this.reconcileDirectStepsStatement.run(completedAt, requestId)
      const result = this.finishStatement.run(status, errorCode ?? null, completedAt, requestId)
      if (result.changes !== 1) throw new Error(`request ${requestId} is missing or already completed`)
    }).immediate()
  }

  enqueue(record: ChatRequestStart, input: QueuedChatInput, maxActive: number): EnqueueResult {
    assertQueuedInputSafe(input)
    const inputJson = JSON.stringify(input)
    const inputHash = queuedInputHash(input)
    const idempotencySubject = record.idempotencySubject ?? 'local'
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencySubject)) {
      throw new Error('invalid trusted idempotency subject')
    }
    return this.database.connection.transaction(() => {
      if (record.idempotencyKey) {
        const existing = this.findIdempotentStatement.get(
          idempotencySubject,
          record.sessionId,
          record.kind,
          record.sceneId ?? null,
          record.sceneId ?? null,
          record.idempotencyKey,
        ) as RequestRow | undefined
        if (existing) {
          if (existing.input_hash !== inputHash) {
            throw new RequestIdempotencyConflictError(existing.request_id)
          }
          return { request: requestRecordFromRow(existing), created: false, cancelled: [] }
        }
      }
      const count = (this.activeCountStatement.get() as { count: number }).count
      if (record.kind !== 'cancel' && count >= maxActive) throw new RequestQueueFullError(maxActive)
      const cancelled: ChatRequestRecord[] = []
      if (record.kind === 'cancel') {
        if (!this.cancellationTargetStatement.get(record.sessionId, record.sessionId)) {
          throw new RequestCancellationTargetNotFoundError(record.sessionId)
        }
        const queued = this.queuedBySessionStatement.all(record.sessionId) as RequestRow[]
        for (const row of queued) {
          if (this.cancelQueuedStatement.run(record.startedAt, row.request_id).changes === 1) {
            cancelled.push(requestRecordFromRow(row))
          }
        }
      }
      this.enqueueStatement.run(
        record.requestId,
        record.traceId,
        record.clientRequestId ?? null,
        record.sessionId,
        record.kind,
        record.sceneId ?? null,
        inputJson,
        record.startedAt,
        record.idempotencyKey ?? null,
        inputHash,
        idempotencySubject,
      )
      const created = this.find(record.requestId)
      if (!created) throw new Error(`request ${record.requestId} was not persisted`)
      return { request: created, created: true, cancelled }
    }).immediate()
  }

  find(requestId: string): ChatRequestRecord | undefined {
    const row = this.findStatement.get(requestId) as RequestRow | undefined
    return row ? requestRecordFromRow(row) : undefined
  }

  claimNext(ownerInstanceId: string, now: string, leaseExpiresAt: string): ChatRequestRecord | undefined {
    return this.database.connection.transaction(() => {
      const row = this.claimCandidateStatement.get() as RequestRow | undefined
      if (!row) return undefined
      const claimed = this.claimStatement.run(
        ownerInstanceId,
        leaseExpiresAt,
        now,
        now,
        row.request_id,
      )
      if (claimed.changes !== 1) return undefined
      return this.find(row.request_id)
    }).immediate()
  }

  heartbeat(requestId: string, ownerInstanceId: string, now: string, leaseExpiresAt: string): boolean {
    return this.heartbeatStatement.run(now, leaseExpiresAt, requestId, ownerInstanceId).changes === 1
  }

  complete(
    requestId: string,
    ownerInstanceId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    completedAt: string,
    result?: QueuedChatResult,
    errorCode?: string,
  ): void {
    const changed = this.completeStatement.run(
      status,
      result ? JSON.stringify(result) : null,
      errorCode ?? null,
      completedAt,
      requestId,
      ownerInstanceId,
    ).changes
    if (changed !== 1) throw new Error(`request ${requestId} lease is missing or no longer owned`)
  }

  failExpiredWorkerRequests(now: string): ChatRequestRecord[] {
    return this.database.connection.transaction(() => {
      const rows = this.expiredStatement.all(now) as RequestRow[]
      const failed: ChatRequestRecord[] = []
      for (const row of rows) {
        if (!row.owner_instance_id) continue
        const changed = this.failExpiredStatement.run(
          now,
          row.request_id,
          row.owner_instance_id,
        ).changes
        if (changed === 1) failed.push(requestRecordFromRow(row))
      }
      return failed
    }).immediate()
  }

  hasLiveWorkerRequest(sessionId: string, now: string): boolean {
    return this.liveWorkerBySessionStatement.get(sessionId, now) !== null
  }

  hasActiveRequest(sessionId: string): boolean {
    return this.activeBySessionStatement.get(sessionId) !== null
  }
}

type RequestRow = {
  request_id: string
  trace_id: string
  client_request_id: string | null
  session_id: string
  kind: ChatRequestKind
  status: ChatRequestStatus
  scene_id: string | null
  input_json: string | null
  result_json: string | null
  error_code: string | null
  owner_instance_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  run_attempts: number
  queued_at: string
  started_at: string | null
  completed_at: string | null
  idempotency_key: string | null
  input_hash: string | null
  idempotency_subject: string
}

function requestRecordFromRow(row: RequestRow): ChatRequestRecord {
  return {
    requestId: row.request_id,
    traceId: row.trace_id,
    ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}),
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    ...(row.scene_id ? { sceneId: row.scene_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.idempotency_subject !== 'local' ? { idempotencySubject: row.idempotency_subject } : {}),
    ...(row.input_json ? { input: JSON.parse(row.input_json) as QueuedChatInput } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as QueuedChatResult } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.owner_instance_id ? { ownerInstanceId: row.owner_instance_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
    runAttempts: row.run_attempts,
    queuedAt: row.queued_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  }
}

function assertQueuedInputSafe(input: QueuedChatInput): void {
  const json = JSON.stringify(input)
  if (/data:image\/[a-z0-9.+-]+;base64,/i.test(json)) {
    throw new SessionPersistenceDataError('queued request contains inline image data')
  }
}

function queuedInputHash(input: QueuedChatInput): string {
  const hashable = {
    sessionId: input.sessionId,
    message: input.message ?? null,
    sceneId: input.sceneId ?? null,
    action: input.action ?? null,
    image: input.imageArtifact ? {
      mimeType: input.imageArtifact.mimeType,
      sizeBytes: input.imageArtifact.sizeBytes,
      sha256: input.imageArtifact.sha256,
    } : null,
  }
  return createHash('sha256').update(JSON.stringify(hashable)).digest('hex')
}

function serializeSessionState(session: WorkflowSession): string {
  const {
    sessionId: _sessionId,
    phase: _phase,
    messages: _messages,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...state
  } = session
  return JSON.stringify(state)
}

function validateSessionMessages(session: WorkflowSession): void {
  for (let sequence = 0; sequence < session.messages.length; sequence++) {
    const message = session.messages[sequence]!
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new SessionPersistenceDataError(
        `session ${session.sessionId} contains non-visible message role ${message.role}`,
      )
    }
    if (/data:image\/[a-z0-9.+-]+;base64,/i.test(JSON.stringify(message))) {
      throw new SessionPersistenceDataError(
        `session ${session.sessionId} message ${sequence} contains inline image data`,
      )
    }
  }
}

function isWorkflowSession(value: unknown): value is WorkflowSession {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'phase' in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
