import type { AppDatabase } from './database'

export type AuditIdentity = {
  requestId: string
  workflowRunId?: string
  workflowStepId?: string
  sessionId: string
  sceneId?: string
  operationKey: string
}

export type ToolCallAuditStart = AuditIdentity & {
  auditId: string
  toolName: string
  mutating: boolean
  argsSummary: Record<string, unknown>
  startedAt: string
}

export type SceneChangeAudit = AuditIdentity & {
  changeId: string
  toolCallAuditId: string
  changeType: string
  beforeVersion?: number
  afterVersion?: number
  nodeCount: number
  artifactRef?: string
  summary: Record<string, unknown>
  createdAt: string
}

export type ValidationAudit = AuditIdentity & {
  validationId: string
  validator: string
  status: 'passed' | 'failed' | 'unavailable'
  validatedVersion?: number
  repairRound?: number
  issueCount: number
  summary: Record<string, unknown>
  createdAt: string
}

export interface AiAuditWriter {
  startToolCall(record: ToolCallAuditStart): void
  finishToolCall(
    auditId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    completedAt: string,
    latencyMs: number,
    errorCode?: string,
    sceneId?: string,
  ): boolean
  recordSceneChange(record: SceneChangeAudit): void
  recordValidation(record: ValidationAudit): void
}

export class AiAuditRepository implements AiAuditWriter {
  private readonly startToolStatement
  private readonly finishToolStatement
  private readonly insertSceneChangeStatement
  private readonly insertValidationStatement
  private readonly toolsByRequestStatement
  private readonly changesByRequestStatement
  private readonly validationsByRequestStatement

  constructor(private readonly database: AppDatabase) {
    this.startToolStatement = database.connection.prepare(`
      INSERT INTO ai_tool_calls (
        audit_id, request_id, workflow_run_id, workflow_step_id,
        session_id, scene_id, operation_key, tool_name, mutating,
        status, args_summary_json, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `)
    this.finishToolStatement = database.connection.prepare(`
      UPDATE ai_tool_calls
      SET status = ?, error_code = ?, latency_ms = ?, completed_at = ?,
          scene_id = COALESCE(?, scene_id)
      WHERE audit_id = ? AND status = 'running'
    `)
    this.insertSceneChangeStatement = database.connection.prepare(`
      INSERT INTO ai_scene_changes (
        change_id, request_id, tool_call_audit_id, workflow_run_id,
        workflow_step_id, session_id, scene_id, change_type,
        before_version, after_version, node_count, artifact_ref, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertValidationStatement = database.connection.prepare(`
      INSERT INTO ai_validation_results (
        validation_id, request_id, workflow_run_id, workflow_step_id,
        session_id, scene_id, validator, status, validated_version,
        repair_round, issue_count, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.toolsByRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_tool_calls WHERE request_id = ? ORDER BY rowid
    `)
    this.changesByRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_scene_changes WHERE request_id = ? ORDER BY rowid
    `)
    this.validationsByRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_validation_results WHERE request_id = ? ORDER BY rowid
    `)
  }

  startToolCall(record: ToolCallAuditStart): void {
    this.startToolStatement.run(
      record.auditId,
      record.requestId,
      record.workflowRunId ?? null,
      record.workflowStepId ?? null,
      record.sessionId,
      record.sceneId ?? null,
      record.operationKey,
      record.toolName,
      record.mutating ? 1 : 0,
      JSON.stringify(record.argsSummary),
      record.startedAt,
    )
  }

  finishToolCall(
    auditId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    completedAt: string,
    latencyMs: number,
    errorCode?: string,
    sceneId?: string,
  ): boolean {
    return this.finishToolStatement.run(
      status,
      errorCode ?? null,
      Math.max(0, Math.round(latencyMs)),
      completedAt,
      sceneId ?? null,
      auditId,
    ).changes === 1
  }

  recordSceneChange(record: SceneChangeAudit): void {
    this.insertSceneChangeStatement.run(
      record.changeId,
      record.requestId,
      record.toolCallAuditId,
      record.workflowRunId ?? null,
      record.workflowStepId ?? null,
      record.sessionId,
      record.sceneId ?? null,
      record.changeType,
      record.beforeVersion ?? null,
      record.afterVersion ?? null,
      record.nodeCount,
      record.artifactRef ?? null,
      JSON.stringify(record.summary),
      record.createdAt,
    )
  }

  recordValidation(record: ValidationAudit): void {
    this.insertValidationStatement.run(
      record.validationId,
      record.requestId,
      record.workflowRunId ?? null,
      record.workflowStepId ?? null,
      record.sessionId,
      record.sceneId ?? null,
      record.validator,
      record.status,
      record.validatedVersion ?? null,
      record.repairRound ?? null,
      record.issueCount,
      JSON.stringify(record.summary),
      record.createdAt,
    )
  }

  findToolCallsByRequest(requestId: string): Array<Record<string, unknown>> {
    return this.toolsByRequestStatement.all(requestId) as Array<Record<string, unknown>>
  }

  findSceneChangesByRequest(requestId: string): Array<Record<string, unknown>> {
    return this.changesByRequestStatement.all(requestId) as Array<Record<string, unknown>>
  }

  findValidationsByRequest(requestId: string): Array<Record<string, unknown>> {
    return this.validationsByRequestStatement.all(requestId) as Array<Record<string, unknown>>
  }
}
