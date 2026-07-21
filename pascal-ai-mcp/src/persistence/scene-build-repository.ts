import type { AppDatabase } from './database'

export type SceneBuildStatus =
  | 'creating'
  | 'building'
  | 'succeeded'
  | 'abandoned'
  | 'cleanup_failed'
  | 'cleaned'

export type SceneBuildRecord = {
  buildId: string
  requestId: string
  traceId: string
  sessionId: string
  sceneId?: string
  status: SceneBuildStatus
  expectedVersion?: number
  expectedGraphHash?: string
  errorCode?: string
  cleanupAttempts: number
  startedAt: string
  updatedAt: string
  completedAt?: string
  cleanedAt?: string
}

export interface SceneBuildWriter {
  start(record: {
    buildId: string
    requestId: string
    traceId: string
    sessionId: string
    startedAt: string
  }): void
  identifyScene(buildId: string, sceneId: string, updatedAt: string): void
  updateBoundary(buildId: string, boundary: SceneBoundary, updatedAt: string): void
  succeed(buildId: string, boundary: SceneBoundary, completedAt: string): void
  abandon(buildId: string, errorCode: string, completedAt: string): void
  abandonOrphaned(activeStatusesAt: string): number
}

export type SceneBoundary = { version: number; graphHash: string }

type SceneBuildRow = {
  build_id: string
  request_id: string
  trace_id: string
  session_id: string
  scene_id: string | null
  status: SceneBuildStatus
  expected_version: number | null
  expected_graph_hash: string | null
  error_code: string | null
  cleanup_attempts: number
  started_at: string
  updated_at: string
  completed_at: string | null
  cleaned_at: string | null
}

export class SceneBuildRepository implements SceneBuildWriter {
  private readonly findStatement
  private readonly findByRequestStatement
  private readonly startStatement
  private readonly attachStatement
  private readonly boundaryStatement
  private readonly succeedStatement
  private readonly abandonStatement
  private readonly orphanStatement
  private readonly candidatesStatement
  private readonly cleanedStatement
  private readonly cleanupFailedStatement

  constructor(private readonly database: AppDatabase) {
    this.findStatement = database.connection.prepare('SELECT * FROM scene_builds WHERE build_id = ?')
    this.findByRequestStatement = database.connection.prepare(
      'SELECT * FROM scene_builds WHERE request_id = ?',
    )
    this.startStatement = database.connection.prepare(`
      INSERT INTO scene_builds (
        build_id, request_id, trace_id, session_id, status, started_at, updated_at
      ) VALUES (?, ?, ?, ?, 'creating', ?, ?)
    `)
    this.attachStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET scene_id = ?, status = 'building', updated_at = ?
      WHERE build_id = ? AND status = 'creating'
    `)
    this.boundaryStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET expected_version = ?, expected_graph_hash = ?, updated_at = ?
      WHERE build_id = ? AND status = 'building'
    `)
    this.succeedStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET expected_version = ?, expected_graph_hash = ?, status = 'succeeded',
          updated_at = ?, completed_at = ?, error_code = NULL
      WHERE build_id = ? AND status = 'building'
    `)
    this.abandonStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET status = 'abandoned', error_code = ?, updated_at = ?, completed_at = ?
      WHERE build_id = ? AND status IN ('creating', 'building')
    `)
    this.orphanStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET status = 'abandoned',
          error_code = COALESCE(
            (SELECT error_code FROM ai_requests WHERE request_id = scene_builds.request_id),
            'process_interrupted'
          ),
          updated_at = ?, completed_at = COALESCE(completed_at, ?)
      WHERE status IN ('creating', 'building')
        AND EXISTS (
          SELECT 1 FROM ai_requests
          WHERE request_id = scene_builds.request_id
            AND status IN ('failed', 'cancelled')
        )
    `)
    this.candidatesStatement = database.connection.prepare(`
      SELECT * FROM scene_builds
      WHERE status IN ('abandoned', 'cleanup_failed') AND scene_id IS NOT NULL
      ORDER BY updated_at, build_id
    `)
    this.cleanedStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET status = 'cleaned', error_code = ?, cleanup_attempts = cleanup_attempts + 1,
          updated_at = ?, cleaned_at = ?
      WHERE build_id = ? AND status IN ('abandoned', 'cleanup_failed')
    `)
    this.cleanupFailedStatement = database.connection.prepare(`
      UPDATE scene_builds
      SET status = 'cleanup_failed', error_code = ?, cleanup_attempts = cleanup_attempts + 1,
          updated_at = ?
      WHERE build_id = ? AND status IN ('abandoned', 'cleanup_failed')
    `)
  }

  start(record: {
    buildId: string
    requestId: string
    traceId: string
    sessionId: string
    startedAt: string
  }): void {
    this.startStatement.run(
      record.buildId,
      record.requestId,
      record.traceId,
      record.sessionId,
      record.startedAt,
      record.startedAt,
    )
  }

  identifyScene(buildId: string, sceneId: string, updatedAt: string): void {
    expectOne(this.attachStatement.run(sceneId, updatedAt, buildId).changes, buildId)
  }

  updateBoundary(buildId: string, boundary: SceneBoundary, updatedAt: string): void {
    expectOne(
      this.boundaryStatement.run(boundary.version, boundary.graphHash, updatedAt, buildId).changes,
      buildId,
    )
  }

  succeed(buildId: string, boundary: SceneBoundary, completedAt: string): void {
    expectOne(
      this.succeedStatement.run(
        boundary.version,
        boundary.graphHash,
        completedAt,
        completedAt,
        buildId,
      ).changes,
      buildId,
    )
  }

  abandon(buildId: string, errorCode: string, completedAt: string): void {
    expectOne(this.abandonStatement.run(errorCode, completedAt, completedAt, buildId).changes, buildId)
  }

  abandonOrphaned(at: string): number {
    return this.orphanStatement.run(at, at).changes
  }

  find(buildId: string): SceneBuildRecord | undefined {
    const row = this.findStatement.get(buildId) as SceneBuildRow | undefined
    return row ? fromRow(row) : undefined
  }

  findByRequestId(requestId: string): SceneBuildRecord | undefined {
    const row = this.findByRequestStatement.get(requestId) as SceneBuildRow | undefined
    return row ? fromRow(row) : undefined
  }

  cleanupCandidates(): SceneBuildRecord[] {
    return (this.candidatesStatement.all() as SceneBuildRow[]).map(fromRow)
  }

  markCleaned(buildId: string, reason: string, at: string): void {
    expectOne(this.cleanedStatement.run(reason, at, at, buildId).changes, buildId)
  }

  markCleanupFailed(buildId: string, errorCode: string, at: string): void {
    expectOne(this.cleanupFailedStatement.run(errorCode, at, buildId).changes, buildId)
  }
}

function expectOne(changes: number, buildId: string): void {
  if (changes !== 1) throw new Error(`scene build ${buildId} is missing or in the wrong state`)
}

function fromRow(row: SceneBuildRow): SceneBuildRecord {
  return {
    buildId: row.build_id,
    requestId: row.request_id,
    traceId: row.trace_id,
    sessionId: row.session_id,
    ...(row.scene_id ? { sceneId: row.scene_id } : {}),
    status: row.status,
    ...(row.expected_version !== null ? { expectedVersion: row.expected_version } : {}),
    ...(row.expected_graph_hash ? { expectedGraphHash: row.expected_graph_hash } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    cleanupAttempts: row.cleanup_attempts,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.cleaned_at ? { cleanedAt: row.cleaned_at } : {}),
  }
}
