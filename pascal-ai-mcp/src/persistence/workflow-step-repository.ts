import type { AppDatabase } from './database'
import type {
  ModificationMode,
  ModificationModeReason,
} from '../domain/modification-mode'

export type WorkflowStepStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'failed_recoverable'

export type WorkflowStepRecord = {
  stepId: string
  requestId: string
  sessionId: string
  sceneId?: string
  operationKey: string
  attemptNo: number
  status: WorkflowStepStatus
  errorCode?: string
  startedAt: string
  completedAt?: string
  modificationMode?: ModificationMode
  modificationReasonCode?: ModificationModeReason
  modificationOperationTypes?: string[]
}

export interface WorkflowStepWriter {
  start(input: {
    requestId: string
    sessionId: string
    sceneId?: string
    operationKey: string
    startedAt: string
  }): WorkflowStepRecord
  finish(stepId: string, status: Exclude<WorkflowStepStatus, 'running'>, completedAt: string, errorCode?: string): boolean
  failRunningForRequest(requestId: string, completedAt: string, errorCode: string): number
  failOrphanedRunningSteps(completedAt: string): number
  findByRequestId?(requestId: string): WorkflowStepRecord[]
  recordModificationDecision?(
    stepId: string,
    decision: {
      mode: ModificationMode
      reasonCode: ModificationModeReason
      operationTypes: string[]
    },
  ): boolean
}

const WORKFLOW_OPERATION_KEYS = new Set([
  'route',
  'plan',
  'scaffold',
  'structure-openings',
  'furniture',
  'gates',
  'verification',
  'modify',
  'modify-plan',
])

export class WorkflowStepRepository implements WorkflowStepWriter {
  private readonly nextAttemptStatement
  private readonly insertStatement
  private readonly finishStatement
  private readonly failRunningStatement
  private readonly failOrphanedStatement
  private readonly byRequestStatement
  private readonly recordModificationDecisionStatement

  constructor(private readonly database: AppDatabase) {
    this.nextAttemptStatement = database.connection.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
      FROM workflow_steps WHERE request_id = ? AND operation_key = ?
    `)
    this.insertStatement = database.connection.prepare(`
      INSERT INTO workflow_steps (
        step_id, request_id, session_id, scene_id, operation_key,
        attempt_no, status, error_code, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)
    `)
    this.finishStatement = database.connection.prepare(`
      UPDATE workflow_steps
      SET status = ?, error_code = ?, completed_at = ?
      WHERE step_id = ? AND status = 'running'
    `)
    this.failRunningStatement = database.connection.prepare(`
      UPDATE workflow_steps
      SET status = 'failed_recoverable', error_code = ?, completed_at = ?
      WHERE request_id = ? AND status = 'running'
    `)
    this.failOrphanedStatement = database.connection.prepare(`
      UPDATE workflow_steps
      SET status = 'failed_recoverable',
          error_code = COALESCE((
            SELECT request.error_code FROM ai_requests AS request
            WHERE request.request_id = workflow_steps.request_id
          ), 'request_already_terminal'),
          completed_at = ?
      WHERE status = 'running'
        AND EXISTS (
          SELECT 1 FROM ai_requests AS request
          WHERE request.request_id = workflow_steps.request_id
            AND request.status IN ('succeeded', 'failed', 'cancelled')
        )
    `)
    this.byRequestStatement = database.connection.prepare(`
      SELECT * FROM workflow_steps
      WHERE request_id = ? ORDER BY started_at, operation_key, attempt_no
    `)
    this.recordModificationDecisionStatement = database.connection.prepare(`
      UPDATE workflow_steps
      SET modification_mode = ?,
          modification_reason_code = ?,
          modification_operations_json = ?
      WHERE step_id = ? AND status = 'running'
    `)
  }

  start(input: {
    requestId: string
    sessionId: string
    sceneId?: string
    operationKey: string
    startedAt: string
  }): WorkflowStepRecord {
    assertOperationKey(input.operationKey)
    return this.database.connection.transaction(() => {
      const attemptNo = (this.nextAttemptStatement.get(
        input.requestId,
        input.operationKey,
      ) as { attempt_no: number }).attempt_no
      const step: WorkflowStepRecord = {
        stepId: crypto.randomUUID(),
        requestId: input.requestId,
        sessionId: input.sessionId,
        ...(input.sceneId ? { sceneId: input.sceneId } : {}),
        operationKey: input.operationKey,
        attemptNo,
        status: 'running',
        startedAt: input.startedAt,
      }
      this.insertStatement.run(
        step.stepId,
        step.requestId,
        step.sessionId,
        step.sceneId ?? null,
        step.operationKey,
        step.attemptNo,
        step.startedAt,
      )
      return step
    }).immediate()
  }

  finish(
    stepId: string,
    status: Exclude<WorkflowStepStatus, 'running'>,
    completedAt: string,
    errorCode?: string,
  ): boolean {
    return this.finishStatement.run(status, errorCode ?? null, completedAt, stepId).changes === 1
  }

  failRunningForRequest(requestId: string, completedAt: string, errorCode: string): number {
    return this.failRunningStatement.run(errorCode, completedAt, requestId).changes
  }

  failOrphanedRunningSteps(completedAt: string): number {
    return this.failOrphanedStatement.run(completedAt).changes
  }

  findByRequestId(requestId: string): WorkflowStepRecord[] {
    return (this.byRequestStatement.all(requestId) as WorkflowStepRow[]).map(stepFromRow)
  }

  recordModificationDecision(
    stepId: string,
    decision: {
      mode: ModificationMode
      reasonCode: ModificationModeReason
      operationTypes: string[]
    },
  ): boolean {
    return this.recordModificationDecisionStatement.run(
      decision.mode,
      decision.reasonCode,
      JSON.stringify(decision.operationTypes),
      stepId,
    ).changes === 1
  }
}

type WorkflowStepRow = {
  step_id: string
  request_id: string
  session_id: string
  scene_id: string | null
  operation_key: string
  attempt_no: number
  status: WorkflowStepStatus
  error_code: string | null
  started_at: string
  completed_at: string | null
  modification_mode: ModificationMode | null
  modification_reason_code: ModificationModeReason | null
  modification_operations_json: string | null
}

function stepFromRow(row: WorkflowStepRow): WorkflowStepRecord {
  return {
    stepId: row.step_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    ...(row.scene_id ? { sceneId: row.scene_id } : {}),
    operationKey: row.operation_key,
    attemptNo: row.attempt_no,
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    startedAt: row.started_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.modification_mode ? { modificationMode: row.modification_mode } : {}),
    ...(row.modification_reason_code
      ? { modificationReasonCode: row.modification_reason_code }
      : {}),
    ...(row.modification_operations_json
      ? { modificationOperationTypes: JSON.parse(row.modification_operations_json) as string[] }
      : {}),
  }
}

function assertOperationKey(value: string): void {
  if (!WORKFLOW_OPERATION_KEYS.has(value) && !/^repair:[1-9][0-9]?$/.test(value)) {
    throw new Error(`invalid workflow operation key: ${value}`)
  }
}
