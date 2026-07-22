import type { AppDatabase } from './database'

export type ArtifactMimeType = 'image/png' | 'image/jpeg'
export type ArtifactStatus = 'active' | 'delete_pending' | 'delete_failed'

export type ArtifactRecord = {
  artifactId: string
  requestId: string
  sessionId: string
  kind: 'request_image'
  storageKey: string
  mimeType: ArtifactMimeType
  sizeBytes: number
  sha256: string
  status: ArtifactStatus
  expiresAt: string
  deleteAttempts: number
  lastErrorCode?: string
  createdAt: string
  updatedAt: string
}

export type ArtifactCreate = Omit<
  ArtifactRecord,
  'status' | 'deleteAttempts' | 'lastErrorCode' | 'updatedAt'
>

type ArtifactRow = {
  artifact_id: string
  request_id: string
  session_id: string
  kind: 'request_image'
  storage_key: string
  mime_type: ArtifactMimeType
  size_bytes: number
  sha256: string
  status: ArtifactStatus
  expires_at: string
  delete_attempts: number
  last_error_code: string | null
  created_at: string
  updated_at: string
}

export class ArtifactRepository {
  private readonly insertStatement
  private readonly findStatement
  private readonly bySessionStatement
  private readonly cleanupCandidatesStatement
  private readonly storageKeysStatement
  private readonly markPendingStatement
  private readonly markFailedStatement
  private readonly deleteStatement

  constructor(private readonly database: AppDatabase) {
    this.insertStatement = database.connection.prepare(`
      INSERT INTO ai_artifacts (
        artifact_id, request_id, session_id, kind, storage_key,
        mime_type, size_bytes, sha256, status, expires_at,
        delete_attempts, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, 'request_image', ?, ?, ?, ?, 'active', ?, 0, NULL, ?, ?)
    `)
    this.findStatement = database.connection.prepare(`
      SELECT * FROM ai_artifacts WHERE artifact_id = ?
    `)
    this.bySessionStatement = database.connection.prepare(`
      SELECT * FROM ai_artifacts
      WHERE session_id = ?
      ORDER BY created_at, artifact_id
    `)
    this.cleanupCandidatesStatement = database.connection.prepare(`
      SELECT artifact.*
      FROM ai_artifacts AS artifact
      LEFT JOIN ai_requests AS request ON request.request_id = artifact.request_id
      WHERE artifact.status IN ('delete_pending', 'delete_failed')
         OR artifact.expires_at <= ?
         OR request.status IN ('succeeded', 'failed', 'cancelled')
         OR (request.request_id IS NULL AND artifact.created_at <= ?)
      ORDER BY artifact.created_at, artifact.artifact_id
    `)
    this.storageKeysStatement = database.connection.prepare(`
      SELECT storage_key FROM ai_artifacts
    `)
    this.markPendingStatement = database.connection.prepare(`
      UPDATE ai_artifacts
      SET status = 'delete_pending', delete_attempts = delete_attempts + 1,
          last_error_code = NULL, updated_at = ?
      WHERE artifact_id = ? AND status IN ('active', 'delete_failed', 'delete_pending')
    `)
    this.markFailedStatement = database.connection.prepare(`
      UPDATE ai_artifacts
      SET status = 'delete_failed', last_error_code = ?, updated_at = ?
      WHERE artifact_id = ?
    `)
    this.deleteStatement = database.connection.prepare(`
      DELETE FROM ai_artifacts WHERE artifact_id = ?
    `)
  }

  create(record: ArtifactCreate): void {
    this.insertStatement.run(
      record.artifactId,
      record.requestId,
      record.sessionId,
      record.storageKey,
      record.mimeType,
      record.sizeBytes,
      record.sha256,
      record.expiresAt,
      record.createdAt,
      record.createdAt,
    )
  }

  find(artifactId: string): ArtifactRecord | undefined {
    const row = this.findStatement.get(artifactId) as ArtifactRow | undefined
    return row ? fromRow(row) : undefined
  }

  findReadable(artifactId: string, now = new Date().toISOString()): ArtifactRecord | undefined {
    const record = this.find(artifactId)
    return record?.status === 'active' && record.expiresAt > now ? record : undefined
  }

  findBySessionId(sessionId: string): ArtifactRecord[] {
    return (this.bySessionStatement.all(sessionId) as ArtifactRow[]).map(fromRow)
  }

  cleanupCandidates(now: string, missingRequestBefore: string): ArtifactRecord[] {
    return (this.cleanupCandidatesStatement.all(now, missingRequestBefore) as ArtifactRow[]).map(fromRow)
  }

  storageKeys(): Set<string> {
    return new Set(
      (this.storageKeysStatement.all() as Array<{ storage_key: string }>).map(row => row.storage_key),
    )
  }

  markDeletePending(artifactId: string, updatedAt: string): boolean {
    return this.markPendingStatement.run(updatedAt, artifactId).changes === 1
  }

  markDeleteFailed(artifactId: string, errorCode: string, updatedAt: string): void {
    this.markFailedStatement.run(errorCode, updatedAt, artifactId)
  }

  remove(artifactId: string): boolean {
    return this.deleteStatement.run(artifactId).changes === 1
  }
}

function fromRow(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.artifact_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    kind: row.kind,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    status: row.status,
    expiresAt: row.expires_at,
    deleteAttempts: row.delete_attempts,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
