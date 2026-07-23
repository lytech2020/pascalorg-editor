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

export type GuardrailAudit = {
  eventId: string
  requestId: string
  workflowRunId?: string
  sessionId: string
  policyVersion: string
  decision: 'allow' | 'block' | 'defer'
  reasonCode: 'image_context' | 'architecture_context' | 'explicit_weather' | 'uncertain'
  inputKind: 'text' | 'image'
  latencyMs: number
  createdAt: string
}

export type TemplateMatchAudit = {
  decisionId: string
  requestId: string
  workflowRunId?: string
  sessionId: string
  mode: 'direct' | 'after_enrichment' | 'fallback'
  market: string
  roomProgram?: string
  targetAreaSqm?: number
  selectedTemplateId?: string
  candidates: Array<{
    templateId: string
    areaRatio: number
    relaxedTypology: boolean
  }>
  rejections: Array<{
    templateId: string
    reasonCodes: string[]
  }>
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
  recordGuardrail(record: GuardrailAudit): void
  recordTemplateMatch(record: TemplateMatchAudit): void
}

export class AiAuditRepository implements AiAuditWriter {
  private readonly startToolStatement
  private readonly finishToolStatement
  private readonly insertSceneChangeStatement
  private readonly insertValidationStatement
  private readonly toolsByRequestStatement
  private readonly changesByRequestStatement
  private readonly validationsByRequestStatement
  private readonly insertGuardrailStatement
  private readonly guardrailsByRequestStatement
  private readonly insertTemplateDecisionStatement
  private readonly insertTemplateCandidateStatement
  private readonly insertTemplateRejectionStatement
  private readonly templateDecisionsByRequestStatement

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
    this.insertGuardrailStatement = database.connection.prepare(`
      INSERT INTO ai_guardrail_events (
        event_id, request_id, workflow_run_id, session_id, policy_version,
        decision, reason_code, input_kind, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.guardrailsByRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_guardrail_events WHERE request_id = ? ORDER BY rowid
    `)
    this.insertTemplateDecisionStatement = database.connection.prepare(`
      INSERT INTO ai_template_decisions (
        decision_id, request_id, workflow_run_id, session_id, mode, market,
        room_program, target_area_sqm, area_band, selected_template_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this.insertTemplateCandidateStatement = database.connection.prepare(`
      INSERT INTO ai_template_candidates (
        decision_id, template_id, candidate_rank, area_ratio,
        relaxed_typology, selected
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    this.insertTemplateRejectionStatement = database.connection.prepare(`
      INSERT INTO ai_template_rejections (decision_id, template_id, reason_code)
      VALUES (?, ?, ?)
    `)
    this.templateDecisionsByRequestStatement = database.connection.prepare(`
      SELECT * FROM ai_template_decisions WHERE request_id = ? ORDER BY rowid
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

  recordGuardrail(record: GuardrailAudit): void {
    this.insertGuardrailStatement.run(
      record.eventId,
      record.requestId,
      record.workflowRunId ?? null,
      record.sessionId,
      record.policyVersion,
      record.decision,
      record.reasonCode,
      record.inputKind,
      Math.max(0, Math.round(record.latencyMs)),
      record.createdAt,
    )
  }

  recordTemplateMatch(record: TemplateMatchAudit): void {
    this.database.transaction(() => {
      this.insertTemplateDecisionStatement.run(
        record.decisionId,
        record.requestId,
        record.workflowRunId ?? null,
        record.sessionId,
        record.mode,
        record.market,
        record.roomProgram ?? null,
        record.targetAreaSqm ?? null,
        templateAreaBand(record.targetAreaSqm),
        record.selectedTemplateId ?? null,
        record.createdAt,
      )
      for (let index = 0; index < record.candidates.length; index++) {
        const candidate = record.candidates[index]!
        this.insertTemplateCandidateStatement.run(
          record.decisionId,
          candidate.templateId,
          index,
          candidate.areaRatio,
          candidate.relaxedTypology ? 1 : 0,
          candidate.templateId === record.selectedTemplateId ? 1 : 0,
        )
      }
      for (const rejection of record.rejections) {
        for (const reasonCode of rejection.reasonCodes) {
          this.insertTemplateRejectionStatement.run(
            record.decisionId,
            rejection.templateId,
            reasonCode,
          )
        }
      }
    })
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

  findGuardrailsByRequest(requestId: string): Array<Record<string, unknown>> {
    return this.guardrailsByRequestStatement.all(requestId) as Array<Record<string, unknown>>
  }

  findTemplateDecisionsByRequest(requestId: string): Array<Record<string, unknown>> {
    return this.templateDecisionsByRequestStatement.all(requestId) as Array<Record<string, unknown>>
  }
}

function templateAreaBand(area: number | undefined): string {
  if (area === undefined) return 'unknown'
  if (area < 30) return 'under_30'
  if (area < 50) return '30_49'
  if (area < 70) return '50_69'
  return '70_plus'
}
