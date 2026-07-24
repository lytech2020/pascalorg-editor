import type { GateFailure, GateReport, GateWall } from './completion-gates'
import type { AppConfig } from './config'
import { detectLanguage, issueText, t, type Lang } from './lang/i18n'
import { classifySceneIntentFallback, isSceneQuestion, type SceneIntent } from './lang/intent-vocab'
import { detectKitchenPreference, detectSiteHint, parseRoomProgram } from './lang/strategy-vocab'
import { resolveNormProfile } from './norms/profile'
import { deriveBriefFacts, deriveStrategy, type BriefFacts, type StrategyDecision } from './strategy'
import {
  classifyRoomTypeByName,
  ROOM_NAME_PATTERNS,
  roomNamePattern,
  WINDOW_PATTERN,
} from './lang/room-vocab'
import {
  doorClearanceDepths,
  executeFurniturePlan,
  type FurnitureRoom,
} from './furniture-executor'
import {
  executeFurnitureModifyOps,
  isChecklistItem,
  previewRoomFurnitureClear,
  replayManualItems,
  skippedFurnitureResults,
  type FurnitureModifyReport,
  type ManualItem,
} from './furniture-modify'
import { partitionLayout } from './layout-partitioner'
import {
  applyModifyOps,
  parseModifyOps,
  resolveRoomRef,
  type FurnitureModifyOp,
  type ModifyPlan,
  type SkippedFurnitureOp,
  type StructuralModifyOp,
} from './modify-ops'
import { computeLayoutQuality } from './layout-metrics'
import { footprintArea, kitchenIsCirculation } from './layout-plan'
import type { IssueL10n, LayoutIntent, LayoutIntentRoom, LayoutPlan, RoomType } from './layout-plan'
import {
  applyLocalStructuralEdits,
  type LocalEditReasonCode,
  type StructuralOpBinding,
} from './domain/local-structural-edit'
import {
  validateModifiedLayoutPlan,
  type ModifyValidationResult,
} from './domain/local-structural-validation'
import { buildLayoutPlan, type PlanBuildResult } from './plan-builder'
import type { PlanTargets, PlanValidation } from './plan-validator'
import { combineWriteEffects, executeLayoutPlan, toolPayload, type McpCaller, type SceneExecutionReport, type WriteEffectState } from './scene-executor'
import { classifyScopeRequest, SCOPE_POLICY_VERSION } from './domain/guardrail/scope-policy'
import { directTemplateEligibility } from './domain/policy/direct-template-policy'
import type { ValidationStage } from './domain/validation-registry'
import {
  classifyModificationMode,
  confirmedModificationMatches,
  needsModificationConfirmation,
  planRequiresBatchConfirmation,
  type ModificationModeDecision,
} from './domain/modification-mode'
import {
  validateLocalPatchScope,
  type LocalPatchAllowance,
  type LocalPatchScopeFinding,
} from './domain/local-patch-scope'
import {
  normalizeSemanticRemovalPlan,
  removalRoomIdsForRef,
  validateExecutedPlan,
  validatePreservedPlan,
  withPreservationPolicy,
  type PreservationFinding,
} from './domain/modification-preservation'
import {
  isStructuralPostconditionCode,
  validateModificationPostconditions,
  type ModificationPostconditionFinding,
} from './domain/modification-postconditions'
import {
  findDoorlessRooms,
  findIsolatedBedrooms,
  findStrayWindows,
  type WallWithOpenings,
  type ZoneSummary,
} from './domain/circulation'
import {
  checkAreaRequirements,
  computeZoneAreaStats,
  FLOOR_AREA_FACT_KEYS,
  numericFactValue,
  pointInPolygon,
  polygonArea,
  round1,
  type MismatchFinding,
} from './domain/area-validation'
import {
  collinearOverlap,
  MIN_MEANINGFUL_OVERLAP_M,
  orientationToSegment,
  segmentOrientation,
} from './domain/geometry/wall-segments'
import type { SceneSpaceStore } from './ports/scene-space-store'
import type { SceneGateway } from './ports/scene-gateway'
import type { ModelClient, ModelClients, RequestHooks } from './ports/model-client'
import { planIngestAction } from './application/ingest-service'
import { SceneSpaceService } from './application/scene-space-service'
import { inspectExistingScene, planExistingSceneRequest } from './application/existing-scene-service'
import {
  canonicalModifyPlanHash,
  resolveModifyPlanForExecution,
} from './application/modification-plan-service'
import {
  effectiveGateFailures,
  modifyFailureRecovery,
  runModifyWorkflow,
  type IntentRemoval,
} from './application/modify-service'
import {
  buildCompletionReply,
  countAllIssues,
  countDiagnosticIssues,
  describeRemainingIssues,
  finishSceneWorkflow,
  publicEditorUrl,
  runGenerateWorkflow,
} from './application/generate-service'
import {
  createValidationRegistry,
  readMcpValidationSources,
  recordDirectValidationResults,
  VALIDATOR_IDS,
  validationUnavailableReason,
  validationValue,
  type ValidationContext,
} from './application/validation-service'
import {
  renderPrompt,
  type PromptAuditMetadata,
  type RenderedPrompt,
} from './prompts/registry'

// Re-exported for eval/run-eval.ts, which historically imported it from here.
export { toolPayload }
export { publicEditorUrl }
export { findIsolatedBedrooms }
export { checkAreaRequirements, computeZoneAreaStats }
export type { WallWithOpenings, ZoneSummary }
import { createRequestContext, type RequestContext } from './request-context'
import type {
  ChatRequestWriter,
  ChatRequestRecord,
  SessionPersistence,
} from './persistence/session-repository'
import { SessionVersionConflictError } from './persistence/session-repository'
import type { WorkflowStepWriter } from './persistence/workflow-step-repository'
import type { WorkflowStepRecord } from './persistence/workflow-step-repository'
import type { SceneBoundary, SceneBuildWriter } from './persistence/scene-build-repository'
import type { AiAuditWriter, AuditIdentity } from './persistence/audit-repository'
import { CheckpointGraphVersionMismatchError } from './persistence/sqlite-checkpoint-saver'
import type { ModelAttemptSink } from './telemetry/model-attempt-recorder'
import { AiOperationAuditor } from './telemetry/ai-operation-audit'
import type {
  Availability,
  ChatInput,
  ChatMessage,
  ChatResult,
  ConfirmationStatus,
  DesignBrief,
  FurniturePlacementIssue,
  InformationSource,
  PhaseToolTrace,
  RequirementFact,
  ToolCall,
  WorkflowSession,
} from './types'
import {
  type DurableWorkflowGraphState,
  type WorkflowGraphState,
} from './workflow-state'
import { WORKFLOW_GRAPH_VERSION } from './workflow-identity'
import type {
  WorkflowCheckpointStore,
  WorkflowRuntime,
  WorkflowRuntimeFactory,
} from './ports/workflow-runtime'

const EMPTY_BRIEF: DesignBrief = {
  existingCondition: [],
  designGoals: [],
  hardConstraints: [],
  assumptions: [],
  uncertainties: [],
  conflicts: [],
}

const SOURCE_VALUES = new Set<InformationSource>([
  'user',
  'system_recognition',
  'agent_inference',
  'default_assumption',
  'pending_confirmation',
])

const CONFIRMATION_VALUES = new Set<ConfirmationStatus>([
  'unconfirmed',
  'confirmed',
  'rejected',
])

// Structural scaffolding node types created automatically for every project.
// They exist even in a brand-new empty scene, so they must NOT count as
// "user content" when deciding whether a scene is safe to rebuild from
// scratch (see `countActiveContentNodes` / `shouldModifyExistingScene`).
const SCAFFOLDING_NODE_TYPES = new Set(['project', 'site', 'building', 'level', 'story', 'storey'])

// Thrown at a loop boundary inside a long-running generation/modification
// when the user has asked to cancel, so the in-flight work unwinds promptly
// instead of finishing a run the user no longer wants.
class GenerationCancelledError extends Error {
  constructor() {
    super('用户已取消本次生成')
    this.name = 'GenerationCancelledError'
  }
}

// Thrown when a single chat turn exceeds its model-call budget — an absolute
// safety ceiling against runaway cost/latency (normal jobs never hit it).
class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`Model call count exceeded the safety limit (${limit}) for this task; stopped automatically to avoid waste`)
    this.name = 'BudgetExceededError'
  }
}

export class WorkflowResumeBoundaryError extends Error {
  constructor(readonly code: string) {
    super(`workflow cannot resume safely: ${code}`)
    this.name = 'WorkflowResumeBoundaryError'
  }
}

class DestructiveSceneWriteError extends Error {
  constructor(readonly sceneId: string, cause: unknown) {
    super(`Destructive rebuild of scene ${sceneId} failed after writes began: ${errorMessage(cause)}`)
    this.name = 'DestructiveSceneWriteError'
    this.cause = cause
  }
}

class LocalPatchScopeViolationError extends Error {
  constructor(readonly findings: LocalPatchScopeFinding[]) {
    super(`local patch changed nodes outside its allowed scope (${findings.length})`)
    this.name = 'LocalPatchScopeViolationError'
  }
}

class ModificationVerificationError extends Error {
  constructor(readonly codes: string[]) {
    super(`modification verification failed (${codes.join(',')})`)
    this.name = 'ModificationVerificationError'
  }
}

type ExtractionResponse = {
  existingCondition?: unknown[]
  designGoals?: unknown[]
  hardConstraints?: unknown[]
  assumptions?: unknown[]
  uncertainties?: unknown[]
  conflicts?: unknown[]
  questions?: unknown[]
  overallConfidence?: unknown
  imageUsable?: unknown
  imageReason?: unknown
  relevant?: unknown
}

type Evaluation = {
  availability: Availability
  reasons: string[]
  questions: string[]
}

export { classifySceneIntentFallback, isSceneQuestion, type SceneIntent } from './lang/intent-vocab'

// Best-effort delete of every child of `levelId`, then a leftover re-check —
// clearing must be IDEMPOTENT: the children snapshot is taken once, but wall
// dedupe or an earlier sibling's cascade may have already removed ids still
// on the list (2026-07-16 线上事故：重规划第二次清场因重复删除旧 wall id
// 整轮失败). Only nodes that survive the re-check are an error. Exported for
// tests; PascalAiAgent.clearLevelForRebuild delegates here.
export async function clearLevelChildren(
  callMcp: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  levelId: string,
): Promise<void> {
  const scene = toolPayload(await callMcp('get_scene', {}))
  const nodes = isRecord(scene.nodes) ? scene.nodes : {}
  const level = nodes[levelId]
  if (!isRecord(level) || !Array.isArray(level.children)) {
    throw new Error(`Target level ${levelId} is unavailable`)
  }
  // 只有「Node not found」是预期内的幂等噪音（id 已被前一个 cascade 或墙体
  // 去重删掉）；权限/参数/连接类异常原样留存，按 leftover 复查裁决——节点
  // 确实消失了才作罢，还在场就带着原始错误一起抛。
  const unexpectedErrors = new Map<string, unknown>()
  for (const childId of level.children) {
    if (typeof childId !== 'string') continue
    try {
      await callMcp('delete_node', { id: childId, cascade: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/node not found/i.test(message)) unexpectedErrors.set(childId, error)
    }
  }
  const after = toolPayload(await callMcp('get_scene', {}))
  const afterNodes = isRecord(after.nodes) ? after.nodes : {}
  const afterLevel = afterNodes[levelId]
  const leftover = isRecord(afterLevel) && Array.isArray(afterLevel.children)
    ? afterLevel.children.filter((id): id is string => typeof id === 'string' && isRecord(afterNodes[id]))
    : []
  if (leftover.length > 0) {
    const causes = leftover
      .map(id => unexpectedErrors.get(id))
      .filter((error): error is Error => error instanceof Error)
      .map(error => error.message)
    throw new Error(
      `清空层级失败：${leftover.length} 个节点未能删除（如 ${String(leftover[0])}）`
      + (causes.length > 0 ? `，原始错误：${causes[0]}` : ''),
    )
  }
}

export class PascalAiAgent {
  private readonly model?: ModelClient
  private readonly fallbackModel?: ModelClient
  private readonly fastModel?: ModelClient
  private readonly workflow: WorkflowRuntime
  private readonly toolAuditor: AiOperationAuditor
  private readonly spaceService: SceneSpaceService
  private readonly validationRegistry = createValidationRegistry()
  private readonly sessionLocks = new Map<string, Promise<ChatResult>>()
  private readonly sessionVersions = new Map<string, number>()
  // Sessions with a cancel requested while a run is in flight. The running
  // generation polls this at loop boundaries (`throwIfCancelled`) and aborts.
  private readonly cancelRequests = new Set<string>()
  // Abort controller for the in-flight turn of each session, so a cancel can
  // interrupt the request that's actually running (model fetch or MCP call)
  // immediately, instead of only at the next loop boundary.
  private readonly runAbortControllers = new Map<string, AbortController>()
  // Request identity of the run currently holding each session's lock —
  // read at telemetry time so attempt logs (and the T1.2 sink) carry the
  // authoritative requestId/traceId (T1.3).
  private readonly activeRequestContexts = new Map<string, RequestContext>()
  private readonly activeWorkflowSteps = new Map<string, WorkflowStepRecord>()
  // Per-turn model-call counter, keyed by sessionId for the duration of a
  // single `runChat`. Absent when no turn is running for that session.
  private readonly modelCallBudgets = new Map<string, number>()
  // The session's cumulative model-call total *before* the current turn, so
  // `chargeModelCall` can enforce the per-session ceiling in real time within
  // the turn rather than only at the next turn's boundary.
  private readonly sessionPriorTotals = new Map<string, number>()
  private readonly destructiveWrites = new Set<string>()
  private readonly activeTurnInputs = new Map<string, ChatInput>()
  // Lazily-fetched, process-lifetime cache of the MCP `pascal://agent-guide`
  // resource. Read once; failures are swallowed so a missing/renamed
  // resource never breaks the main generation flow.
  private agentGuidePromise?: Promise<string | undefined>

  constructor(
    private readonly config: AppConfig,
    private readonly mcp: SceneGateway,
    private readonly modelAttempts: ModelAttemptSink,
    private readonly sessions: SessionPersistence,
    private readonly requests: ChatRequestWriter,
    private readonly workflowSteps: WorkflowStepWriter | undefined,
    private readonly sceneBuilds: SceneBuildWriter,
    private readonly checkpointSaver: WorkflowCheckpointStore,
    private readonly audits: AiAuditWriter,
    sceneSpaces: SceneSpaceStore,
    workflowRuntimeFactory: WorkflowRuntimeFactory,
    modelClients: ModelClients,
  ) {
    this.toolAuditor = new AiOperationAuditor(audits)
    this.spaceService = new SceneSpaceService(sceneSpaces)
    this.model = modelClients.main
    this.fallbackModel = modelClients.fallback
    this.fastModel = modelClients.fast
    // A live worker lease proves another process still owns an in-flight
    // session. Only unleased state is stale enough to recover; CAS remains the
    // final guard if two processes race after a lease expires.
    for (const stored of this.sessions.all()) {
      if (this.requests.hasLiveWorkerRequest?.(stored.session.sessionId)) continue
      this.sessionVersions.set(stored.session.sessionId, stored.version)
      try {
        this.recoverIfStale(stored.session)
      } catch (error) {
        if (!(error instanceof SessionVersionConflictError)) throw error
        console.warn(`session recovery skipped after concurrent update: ${stored.session.sessionId}`)
      } finally {
        this.sessionVersions.delete(stored.session.sessionId)
      }
    }
    this.workflow = workflowRuntimeFactory({
      route: state => this.routeDurableWorkflow(state),
      legacy: state => this.runLegacyWorkflowNode(state),
      plan: state => this.runPlanWorkflowNode(state),
      construct: state => this.runConstructWorkflowNode(state),
    })
  }

  async chat(input: ChatInput): Promise<ChatResult> {
    const contextualInput = input.context
      ? input
      : { ...input, context: createRequestContext(new Headers()) }
    const context = contextualInput.context!
    context.workflowRunId = this.requests.start({
      requestId: context.requestId,
      traceId: context.traceId,
      ...(context.clientRequestId ? { clientRequestId: context.clientRequestId } : {}),
      sessionId: contextualInput.sessionId,
      kind: contextualInput.action === 'confirm'
        ? 'confirm'
        : contextualInput.action === 'cancel' ? 'cancel' : 'chat',
      ...(contextualInput.sceneId ? { sceneId: contextualInput.sceneId } : {}),
      startedAt: new Date().toISOString(),
    })
    context.graphVersion = WORKFLOW_GRAPH_VERSION
    try {
      const result = await this.executeQueued(contextualInput)
      // A handled cancellation is a successfully processed cancel action;
      // the cancelled model attempts/session phase retain the detail.
      this.finishRequest(context, 'succeeded')
      return result
    } catch (error) {
      this.finishRequest(context, 'failed', 'internal_error')
      throw error
    }
  }

  async executeQueued(input: ChatInput): Promise<ChatResult> {
    if (!input.context) throw new Error('queued chat input requires request context')
    // A cancel that arrives while a run is already in flight signals that run
    // to abort at its next loop boundary. Setting the flag here (before the
    // turn is even enqueued behind the lock) is what makes cancellation take
    // effect *during* generation instead of only after it finishes.
    if (input.action === 'cancel' && this.sessionLocks.has(input.sessionId)) {
      this.cancelRequests.add(input.sessionId)
      // Abort the request that's running right now (model fetch / MCP call)
      // so cancellation is immediate rather than waiting for it to return.
      this.runAbortControllers.get(input.sessionId)?.abort()
    }
    const previous = this.sessionLocks.get(input.sessionId) ?? Promise.resolve(undefined)
    const current = previous
      .catch(() => undefined)
      .then(() => this.runChat(input))
    this.sessionLocks.set(input.sessionId, current)
    try {
      return await current
    } finally {
      if (this.sessionLocks.get(input.sessionId) === current) {
        this.sessionLocks.delete(input.sessionId)
      }
    }
  }

  requestCancellation(sessionId: string): void {
    if (!this.sessionLocks.has(sessionId)) return
    this.cancelRequests.add(sessionId)
    this.runAbortControllers.get(sessionId)?.abort()
  }

  async expiredRequestRecovery(
    request: ChatRequestRecord,
  ): Promise<'resume' | 'complete' | 'fail_recoverable'> {
    if (!request.workflowRunId || request.graphVersion !== WORKFLOW_GRAPH_VERSION) {
      return 'fail_recoverable'
    }
    try {
      const snapshot = await this.workflow.snapshot(request.workflowRunId)
      const stored = this.sessions.load(request.sessionId)
      if (
        snapshot
        && snapshot.values.requestId === request.requestId
        && stored
        && stored.version > snapshot.values.sessionVersion
        && isTerminalWorkflowPhase(stored.session.phase)
      ) {
        const runningStep = this.workflowSteps?.findByRequestId?.(request.requestId)
          .some(step => step.status === 'running') ?? false
        if (!runningStep) return 'complete'
      }
      if (
        !snapshot
        || snapshot.interrupted
        || snapshot.next.length !== 1
        || snapshot.next[0] !== 'construct'
        || snapshot.values.requestId !== request.requestId
        || snapshot.values.sessionId !== request.sessionId
      ) {
        return 'fail_recoverable'
      }
      const steps = this.workflowSteps?.findByRequestId?.(request.requestId) ?? []
      const planCompleted = steps.some(step =>
        step.operationKey === 'plan' && step.status === 'succeeded')
      const unsafeProgress = steps.some(step =>
        step.operationKey !== 'route' && step.operationKey !== 'plan')
      const sceneBuildStarted = this.sceneBuilds.findByRequestId?.(request.requestId) !== undefined
      return planCompleted && !unsafeProgress && !sceneBuildStarted
        ? 'resume'
        : 'fail_recoverable'
    } catch {
      return 'fail_recoverable'
    }
  }

  getSession(sessionId: string): WorkflowSession | undefined {
    const stored = this.sessions.load(sessionId)
    if (!stored) return undefined
    const session = stored.session
    // A live run holds the session lock; an in-flight phase WITHOUT a lock is
    // a stuck leftover (restart / escaped exception) — downgrade before the
    // frontend renders a forever-spinning state.
    if (this.sessionLocks.has(sessionId)) return session
    if (this.requests.hasLiveWorkerRequest?.(sessionId)) return session
    this.sessionVersions.set(sessionId, stored.version)
    try {
      return this.recoverIfStale(session)
    } catch (error) {
      if (!(error instanceof SessionVersionConflictError)) throw error
      console.warn(`session read recovery skipped after concurrent update: ${sessionId}`)
      return this.sessions.load(sessionId)?.session ?? session
    } finally {
      this.sessionVersions.delete(sessionId)
    }
  }

  // Applies staleSessionRecovery, appends the explanation to the transcript
  // and persists — idempotent (recovered sessions are no longer in-flight).
  private recoverIfStale(session: WorkflowSession): WorkflowSession {
    const recovery = staleSessionRecovery(session)
    if (!recovery) return session
    const updated = structuredClone(session)
    updated.phase = recovery.phase
    if (recovery.template === 'staleDestructive') {
      delete updated.pendingModification
      delete updated.pendingOperation
      delete updated.pendingModificationMode
      delete updated.pendingModificationReasonCode
      delete updated.pendingModificationPlanHash
      delete updated.pendingModifyPlan
      delete updated.modifyModeConfirmed
      delete updated.destructiveSceneWriteStarted
    }
    const reply = t(updated.language, recovery.template, {})
    updated.messages.push({ role: 'assistant', content: reply })
    this.persistSession(updated)
    return updated
  }

  deleteSession(sessionId: string): boolean {
    if (this.sessionLocks.has(sessionId)) return false
    return this.sessions.delete(sessionId)
  }

  private persistSession(session: WorkflowSession): void {
    const expectedVersion = this.sessionVersions.get(session.sessionId)
    if (expectedVersion === undefined) {
      throw new Error(`session ${session.sessionId} has no loaded persistence version`)
    }
    const version = this.sessions.save(session, expectedVersion)
    this.sessionVersions.set(session.sessionId, version)
  }

  private finishRequest(
    context: RequestContext,
    status: 'succeeded' | 'failed',
    errorCode?: string,
  ): void {
    try {
      this.requests.finish(context.requestId, status, new Date().toISOString(), errorCode)
    } catch (error) {
      console.error(
        `[req ${context.requestId}] [trace ${context.traceId}] request-audit finish failed: ${errorMessage(error)}`,
      )
    }
  }

  private async runWorkflowStep<T>(
    session: WorkflowSession,
    operationKey: string,
    work: () => Promise<T>,
    accepts: (result: T) => boolean = () => true,
    rejectedErrorCode = 'step_rejected',
  ): Promise<T> {
    const context = this.activeRequestContexts.get(session.sessionId)
    if (!context || !this.workflowSteps) return work()
    const step = this.workflowSteps.start({
      requestId: context.requestId,
      sessionId: session.sessionId,
      ...(session.sceneId ? { sceneId: session.sceneId } : {}),
      operationKey,
      startedAt: new Date().toISOString(),
    })
    const previousStep = this.activeWorkflowSteps.get(session.sessionId)
    this.activeWorkflowSteps.set(session.sessionId, step)
    try {
      const result = await work()
      const accepted = accepts(result)
      try {
        if (!this.workflowSteps.finish(
          step.stepId,
          accepted ? 'succeeded' : 'failed',
          new Date().toISOString(),
          accepted ? undefined : rejectedErrorCode,
        )) {
          console.warn(`[req ${context.requestId}] workflow step ${operationKey} lost before completion`)
        }
      } catch (error) {
        console.error(`[req ${context.requestId}] workflow step ${operationKey} finish failed: ${errorMessage(error)}`)
      }
      return result
    } catch (error) {
      const cancelled = error instanceof GenerationCancelledError
      try {
        if (!this.workflowSteps.finish(
          step.stepId,
          cancelled ? 'cancelled' : 'failed',
          new Date().toISOString(),
          cancelled ? 'cancelled_by_user' : 'step_failed',
        )) {
          console.warn(`[req ${context.requestId}] workflow step ${operationKey} lost before failure recording`)
        }
      } catch (finishError) {
        console.error(
          `[req ${context.requestId}] workflow step ${operationKey} failure recording failed: ${errorMessage(finishError)}`,
        )
      }
      throw error
    } finally {
      if (this.activeWorkflowSteps.get(session.sessionId) === step) {
        if (previousStep) this.activeWorkflowSteps.set(session.sessionId, previousStep)
        else this.activeWorkflowSteps.delete(session.sessionId)
      }
    }
  }

  private recordModificationDecision(
    sessionId: string,
    decision: ModificationModeDecision,
  ): void {
    const step = this.activeWorkflowSteps.get(sessionId)
    if (!step || !this.workflowSteps?.recordModificationDecision) return
    if (!this.workflowSteps.recordModificationDecision(step.stepId, decision)) {
      throw new Error(`workflow step ${step.stepId} cannot record modification mode`)
    }
  }

  private async verifyLocalPatchScope(
    session: WorkflowSession,
    before: SceneNodeSnapshot,
    allowances: LocalPatchAllowance[],
  ): Promise<void> {
    let after: SceneNodeSnapshot
    try {
      after = snapshotSceneNodes(
        toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})),
      )
    } catch (error) {
      await this.runValidationStage(session, 'modify', {
        unavailable: {
          validatorId: VALIDATOR_IDS.localPatchScope,
          reason: validationUnavailableReason(error),
        },
      })
      throw error
    }
    const findings = validateLocalPatchScope(before, after, allowances)
    const results = await this.runValidationStage(session, 'modify', {
      localPatchScope: { findings },
    })
    const recorded = validationValue<LocalPatchScopeFinding[]>(
      results,
      VALIDATOR_IDS.localPatchScope,
    )
    if (recorded.length > 0) throw new LocalPatchScopeViolationError(recorded)
  }

  private async recordPreservationFindings(
    session: WorkflowSession,
    findings: PreservationFinding[],
  ): Promise<PreservationFinding[]> {
    const results = await this.runValidationStage(session, 'modify', {
      modificationPreservation: { findings },
    })
    return validationValue<PreservationFinding[]>(
      results,
      VALIDATOR_IDS.modificationPreservation,
    )
  }

  // P1: an uncertain write (result unknown, or a confirmed+unknown partial)
  // must never continue to a normal, scene-saving completion. Throwing here
  // hands the turn to the modify-service catch, which reads the persisted
  // side-effect state and produces the result-unknown / destructive reply
  // without saving the scene or allowing an auto-replay.
  private throwIfWriteUncertain(writeEffect: WriteEffectState, issues: readonly string[]): void {
    if (writeEffect === 'write_attempted' || writeEffect === 'partial_write_confirmed') {
      throw new Error(issues.length > 0 ? issues.join('；') : '本次修改的写入结果无法确认')
    }
  }

  private async verifyModificationPostconditions(
    session: WorkflowSession,
    findings: ModificationPostconditionFinding[],
  ): Promise<void> {
    const results = await this.runValidationStage(session, 'modify', {
      modificationPostconditions: { findings },
    })
    const recorded = validationValue<ModificationPostconditionFinding[]>(
      results,
      VALIDATOR_IDS.modificationPostconditions,
    )
    // R1.4 / P1-2: only STRUCTURAL findings are scene-integrity failures worth
    // throwing (and thereby routing to the destructive-write reply). Furniture
    // findings are already surfaced as per-op failed details by
    // finishPlanFirstModify, so a zero-write furniture miss no longer masquer-
    // ades as a partial structural rebuild.
    const structural = recorded.filter(finding => isStructuralPostconditionCode(finding.code))
    if (structural.length > 0) {
      throw new ModificationVerificationError(structural.map(finding => finding.code))
    }
  }

  private async runChat(input: ChatInput): Promise<ChatResult> {
    if (input.context) this.activeRequestContexts.set(input.sessionId, input.context)
    if (input.context) this.activeTurnInputs.set(input.context.requestId, input)
    try {
      return await this.runChatInner(input)
    } finally {
      if (this.activeRequestContexts.get(input.sessionId) === input.context) {
        this.activeRequestContexts.delete(input.sessionId)
      }
      if (input.context && this.activeTurnInputs.get(input.context.requestId) === input) {
        this.activeTurnInputs.delete(input.context.requestId)
      }
    }
  }

  private async runChatInner(input: ChatInput): Promise<ChatResult> {
    try {
      return await this.runChatTurn(input)
    } finally {
      this.sessionVersions.delete(input.sessionId)
    }
  }

  private async runChatTurn(input: ChatInput): Promise<ChatResult> {
    const context = input.context
    if (!context?.workflowRunId || context.graphVersion !== WORKFLOW_GRAPH_VERSION) {
      throw new Error('durable workflow identity is missing or incompatible')
    }
    const now = new Date().toISOString()
    const stored = this.sessions.load(input.sessionId)
    this.sessionVersions.set(input.sessionId, stored?.version ?? 0)
    let snapshot
    try {
      snapshot = await this.workflow.snapshot(context.workflowRunId)
    } catch (error) {
      if (error instanceof CheckpointGraphVersionMismatchError) {
        throw new WorkflowResumeBoundaryError('workflow_graph_version_mismatch')
      }
      throw error
    }
    let session = stored?.session ?? createSession(input, now)
    const resumingPreparedPlan = snapshot?.next.length === 1
      && snapshot.next[0] === 'construct'
      && snapshot.values.requestId === context.requestId
    if (!resumingPreparedPlan) session = this.recoverIfStale(session)
    if (input.sceneId) session.sceneId = input.sceneId

    // Per-session cumulative cost ceiling. Cancel is always allowed through so
    // a user can still stop a session that has hit the limit.
    const priorTotal = session.modelCallsTotal ?? 0
    if (input.action !== 'cancel' && priorTotal >= this.config.maxModelCallsPerSession) {
      const reply = t(session.language, 'sessionCallLimit', {})
      session.updatedAt = new Date().toISOString()
      this.persistSession(session)
      return { sessionId: input.sessionId, reply, session }
    }

    this.modelCallBudgets.set(input.sessionId, 0)
    this.sessionPriorTotals.set(input.sessionId, priorTotal)
    this.runAbortControllers.set(input.sessionId, new AbortController())
    try {
      if (input.action === 'cancel' && snapshot && !snapshot.interrupted) {
        const result = await this.runLegacyTurnAndPersist(input, session)
        await this.checkpointSaver.deleteThread(context.workflowRunId)
        return result
      }
      if (snapshot) {
        if (snapshot.values.sessionId !== input.sessionId) {
          throw new WorkflowResumeBoundaryError('workflow_session_mismatch')
        }
        if (snapshot.values.sessionVersion !== (stored?.version ?? 0)) {
          throw new WorkflowResumeBoundaryError('workflow_session_version_mismatch')
        }
        if (snapshot.interrupted && snapshot.next.includes('wait')) {
          await this.workflow.resume(context.workflowRunId, context.requestId)
        } else if (
          snapshot.next.length === 1
          && snapshot.next[0] === 'construct'
          && snapshot.values.requestId === context.requestId
        ) {
          await this.workflow.retryPending(context.workflowRunId)
        } else {
          throw new WorkflowResumeBoundaryError('workflow_not_resumable')
        }
      } else {
        if (
          input.action === 'confirm'
          || session.phase === 'clarifying'
          || session.phase === 'awaiting_confirmation'
          || session.phase === 'awaiting_modification_confirmation'
        ) {
          throw new WorkflowResumeBoundaryError('workflow_checkpoint_unavailable')
        }
        await this.workflow.start({
          sessionId: input.sessionId,
          sessionVersion: stored?.version ?? 0,
          requestId: context.requestId,
          phase: session.phase,
          next: 'legacy',
        }, context.workflowRunId)
      }
      const completed = this.sessions.load(input.sessionId)
      if (!completed) throw new Error(`session ${input.sessionId} was not persisted`)
      this.sessionVersions.set(input.sessionId, completed.version)
      return {
        sessionId: input.sessionId,
        reply: latestAssistantReply(completed.session),
        session: completed.session,
      }
    } finally {
      this.modelCallBudgets.delete(input.sessionId)
      this.sessionPriorTotals.delete(input.sessionId)
      this.runAbortControllers.delete(input.sessionId)
      this.cancelRequests.delete(input.sessionId)
    }
  }

  private async routeDurableWorkflow(
    state: DurableWorkflowGraphState,
  ): Promise<Partial<DurableWorkflowGraphState>> {
    const input = this.activeTurnInputs.get(state.requestId)
    if (!input || input.sessionId !== state.sessionId) {
      throw new WorkflowResumeBoundaryError('workflow_request_input_unavailable')
    }
    const stored = this.sessions.load(state.sessionId)
    if ((stored?.version ?? 0) !== state.sessionVersion) {
      throw new WorkflowResumeBoundaryError('workflow_session_version_mismatch')
    }
    const canPrepareFreshPlan = input.action === 'confirm'
      && (stored?.session.phase === 'clarifying'
        || stored?.session.phase === 'awaiting_confirmation')
      && !stored.session.sceneId
    const next = canPrepareFreshPlan ? 'plan' as const : 'legacy' as const
    const context = input.context
    if (!context || !this.workflowSteps) {
      return { phase: stored?.session.phase ?? state.phase, next }
    }
    const step = this.workflowSteps.start({
      requestId: context.requestId,
      sessionId: state.sessionId,
      ...(stored?.session.sceneId ? { sceneId: stored.session.sceneId } : {}),
      operationKey: 'route',
      startedAt: new Date().toISOString(),
    })
    try {
      this.workflowSteps.finish(step.stepId, 'succeeded', new Date().toISOString())
    } catch (error) {
      console.error(`[req ${context.requestId}] workflow route finish failed: ${errorMessage(error)}`)
    }
    return { phase: stored?.session.phase ?? state.phase, next }
  }

  private async runLegacyWorkflowNode(
    state: DurableWorkflowGraphState,
  ): Promise<Partial<DurableWorkflowGraphState>> {
    const input = this.workflowInput(state)
    const stored = this.sessions.load(state.sessionId)
    if ((stored?.version ?? 0) !== state.sessionVersion) {
      throw new WorkflowResumeBoundaryError('workflow_session_version_mismatch')
    }
    const session = stored?.session ?? createSession(input, new Date().toISOString())
    const result = await this.runLegacyTurnAndPersist(input, session)
    return {
      sessionVersion: this.loadedSessionVersion(state.sessionId),
      phase: result.session.phase,
      next: 'finish',
    }
  }

  private async runPlanWorkflowNode(
    state: DurableWorkflowGraphState,
  ): Promise<Partial<DurableWorkflowGraphState>> {
    const input = this.workflowInput(state)
    const session = structuredClone(this.loadWorkflowSession(state))
    const ingestPlan = planIngestAction(input, session)
    if (ingestPlan.kind !== 'route' || ingestPlan.next !== 'generate') {
      throw new WorkflowResumeBoundaryError('workflow_plan_route_mismatch')
    }
    session.executionSteps = []
    session.toolTrace = []
    this.persistNodeSession(session)
    const planned = await this.runWorkflowStep(
      session,
      'plan',
      () => this.buildPlanForSession(session),
      result => result.ok,
      'plan_rejected',
    )
    if (!planned.ok) {
      session.phase = 'failed'
      const reply = t(session.language, 'planRejected', {
        rounds: planned.modelCalls,
        list: planned.failures
          .map((failure, index) =>
            `- ${renderPlanFailure(failure, planned.failuresL10n[index] ?? null, session.language ?? 'en')}`)
          .join('\n'),
      })
      session.messages.push({ role: 'assistant', content: reply })
      this.persistNodeSession(session)
      return {
        sessionVersion: this.loadedSessionVersion(session.sessionId),
        phase: session.phase,
        next: 'finish',
      }
    }
    if (planned.intent) session.layoutIntent = planned.intent
    session.layoutPlan = planned.plan
    this.persistNodeSession(session)
    return {
      sessionVersion: this.loadedSessionVersion(session.sessionId),
      phase: session.phase,
      next: 'construct',
    }
  }

  private async runConstructWorkflowNode(
    state: DurableWorkflowGraphState,
  ): Promise<Partial<DurableWorkflowGraphState>> {
    const session = this.loadWorkflowSession(state)
    const result = await this.generate({
      input: this.workflowInput(state),
      session,
      reply: '',
      next: 'generate',
    }, true)
    if (!result.session) throw new Error('construct node did not return a session')
    this.persistNodeSession(result.session)
    return {
      sessionVersion: this.loadedSessionVersion(session.sessionId),
      phase: result.session.phase,
      next: 'finish',
    }
  }

  private async runLegacyTurnAndPersist(
    input: ChatInput,
    session: WorkflowSession,
  ): Promise<ChatResult> {
    let state: WorkflowGraphState = { input, session, reply: '', next: 'evaluate' }
    state = { ...state, ...await this.ingest(state) }
    if (state.next === 'evaluate') state = { ...state, ...await this.evaluate(state) }
    else if (state.next === 'generate') state = { ...state, ...await this.generate(state) }
    else if (state.next === 'inspect') state = { ...state, ...await this.inspect(state) }
    else if (state.next === 'modify') state = { ...state, ...await this.modify(state) }
    const result = state
    this.persistNodeSession(result.session)
    return { sessionId: input.sessionId, reply: result.reply, session: result.session }
  }

  private workflowInput(state: DurableWorkflowGraphState): ChatInput {
    const input = this.activeTurnInputs.get(state.requestId)
    if (!input || input.sessionId !== state.sessionId) {
      throw new WorkflowResumeBoundaryError('workflow_request_input_unavailable')
    }
    return input
  }

  private loadWorkflowSession(state: DurableWorkflowGraphState): WorkflowSession {
    const stored = this.sessions.load(state.sessionId)
    if (!stored) throw new WorkflowResumeBoundaryError('workflow_session_missing')
    if (stored.version !== state.sessionVersion) {
      throw new WorkflowResumeBoundaryError('workflow_session_version_mismatch')
    }
    this.sessionVersions.set(state.sessionId, stored.version)
    return stored.session
  }

  private persistNodeSession(session: WorkflowSession): void {
    const prior = this.sessionPriorTotals.get(session.sessionId) ?? session.modelCallsTotal ?? 0
    const used = this.modelCallBudgets.get(session.sessionId) ?? 0
    session.modelCallsTotal = prior + used
    session.updatedAt = new Date().toISOString()
    this.persistSession(session)
  }

  private loadedSessionVersion(sessionId: string): number {
    const version = this.sessionVersions.get(sessionId)
    if (version === undefined) throw new Error(`session ${sessionId} has no loaded persistence version`)
    return version
  }

  private throwIfCancelled(sessionId: string): void {
    if (this.cancelRequests.has(sessionId)) throw new GenerationCancelledError()
  }

  // Single MCP entry point: injects the current turn's cancel signal so a
  // cancel aborts whatever MCP call is in flight, not just model requests.
  // All agent MCP calls go through here so cancellation and timeout behaviour
  // is uniform.
  private callMcp(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const signal = this.runAbortControllers.get(sessionId)?.signal
    const identity = this.auditIdentity(sessionId)
    if (!identity) return this.mcp.callTool(name, args, { signal })
    const sceneId = this.toolAuditor.sceneFor(sessionId)
      ?? this.sessions.load(sessionId)?.session.sceneId
    return this.toolAuditor.callTool({
      ...identity,
      ...(sceneId ? { sceneId } : {}),
    }, name, args, () => this.mcp.callTool(name, args, { signal }))
  }

  private auditIdentity(sessionId: string): AuditIdentity | undefined {
    const context = this.activeRequestContexts.get(sessionId)
    if (!context) return undefined
    const step = this.activeWorkflowSteps.get(sessionId)
    return {
      requestId: context.requestId,
      ...(context.workflowRunId ? { workflowRunId: context.workflowRunId } : {}),
      ...(step ? { workflowStepId: step.stepId } : {}),
      sessionId,
      operationKey: step?.operationKey ?? 'request',
    }
  }

  private recordValidation(
    session: WorkflowSession,
    validator: string,
    status: 'passed' | 'failed' | 'unavailable',
    issueCount: number,
    summary: Record<string, unknown>,
  ): void {
    const identity = this.auditIdentity(session.sessionId)
    if (!identity) return
    const sceneId = session.sceneId ?? this.toolAuditor.sceneFor(session.sessionId)
    const repairMatch = identity.operationKey.match(/^repair:(\d+)$/)
    this.toolAuditor.recordValidation(
      { ...identity, ...(sceneId ? { sceneId } : {}) },
      validator,
      status,
      issueCount,
      summary,
      repairMatch ? Number(repairMatch[1]) : undefined,
    )
  }

  private async runValidationStage(
    session: WorkflowSession,
    stage: ValidationStage,
    context: ValidationContext,
    recordDirect = true,
  ) {
    const results = await this.validationRegistry.runStage(stage, context)
    if (recordDirect) {
      recordDirectValidationResults(results, result => this.recordValidation(
        session,
        result.validatorId,
        result.status,
        result.issueCount,
        result.summary,
      ))
    }
    return results
  }

  // Counts one model API attempt against both the per-turn and the cumulative
  // per-session budgets, throwing once either ceiling is crossed. A no-op when
  // no budget is registered (e.g. calls made outside a `runChat`), so it can
  // never break such callers.
  private chargeModelCall(sessionId: string): void {
    const used = this.modelCallBudgets.get(sessionId)
    if (used === undefined) return
    // Check BOTH ceilings before recording: a rejected attempt sends no HTTP
    // request and emits no telemetry, so counting it would leave
    // modelCallsTotal permanently one ahead of the attempt records (T1.2
    // reconciles the two).
    const next = used + 1
    if (next > this.config.maxModelCallsPerTurn) {
      throw new BudgetExceededError(this.config.maxModelCallsPerTurn)
    }
    const priorTotal = this.sessionPriorTotals.get(sessionId) ?? 0
    if (priorTotal + next > this.config.maxModelCallsPerSession) {
      throw new BudgetExceededError(this.config.maxModelCallsPerSession)
    }
    this.modelCallBudgets.set(sessionId, next)
  }

  private async ingest(state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> {
    const { input } = state
    const session = structuredClone(state.session)

    // Reply language follows the user's latest message (kana→ja, han→zh,
    // else en). A confirm/cancel action carries no text — keep the previous
    // detection so a bare confirmation doesn't flip the language to English.
    if (input.message?.trim()) {
      session.language = detectLanguage(input.message, session.language)
    }

    // Pure state-machine core decides the turn and applies I/O-free
    // transitions; only the delegation markers below need MCP/model calls.
    const plan = planIngestAction(input, session)
    if (plan.kind === 'reply') return { session, reply: plan.reply, next: 'finish' }
    if (plan.kind === 'route') return { session, reply: plan.reply, next: plan.next }
    if (plan.kind === 'route-existing') return this.routeExistingSceneRequest(session, plan.message)
    const message = plan.message

    const guardrailStarted = performance.now()
    const scope = classifyScopeRequest({
      message,
      hasImage: Boolean(input.imageDataUrl),
    })
    const context = this.activeRequestContexts.get(session.sessionId)
    if (context) {
      this.audits.recordGuardrail({
        eventId: crypto.randomUUID(),
        requestId: context.requestId,
        ...(context.workflowRunId ? { workflowRunId: context.workflowRunId } : {}),
        sessionId: session.sessionId,
        policyVersion: SCOPE_POLICY_VERSION,
        decision: scope.decision,
        reasonCode: scope.reasonCode,
        inputKind: input.imageDataUrl ? 'image' : 'text',
        latencyMs: performance.now() - guardrailStarted,
        createdAt: new Date().toISOString(),
      })
    }
    if (scope.decision === 'block') {
      session.messages.push({ role: 'user', content: message })
      const reply = t(session.language, 'offTopic', {})
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }

    if (session.phase === 'intake' && session.sceneId && message) {
      try {
        await this.callMcp(session.sessionId, 'load_scene', { id: session.sceneId })
        const contentNodes = await this.countActiveContentNodes(session.sessionId)
        if (shouldModifyExistingScene(contentNodes)) {
          return this.routeExistingSceneRequest(session, message)
        }
      } catch (error) {
        const reply = t(session.language, 'sceneLoadFailed', { sceneId: session.sceneId, error: errorMessage(error) })
        session.messages.push({ role: 'assistant', content: reply })
        return { session, reply, next: 'finish' }
      }
    }

    session.inputType = input.imageDataUrl ? 'image' : session.inputType
    session.messages.push({ role: 'user', content: message || '[上传户型图]' })

    try {
      const extracted = await this.extractRequirements(session, message, input.imageDataUrl)
      // Off-topic input (weather, small talk…): reply and stop before it
      // pollutes the brief or burns a clarification round. Only an explicit
      // `false` short-circuits, so models that omit the field behave as before.
      if (extracted.relevant === false) {
        const reply = t(session.language, 'offTopic', {})
        session.messages.push({ role: 'assistant', content: reply })
        return { session, reply, next: 'finish' }
      }
      session.brief = mergeBrief(session.brief, extracted)
      ensureSiteDimensionFact(session.brief, message, session.language ?? 'zh')
      session.questions = stringArray(extracted.questions).slice(0, 3)
      if (session.phase === 'clarifying') session.clarificationRounds++
      return { session, reply: '', next: 'evaluate' }
    } catch (error) {
      session.phase = 'failed'
      const reply = t(session.language, 'briefParseFailed', { error: errorMessage(error) })
      // Record the failure reply so the eval harness and the /sessions
      // recovery endpoint can read the real reason instead of an empty tail.
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }
  }

  private async inspect(state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> {
    const session = structuredClone(state.session)
    return inspectExistingScene({
      session,
      question: state.input.message?.trim() ?? '',
      loadScene: async sceneId => { await this.callMcp(session.sessionId, 'load_scene', { id: sceneId }) },
      answerQuestion: (current, question) => this.answerSceneQuestion(current, question),
      errorMessage,
    })
  }

  private async routeExistingSceneRequest(
    session: WorkflowSession,
    message: string,
  ): Promise<Partial<WorkflowGraphState>> {
    session.messages.push({ role: 'user', content: message })
    const intent = await this.classifySceneIntent(session, message)
    return planExistingSceneRequest(session, message, intent)
  }

  private async classifySceneIntent(session: WorkflowSession, message: string): Promise<SceneIntent> {
    try {
      // Exclude the last entry: it's `message` itself, already pushed to
      // session.messages by the caller before this runs.
      const history = recentConversationText(session.messages.slice(0, -1))
      const prompt = renderPrompt('scene-intent', {
        history,
        latest: message,
      })
      const result = await this.withFastModel(session.sessionId, (model, hooks) =>
        model.json<{ intent?: unknown }>(
          [
            { role: 'system', content: prompt.parts.system },
            { role: 'user', content: prompt.parts.user },
          ],
          'scene-intent',
          { ...hooks, operation: 'scene-intent', ...promptAudit(prompt) },
        ),
      )
      if (isSceneIntent(result.output.intent)) return result.output.intent
    } catch {
      // Deterministic routing remains available when the model is temporarily unavailable.
    }
    return classifySceneIntentFallback(message)
  }

  private async evaluate(state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> {
    const session = structuredClone(state.session)
    const evaluation = evaluateBrief(session.brief, session.inputType, this.config, session.language)
    session.availability = evaluation.availability
    session.reasons = evaluation.reasons
    session.questions = dedupe([...session.questions, ...evaluation.questions]).slice(0, 3)

    if (evaluation.availability === 'unusable') {
      session.phase = 'failed'
      const reply = [
        '当前输入不可用，暂时不会生成户型。',
        ...evaluation.reasons.map(reason => `- ${reason}`),
        '请补充文字需求或上传边界完整、清晰的户型图。',
      ].join('\n')
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }

    if (evaluation.availability === 'partially_usable') {
      session.phase = 'clarifying'
      const reachedLimit = session.clarificationRounds >= this.config.maxClarificationRounds
      const questions = session.questions.length > 0
        ? session.questions
        : [t(session.language, 'clarifyDefault', {})]
      const numbered = questions.map((question, index) => `${index + 1}. ${question}`).join('\n')
      const reply = reachedLimit
        ? t(session.language, 'clarifyAtLimit', { questions: numbered })
        : t(session.language, 'clarifyAsk', { questions: numbered })
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }

    session.phase = 'awaiting_confirmation'
    // `session.summary` 仍用结构化摘要（含来源/置信度），它会作为 brief 传给
    // 生成模型，结构信息对生成质量有用；面向用户展示的是自然语言版本。
    session.summary = formatSummary(session.brief)
    const reply = t(session.language, 'confirmPrompt', {
      summary: formatUserFacingSummary(session.brief, session.language),
    })
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }

  private async generate(
    state: WorkflowGraphState,
    preparedPlan = false,
  ): Promise<Partial<WorkflowGraphState>> {
    return runGenerateWorkflow(state, preparedPlan, {
      persistSession: session => this.persistSession(session),
      runStep: (session, operationKey, work, accepts, rejectedErrorCode) =>
        this.runWorkflowStep(session, operationKey, work, accepts, rejectedErrorCode),
      buildGenerationArgs,
      loadScene: async (session, sceneId) =>
        toolPayload(await this.callMcp(session.sessionId, 'load_scene', { id: sceneId })),
      countActiveContentNodes: sessionId => this.countActiveContentNodes(sessionId),
      shouldModifyExistingScene,
      applyToExistingScene: (session, loaded) =>
        this.applyConfirmedBriefToExistingScene(session, loaded),
      buildPlan: (session, failures) => this.buildPlanForSession(session, failures),
      renderPlanFailure: (message, index, plan) => renderPlanFailure(
        message,
        plan.ok ? null : plan.failuresL10n[index] ?? null,
        state.session.language ?? 'en',
      ),
      startFreshBuild: session => {
        const context = this.activeRequestContexts.get(session.sessionId)
        if (!context) throw new Error('Missing request context for fresh scene build')
        const buildId = crypto.randomUUID()
        this.sceneBuilds.start({
          buildId,
          requestId: context.requestId,
          traceId: context.traceId,
          sessionId: session.sessionId,
          startedAt: new Date().toISOString(),
        })
        return buildId
      },
      createScaffold: async (session, args) => {
        const created = toolPayload(
          await this.callMcp(session.sessionId, 'create_house_from_brief', args),
        )
        return {
          sceneId: nullableString(created.projectId ?? created.sceneId ?? created.id),
          levelId: nullableString(created.defaultLevelId),
          version: nullableNumber(created.version),
        }
      },
      identifyFreshBuild: async (buildId, sceneId) => {
        this.sceneBuilds.identifyScene(buildId, sceneId, new Date().toISOString())
      },
      updateFreshBuildBoundary: async (buildId, sessionId, sceneId) => {
        const boundary = await this.sceneBoundary(sessionId, sceneId)
        this.sceneBuilds.updateBoundary(buildId, boundary, new Date().toISOString())
      },
      clearLevel: (session, levelId) => this.clearLevelForRebuild(session, levelId),
      construct: (session, levelId, plan, persistAfterRound) =>
        this.constructScenePlanFirst(session, levelId, plan, { persistAfterRound }),
      persistScene: (sessionId, sceneId, valid, expectedVersion) =>
        this.persistScene(sessionId, sceneId, valid, expectedVersion),
      succeedFreshBuild: async (buildId, sessionId, sceneId) => {
        const boundary = await this.sceneBoundary(sessionId, sceneId)
        this.sceneBuilds.succeed(buildId, boundary, new Date().toISOString())
      },
      abandonFreshBuild: (buildId, errorCode) => {
        try {
          this.sceneBuilds.abandon(buildId, errorCode, new Date().toISOString())
        } catch (error) {
          console.error(`[scene-build ${buildId}] failed to persist abandonment: ${errorMessage(error)}`)
        }
      },
      isCancellationError: error => error instanceof GenerationCancelledError,
      errorMessage,
    })
  }
  private async applyConfirmedBriefToExistingScene(
    session: WorkflowSession,
    loaded: Record<string, unknown>,
  ): Promise<Partial<WorkflowGraphState>> {
    const sceneId = session.sceneId!
    const { diagnostics, repairRounds, toolNamesUsed, furnitureIssues } = await this.refineAndDiagnose(
      session,
      '在当前已有户型的基础上实现已确认需求。现有墙体、房间和开口是源数据；只做满足需求所必需的增量修改，禁止用模板替换整个场景，禁止删除无关结构。',
      { phaseLabel: '在已有户型上应用已确认需求', validationStage: 'modify' },
    )
    const sceneVersion = await this.persistScene(
      session.sessionId,
      sceneId,
      diagnostics.validation.valid,
      nullableNumber(loaded.version),
    )
    const gates = await this.evaluateGates(session, 'modify')
    const { reply } = finishSceneWorkflow({
      session,
      sceneId,
      editorUrl: publicEditorUrl(sceneId),
      version: sceneVersion,
      diagnostics,
      repairRounds,
      toolNamesUsed,
      furnitureIssues,
      gateFailures: gates.report.failures,
      gatesPassed: gates.report.passed,
      successText: t(session.language, 'applyToExistingSuccess', {}),
      layoutQuality: gates.layoutQuality,
    })
    return { session, reply, next: 'finish' }
  }

  private async modify(state: WorkflowGraphState): Promise<Partial<WorkflowGraphState>> {
    return runModifyWorkflow(state, {
      persistSession: session => this.persistSession(session),
      loadScene: async (session, sceneId) =>
        toolPayload(await this.callMcp(session.sessionId, 'load_scene', { id: sceneId })),
      runPlanFirst: (session, feedback, sceneId, loadedVersion) =>
        this.runWorkflowStep(
          session,
          'modify-plan',
          () => this.tryPlanFirstModify(session, feedback, sceneId, loadedVersion),
        ),
      snapshotScene: async session => snapshotSceneNodes(
        toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})),
      ),
      runLegacyPhase: (session, purpose) => this.runWorkflowStep(
        session,
        'modify',
        () => this.runPhaseToConvergence(
          session,
          purpose,
          undefined,
          new Set<string>(),
          [],
          '按用户要求修改场景',
        ),
      ),
      dedupeSharedWalls: (sessionId, levelId, protectedWallIds) =>
        this.dedupeSharedWalls(sessionId, levelId, protectedWallIds),
      checkProtection: async (session, before, after, feedback) => {
        const results = await this.runValidationStage(session, 'modify', {
          modificationProtection: {
            evaluate: () => checkModificationProtection(before, after, feedback),
          },
        })
        return validationValue<string[]>(results, VALIDATOR_IDS.modificationProtection)
      },
      refine: async (session, purpose, phase, extraChecks) => this.refineAndDiagnose(
        session,
        purpose,
        {
          skipInitialAgent: true,
          conversation: phase.messages,
          toolNamesUsed: phase.toolNamesUsed,
          furnitureIssues: phase.furnitureIssues,
          ...(extraChecks ? { extraChecks } : {}),
          validationStage: 'modify',
        },
      ),
      persistScene: (sessionId, sceneId, valid, expectedVersion) =>
        this.persistScene(sessionId, sceneId, valid, expectedVersion),
      evaluateGates: session => this.evaluateGates(session, 'modify'),
      clearDestructiveWrite: sessionId => this.destructiveWrites.delete(sessionId),
      isCancellationError: error => error instanceof GenerationCancelledError,
      errorMessage,
      planSnapshot: formatPlanSnapshot,
    })
  }
  private async tryPlanFirstModify(
    session: WorkflowSession,
    feedback: string,
    sceneId: string,
    loadedVersion: number | null,
  ): Promise<Partial<WorkflowGraphState>> {
    // Live room list from zones; types come from the authoritative map when
    // the scene was built plan-first, name classification otherwise — so the
    // furniture path also works for legacy scenes without an intent snapshot.
    const zonesPayload = toolPayload(await this.callMcp(session.sessionId, 'get_zones', {}))
    const zones = Array.isArray(zonesPayload.zones) ? zonesPayload.zones.filter(isZoneSummary) : []
    if (zones.length === 0) {
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyLocalUnavailable', {}),
      )
    }
    const zoneTypes = this.resolveZoneTypes(session, zones)
    const rooms: FurnitureRoom[] = zones.map(zone => ({
      id: zone.id,
      name: zone.name,
      type: zoneTypes[zone.id] ?? classifyRoomTypeByName(zone.name),
      polygon: zone.polygon,
      zoneId: zone.id,
    }))

    const trace = startPhaseTrace(session, '规划式修改（确定性执行器）')
    const traceMcp = async (name: string, args: Record<string, unknown>) => {
      const result = await this.callMcp(session.sessionId, name, args)
      trace.toolCounts[name] = (trace.toolCounts[name] ?? 0) + 1
      trace.toolCalls.push({ name, ok: true })
      return result
    }
    const beforeCall = () => this.throwIfCancelled(session.sessionId)

    // Parse failures get one correction retry with the error list fed back
    // (MODIFY_REDESIGN.md §2: 解析失败 → 修正 prompt 重试 ≤2 轮) — falling to
    // legacy on a transient formatting slip would silently downgrade a clean
    // furniture request to the free-edit path.
    const roomList = rooms.map(room => room.name).join('、')
    const parsed = await resolveModifyPlanForExecution({
      confirmed: session.modifyModeConfirmed === true,
      pendingPlan: session.pendingModifyPlan,
      translate: async () => {
        let translated: ReturnType<typeof parseModifyOps> | null = null
        for (let attempt = 0; attempt < 2; attempt++) {
          const prompt = renderPrompt('modify-ops', {
            roomList,
            request: feedback,
            errors: translated?.errors.join('；') ?? '',
          })
          trace.modelCalls++
          const raw = await this.withModelFallback(session.sessionId, (model, hooks) =>
            model.complete([
              { role: 'system', content: prompt.parts.system },
              {
                role: 'user',
                content: attempt === 0 || !translated ? prompt.parts.user : prompt.parts.retryUser,
              },
            ], `${session.sessionId}:modify:ops`, {
              ...hooks,
              operation: 'modify-ops',
              ...promptAudit(prompt),
              temperature: this.config.aiTemperatureGeometry,
            }).then(result => result.output),
          )
          translated = parseModifyOps(raw)
          // Only parse DEFECTS warrant a retry; an empty-ops answer with no
          // errors is the translator deliberately saying "out of scope".
          if (translated.errors.length === 0) break
        }
        return translated ?? { plan: null, errors: ['未生成修改计划'] }
      },
    })
    // Empty ops is the translator's "out of vocabulary / not sure" signal.
    // Do not silently downgrade it to the unconstrained legacy editor.
    if (!parsed?.plan || parsed.errors.length > 0) {
      const decision = classifyModificationMode([])
      this.recordModificationDecision(session.sessionId, decision)
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyUnsupportedSafe', {}),
      )
    }
    parsed.plan = withPreservationPolicy(
      feedback,
      normalizeSemanticRemovalPlan(feedback, parsed.plan),
    )
    const modificationDecision = classifyModificationMode(parsed.plan.ops)
    this.recordModificationDecision(session.sessionId, modificationDecision)
    const modificationPlanHash = canonicalModifyPlanHash(parsed.plan)
    const confirmedCurrentPlan = confirmedModificationMatches(
      modificationDecision,
      modificationPlanHash,
      {
        mode: session.pendingModificationMode,
        reasonCode: session.pendingModificationReasonCode,
        planHash: session.pendingModificationPlanHash,
        confirmed: session.modifyModeConfirmed,
      },
    )
    session.pendingModificationMode = modificationDecision.mode
    session.pendingModificationReasonCode = modificationDecision.reasonCode
    session.pendingModificationPlanHash = modificationPlanHash
    session.pendingModifyPlan = structuredClone(parsed.plan)
    if (!confirmedCurrentPlan) delete session.modifyModeConfirmed

    // §6 三修 gates 归责基线：修改前场景已有的 gate 失败（用户此前手动
    // 删过的设备等）是继承状态，不是本次修改的账——收尾时只对新增失败
    // 判 phase（见 effectiveGateFailures）。纯本地 MCP 读取，零模型调用。
    const baselineGateFailures = (await this.evaluateGates(session, 'modify')).report.failures
    const removalsOf = (report: FurnitureModifyReport | null): IntentRemoval[] =>
      report?.results.flatMap(result => (result.removed ? [result.removed] : [])) ?? []

    // P1-3: persist the real side-effect state the instant a write is dispatched
    // or resolved, so a crash mid-operation never leaves the session at no_write.
    const persistWriteEffect = (state: WriteEffectState) => {
      session.modificationWriteEffect = state
      this.persistSession(session)
    }

    // R4.3 / P1-1 / P1-5: a bulk clear needs an explicit count-and-confirm turn
    // bound to CONCRETE target ids, for EVERY local path (furniture-only AND
    // rename+clear) — not just the furniture-only block. Runs before the path
    // split. plan_rebuild + clear is handled by the rebuild confirmation, whose
    // clear runs on a freshly furnished scene where target-binding is moot.
    let clearTargets: Record<string, string[]> | undefined
    if (modificationDecision.mode === 'local_patch' && planRequiresBatchConfirmation(parsed.plan.ops)) {
      const clearLevelId = await this.findLevelId(session)
      if (!clearLevelId) {
        return this.finishSafeModificationRejection(session, t(session.language, 'modifyLocalUnavailable', {}))
      }
      const clearRoomIds: string[] = []
      for (const op of parsed.plan.ops) {
        if (op.op !== 'clear_room_furniture') continue
        const resolved = resolveRoomRef(op.room, rooms)
        if ('error' in resolved) {
          return this.finishSafeModificationRejection(
            session, t(session.language, 'modifyRoomAmbiguous', { detail: resolved.error }))
        }
        clearRoomIds.push(resolved.room.id)
      }
      const preview = await previewRoomFurnitureClear({
        rooms: rooms.filter(room => clearRoomIds.includes(room.id)),
        levelId: clearLevelId,
        callMcp: traceMcp,
        beforeCall,
      })
      // P1-B: a failed furniture read must NOT be shown as "nothing to clear".
      // Bail as a safe, zero-write rejection so the user can retry.
      if (preview.readFailed) {
        return this.finishSafeModificationRejection(session, t(session.language, 'modifyLocalUnavailable', {}))
      }
      const currentTargets: Record<string, string[]> = {}
      for (const room of preview.perRoom) currentTargets[room.roomId] = [...room.itemIds].sort()
      const total = preview.perRoom.reduce((sum, room) => sum + room.itemIds.length, 0)
      const detail = preview.perRoom
        .map(room => `「${room.roomName}」${room.itemIds.length} 件可移动家具`)
        .join('；')
      const sameTargets = clearRoomIds.every(id =>
        JSON.stringify((session.pendingClearTargets ?? {})[id] ?? []) === JSON.stringify(currentTargets[id] ?? []))

      if (total === 0) {
        // Nothing movable to clear — complete without asking (zero writes).
        delete session.pendingClearTargets
        return this.finishSafeModificationRejection(session, t(session.language, 'modifyClearNothing', { detail }))
      }
      if (!confirmedCurrentPlan) {
        session.pendingClearTargets = currentTargets
        session.phase = 'awaiting_modification_confirmation'
        const reply = t(session.language, 'modifyClearConfirm', { detail, total })
        session.messages.push({ role: 'assistant', content: reply })
        return { session, reply, next: 'finish' }
      }
      // Confirmed — but re-check the targets did not shift during the wait.
      if (!session.pendingClearTargets || !sameTargets) {
        session.pendingClearTargets = currentTargets
        session.phase = 'awaiting_modification_confirmation'
        delete session.modifyModeConfirmed
        const reply = t(session.language, 'modifyClearRetarget', { detail, total })
        session.messages.push({ role: 'assistant', content: reply })
        return { session, reply, next: 'finish' }
      }
      clearTargets = currentTargets
      delete session.pendingClearTargets
    }

    const furnitureOnly = parsed.plan.ops.every(op =>
      op.op === 'add_furniture' || op.op === 'remove_furniture'
      || op.op === 'swap_furniture' || op.op === 'clear_room_furniture')
    if (furnitureOnly) {
      const levelId = await this.findLevelId(session)
      if (!levelId) {
        return this.finishSafeModificationRejection(
          session,
          t(session.language, 'modifyLocalUnavailable', {}),
        )
      }
      // R2.1/R2.2/R2.3: bind every furniture op to a concrete live room BEFORE
      // any write. The furniture-only path runs the model plan directly (it
      // never passes through applyModifyOps' strict resolution), so this is
      // where the substring-first guess used to leak in. Ambiguous or unknown
      // rooms are a safe, zero-write clarification — never a first-item pick.
      const bound: FurnitureModifyOp[] = []
      for (const op of parsed.plan.ops as FurnitureModifyOp[]) {
        const resolved = resolveRoomRef(op.room, rooms)
        if ('error' in resolved) {
          return this.finishSafeModificationRejection(
            session,
            t(session.language, 'modifyRoomAmbiguous', { detail: resolved.error }),
          )
        }
        bound.push({ ...op, room: resolved.room.id })
      }
      const beforeSnapshot = snapshotSceneNodes(
        toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})),
      )
      // R1.3/P1-3: no premature write-started guess. The mutation wrapper reports
      // the real side-effect state live via onWriteEffect (persisted the instant
      // a write is dispatched), so a zero-write failure stays `no_write` and a
      // crash mid-batch is never lost as no_write.
      const report = await executeFurnitureModifyOps({
        ops: bound,
        rooms,
        levelId,
        callMcp: traceMcp,
        beforeCall,
        onWriteEffect: persistWriteEffect,
        clearTargets,
      })
      session.modificationWriteEffect = report.writeEffect
      this.persistSession(session)
      // P1: a write whose result is unknown (or a confirmed+unknown partial)
      // must NOT be saved and reported as a normal completion. Throw so the
      // modify-service catch routes it by side-effect state (result-unknown /
      // destructive) — never save_scene, never auto-replay.
      this.throwIfWriteUncertain(report.writeEffect, report.executionIssues)
      await this.verifyLocalPatchScope(
        session,
        beforeSnapshot,
        localPatchAllowances([], report, rooms, bound, levelId),
      )
      await this.verifyModificationPostconditions(session, validateModificationPostconditions({
        before: session.layoutPlan,
        after: session.layoutPlan,
        plan: parsed.plan,
        furnitureReport: report,
      }))
      trace.converged = true
      return this.finishPlanFirstModify(session, sceneId, loadedVersion, trace, {
        okDetails: report.results.filter(r => r.ok).map(r => r.detail),
        failedDetails: report.results.filter(r => !r.ok).map(r => r.detail),
        baselineGateFailures,
        intentRemovals: removalsOf(report),
        sceneWasWritten: report.writeEffect !== 'no_write',
      })
    }

    // --- structural / rename path (M2) — needs the plan-first snapshots ---
    if (!session.layoutIntent || !session.layoutPlan) {
      return this.finishSafeModificationRejection(
        session,
        t(
          session.language,
          modificationDecision.mode === 'plan_rebuild'
            ? 'modifyRebuildUnavailable'
            : 'modifyUnsupportedSafe',
          {},
        ),
      )
    }
    const beforePlan = structuredClone(session.layoutPlan)
    if (needsModificationConfirmation(modificationDecision, confirmedCurrentPlan)) {
      const manualDrift = sceneDriftedFromPlan(zones, session.layoutPlan)
      if (manualDrift) session.modifyDriftConfirmed = true
      session.phase = 'awaiting_modification_confirmation'
      const reply = t(session.language, 'modifyRebuildConfirm', { manualDrift })
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }
    delete session.modifyDriftConfirmed
    const profile = resolveNormProfile(this.config.normProfile)

    // Rename pairs resolve against the PRE-edit intent (old name → zone).
    const renameByRoomId = new Map<string, { roomId: string; oldName: string; newName: string }>()
    for (const op of parsed.plan.ops) {
      if (op.op !== 'rename_room') continue
      const resolved = resolveRoomRef(op.room, session.layoutIntent.rooms)
      if ('room' in resolved) {
        renameByRoomId.set(resolved.room.id, {
          roomId: resolved.room.id,
          oldName: resolved.room.name,
          newName: op.name,
        })
      }
    }
    const renames = [...renameByRoomId.values()]
    const applied = applyModifyOps(session.layoutIntent, parsed.plan, profile)
    if (applied.errors.length > 0) return this.rejectPlanFirstModify(session, applied.errors)

    if (!applied.structural) {
      // rename (± furniture) only — no re-partition (§3): zone rename is a
      // metadata patch, everything else stays untouched.
      const zoneIdByName = new Map(zones.map(zone => [zone.name, zone.id]))
      const patches = renames.flatMap(entry => {
        const zoneId = zoneIdByName.get(entry.oldName)
        return zoneId ? [{ op: 'update', id: zoneId, data: { name: entry.newName } }] : []
      })
      const localLevelId = applied.furnitureOps.length > 0
        ? await this.findLevelId(session)
        : null
      if (applied.furnitureOps.length > 0 && !localLevelId) {
        return this.finishSafeModificationRejection(
          session,
          t(session.language, 'modifyLocalUnavailable', {}),
        )
      }
      const beforeSnapshot = snapshotSceneNodes(
        toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})),
      )
      const renamedPlan: LayoutPlan = {
        ...session.layoutPlan,
        rooms: session.layoutPlan.rooms.map(room => {
          const entry = renames.find(rename => rename.roomId === room.id)
          return entry ? { ...room, name: entry.newName } : room
        }),
      }
      const preservationFindings = await this.recordPreservationFindings(
        session,
        validatePreservedPlan(beforePlan, renamedPlan, parsed.plan),
      )
      if (preservationFindings.length > 0) {
        return this.finishSafeModificationRejection(
          session,
          t(session.language, 'modifyStrictLocalUnavailable', {
            reason: preservationFindings[0]!.code,
          }),
        )
      }
      // R1.3: the rename patch IS a real write — mark the result unknown right
      // before dispatch (honest, since a mutation is about to fire), then
      // confirm once it returns. A zero-patch rename (nothing to write) stays
      // no_write until the furniture stage, if any.
      if (patches.length > 0) {
        session.modificationWriteEffect = 'write_attempted'
        this.persistSession(session)
        await traceMcp('apply_patch', { patches })
        session.modificationWriteEffect = 'write_confirmed'
      }
      session.layoutIntent = applied.intent
      // Keep the plan snapshot's names in step, or the rename would read as
      // drift on the next structural modify.
      session.layoutPlan = renamedPlan
      let furnReport: FurnitureModifyReport | null = null
      if (applied.furnitureOps.length > 0) {
        furnReport = await executeFurnitureModifyOps({
          ops: applied.furnitureOps,
          rooms,
          levelId: localLevelId!,
          callMcp: traceMcp,
          beforeCall,
          // P1-3: real-time state, seeded with the rename patch so the verdict
          // spans both the patch and the furniture ops.
          onWriteEffect: persistWriteEffect,
          priorConfirmedWrites: patches.length > 0 ? 1 : 0,
          clearTargets,
        })
        session.modificationWriteEffect = combineWriteEffects(
          session.modificationWriteEffect,
          furnReport.writeEffect,
        )
      }
      this.persistSession(session)
      // P1: an uncertain combined write must not save & complete normally.
      this.throwIfWriteUncertain(session.modificationWriteEffect ?? 'no_write', furnReport?.executionIssues ?? [])
      await this.verifyLocalPatchScope(
        session,
        beforeSnapshot,
        localPatchAllowances(
          patches.map(patch => patch.id),
          furnReport,
          rooms,
          applied.furnitureOps,
          localLevelId,
        ),
      )
      const actualZonesPayload = toolPayload(await this.callMcp(session.sessionId, 'get_zones', {}))
      const actualZones = Array.isArray(actualZonesPayload.zones)
        ? actualZonesPayload.zones.filter(isZoneSummary)
        : []
      const executedFindings = await this.recordPreservationFindings(
        session,
        validateExecutedPlan(renamedPlan, actualZones),
      )
      if (executedFindings.length > 0) {
        throw new ModificationVerificationError(executedFindings.map(finding => finding.code))
      }
      await this.verifyModificationPostconditions(session, validateModificationPostconditions({
        before: beforePlan,
        after: renamedPlan,
        plan: parsed.plan,
        furnitureReport: furnReport,
      }))
      trace.converged = true
      return this.finishPlanFirstModify(session, sceneId, loadedVersion, trace, {
        okDetails: [...applied.notes, ...(furnReport?.results.filter(r => r.ok).map(r => r.detail) ?? [])],
        failedDetails: furnReport?.results.filter(r => !r.ok).map(r => r.detail) ?? [],
        baselineGateFailures,
        intentRemovals: removalsOf(furnReport),
        sceneWasWritten: patches.length > 0 || (furnReport?.writeEffect ?? 'no_write') !== 'no_write',
      })
    }

    // --- structural path (§8 通用局部结构增删改) ---------------------------
    // Try the DETERMINISTIC LOCAL engine first: add_room carves from a host,
    // remove_room absorbs into a neighbour, resize_room slides one shared wall
    // — every other room keeps its exact polygon and the footprint/total area
    // never change. Only when the edit cannot be done safely — and the request
    // permits it — do we fall back to a full stability re-partition. The local
    // plan is validated with the MODIFY-specific diff validator, which
    // grandfathers pre-existing issues on unrelated rooms (生成严格、修改增量化).
    const structuralOps = parsed.plan.ops.filter(
      (op): op is StructuralModifyOp =>
        op.op === 'add_room' || op.op === 'remove_room' || op.op === 'resize_room',
    )
    const bindings: StructuralOpBinding[] = structuralOps.map(op => ({
      op,
      removalIds: op.op === 'remove_room'
        ? removalRoomIdsForRef(session.layoutPlan!, op.room)
        : undefined,
    }))
    const local = applyLocalStructuralEdits(session.layoutPlan, bindings, profile)
    await this.runValidationStage(session, 'modify', {
      localStructuralEdit: { outcome: local },
    })
    trace.notes = [
      ...(trace.notes ?? []),
      ...local.results.map(result => `local:${result.op}:${result.status}:${result.reasonCode}`),
    ]
    if (local.ok) {
      // Apply any rename_room ops the engine left untouched (renames are pure
      // metadata — matched old-name → room on the locally-edited plan) so a
      // mixed "扩大主卧并把次卧改名儿童房" keeps the rename.
      const localPlan: LayoutPlan = renames.length > 0
        ? {
          ...local.plan,
          rooms: local.plan.rooms.map(room => {
            const entry = renames.find(rename => rename.roomId === room.id)
            return entry ? { ...room, name: entry.newName } : room
          }),
        }
        : local.plan
      const localValidationResults = await this.runValidationStage(session, 'modify', {
        localStructuralValidation: {
          result: validateModifiedLayoutPlan({
            before: beforePlan,
            after: localPlan,
            affectedRoomIds: local.affectedRoomIds,
            profile,
          }),
        },
      })
      const modifyValidation = validationValue<ModifyValidationResult>(
        localValidationResults,
        VALIDATOR_IDS.localStructuralValidation,
      )
      if (modifyValidation.fatal.length === 0) {
        const preservationFindings = await this.recordPreservationFindings(
          session,
          validatePreservedPlan(beforePlan, localPlan, parsed.plan),
        )
        if (preservationFindings.length > 0) {
          return this.finishSafeModificationRejection(
            session,
            t(session.language, 'modifyStrictLocalUnavailable', { reason: preservationFindings[0]!.code }),
          )
        }
        const localIntent = intentFromLocalPlan(localPlan)
        const localStrategy = deriveStrategy(
          briefFactsFor(session.brief, session.summary || formatSummary(session.brief)),
          planTargetsForIntent(localIntent),
          profile,
        )
        const hasRemainingWrites = local.changed
          || renames.length > 0
          || applied.furnitureOps.length > 0
        if (!hasRemainingWrites) {
          session.layoutIntent = localIntent
          session.layoutPlan = localPlan
          session.strategy = localStrategy
          session.programEditedByModify = true
          this.persistSession(session)
          await this.verifyModificationPostconditions(session, validateModificationPostconditions({
            before: beforePlan,
            after: localPlan,
            plan: parsed.plan,
          }))
          trace.converged = true
          return this.finishPlanFirstModify(session, sceneId, loadedVersion, trace, {
            okDetails: [...applied.notes, ...local.notes],
            failedDetails: [],
            baselineGateFailures,
            sceneWasWritten: false,
          })
        }
        return this.rebuildScenePlanFirst({
          session,
          sceneId,
          loadedVersion,
          trace,
          traceMcp,
          beforeCall,
          zones,
          intent: localIntent,
          plan: localPlan,
          planNotes: local.notes,
          strategy: localStrategy,
          furnitureOps: applied.furnitureOps,
          skippedFurnitureOps: applied.skippedFurnitureOps,
          appliedNotes: applied.notes,
          baselineGateFailures,
          beforePlan,
          modifyPlan: parsed.plan,
        })
      }
      // Geometrically valid but introduces or worsens a fatal issue — record
      // the structured findings and fall through to preservation-mode gating.
      trace.notes = [
        ...(trace.notes ?? []),
        ...modifyValidation.fatal.map(finding => `modify-validation:${finding.code}:${finding.reason}`),
      ]
    }
    // The local edit could not be applied safely. Honour the request's
    // preservation intent — strict_local & best_effort NEVER auto-rebuild
    // (§6.5：不允许局部失败后自动整体重排).
    const localReason: LocalEditReasonCode = local.ok
      ? 'geometry_would_be_invalid'
      : local.rejection.reasonCode
    const preservationMode = parsed.plan.preservation?.mode ?? 'allow_rebuild'
    if (preservationMode === 'strict_local') {
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyStrictLocalUnavailable', { reason: localReason }),
      )
    }
    if (preservationMode === 'best_effort') {
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyLocalRebuildOffer', { reason: localReason }),
      )
    }

    // allow_rebuild: fall back to a full stability re-partition (§6.4.3 — the
    // user already confirmed a structural rebuild for this plan). Re-partition
    // the edited intent under the stability constraint (§4), validate, then
    // rebuild the scene deterministically (§6: zero model calls).
    const intent = applied.intent
    const requiredRooms = [...intent.rooms.reduce((acc, room) => {
      acc.set(room.type, (acc.get(room.type) ?? 0) + 1)
      return acc
    }, new Map<RoomType, number>())].map(([type, count]) => ({ type, count }))
    const targets: PlanTargets = { totalAreaSqm: intent.targetTotalAreaSqm, requiredRooms }
    const briefSummary = session.summary || formatSummary(session.brief)
    const strategy = deriveStrategy(briefFactsFor(session.brief, briefSummary), targets, profile)
    const partition = partitionLayout(intent, profile, strategy, { previousPlan: session.layoutPlan })
    if (!partition.ok) {
      return this.rejectPlanFirstModify(session, [
        partition.reason,
        ...(partition.details ?? []).map(detail => detail.message),
      ])
    }
    let plan = partition.plan
    let planNotes = partition.notes
    // resize_room carries an explicit user number ("扩大到至少16平米"), but the
    // partitioner scales all room targets uniformly to absorb corridor
    // overhead — the resized room systematically lands a few percent short.
    // Compensate deterministically: re-partition once with the target
    // inflated by the observed shortfall ratio; if it still misses, keep the
    // honest note instead of silently under-delivering (§2 不静默放弃也不硬改).
    const planAreaOf = (candidate: LayoutPlan, id: string) => {
      const room = candidate.rooms.find(entry => entry.id === id)
      return room ? polygonArea(room.polygon) : null
    }
    const shortfalls = parsed.plan.ops.flatMap(op => {
      if (op.op !== 'resize_room') return []
      const resolved = resolveRoomRef(op.room, intent.rooms)
      if (!('room' in resolved)) return []
      const actual = planAreaOf(plan, resolved.room.id)
      return actual !== null && actual < op.targetAreaSqm - 0.05
        ? [{ id: resolved.room.id, name: resolved.room.name, sqm: op.targetAreaSqm, actual }]
        : []
    })
    if (shortfalls.length > 0) {
      const inflatedRooms = intent.rooms.map(room => {
        const entry = shortfalls.find(s => s.id === room.id)
        return entry
          ? { ...room, targetAreaSqm: Math.round(entry.sqm * (entry.sqm / entry.actual) * 10) / 10 }
          : room
      })
      const addedArea = shortfalls.reduce((sum, s) => sum + (s.sqm * (s.sqm / s.actual) - s.sqm), 0)
      const inflatedIntent = {
        ...intent,
        rooms: inflatedRooms,
        targetTotalAreaSqm: Math.round((intent.targetTotalAreaSqm + addedArea) * 10) / 10,
      }
      const retry = partitionLayout(inflatedIntent, profile, strategy, { previousPlan: session.layoutPlan })
      if (retry.ok && shortfalls.every(s => (planAreaOf(retry.plan, s.id) ?? 0) >= s.sqm - 0.05)) {
        plan = retry.plan
        planNotes = retry.notes
      } else {
        planNotes = [
          ...planNotes,
          ...shortfalls.map(s =>
            `「${s.name}」目标 ${s.sqm}㎡，分区实际 ${Math.round(s.actual * 100) / 100}㎡（受轮廓与走廊约束，已尽量接近）`),
        ]
      }
    }
    const preservationFindings = await this.recordPreservationFindings(
      session,
      validatePreservedPlan(beforePlan, plan, parsed.plan),
    )
    if (preservationFindings.length > 0) {
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyStrictLocalUnavailable', {
          reason: preservationFindings[0]!.code,
        }),
      )
    }
    const validationResults = await this.runValidationStage(session, 'modify', {
      layoutPlan: { plan, targets, profile },
    })
    const validation = validationValue<PlanValidation>(validationResults, VALIDATOR_IDS.layoutPlan)
    if (validation.fatal.length > 0) return this.rejectPlanFirstModify(session, validation.fatal)

    return this.rebuildScenePlanFirst({
      session,
      sceneId,
      loadedVersion,
      trace,
      traceMcp,
      beforeCall,
      zones,
      intent,
      plan,
      planNotes,
      strategy,
      furnitureOps: applied.furnitureOps,
      skippedFurnitureOps: applied.skippedFurnitureOps,
      appliedNotes: applied.notes,
      baselineGateFailures,
      beforePlan,
      modifyPlan: parsed.plan,
    })
  }

  // Shared structural-rebuild tail (§6): clear → executeLayoutPlan →
  // checklist furnishing → deferred furniture ops → manual-item replay →
  // snapshot refresh → diagnostics/gates/reply. Used by both the local
  // absorption removal and the stability re-partition path.
  private async rebuildScenePlanFirst(options: {
    session: WorkflowSession
    sceneId: string
    loadedVersion: number | null
    trace: ReturnType<typeof startPhaseTrace>
    traceMcp: McpCaller
    beforeCall: () => void
    zones: ZoneSummary[]
    intent: LayoutIntent
    plan: LayoutPlan
    planNotes: string[]
    strategy: StrategyDecision
    furnitureOps: FurnitureModifyOp[]
    skippedFurnitureOps: SkippedFurnitureOp[]
    appliedNotes: string[]
    baselineGateFailures: GateFailure[]
    beforePlan: LayoutPlan
    modifyPlan: ModifyPlan
  }): Promise<Partial<WorkflowGraphState>> {
    const {
      session, sceneId, loadedVersion, trace, traceMcp, beforeCall,
      zones, intent, plan, planNotes, strategy, furnitureOps, skippedFurnitureOps, appliedNotes,
      baselineGateFailures,
      beforePlan,
      modifyPlan,
    } = options
    const nodes = snapshotSceneNodes(toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})))
    const levelId = Object.entries(nodes).find(([, node]) => node.type === 'level')?.[0] ?? null
    if (!levelId) {
      return this.finishSafeModificationRejection(
        session,
        t(session.language, 'modifyRebuildUnavailable', {}),
      )
    }
    // §6 manual-item replay: items outside the furniture checklist (decor,
    // user-picked extras) don't come back through the furnishing pass —
    // capture them (with their pre-rebuild room) before everything is
    // cleared, re-place them after.
    const manualItems: ManualItem[] = Object.values(nodes).flatMap(node => {
      if (node.type !== 'item') return []
      const value = node as {
        name?: unknown
        position?: unknown
        asset?: { id?: unknown; name?: unknown; dimensions?: unknown; attachTo?: unknown }
      }
      const assetId = typeof value.asset?.id === 'string' ? value.asset.id : null
      const position = value.position
      if (!assetId || !Array.isArray(position) || position.length !== 3) return []
      if (value.asset?.attachTo === 'wall' || value.asset?.attachTo === 'ceiling') return []
      const name = typeof value.name === 'string' && value.name
        ? value.name
        : typeof value.asset?.name === 'string' ? value.asset.name : assetId
      if (isChecklistItem(name)) return []
      const dims = Array.isArray(value.asset?.dimensions) && value.asset.dimensions.length === 3
        ? value.asset.dimensions as [number, number, number]
        : [1, 1, 1] as [number, number, number]
      const home = zones.find(zone => pointInPolygon(position[0] as number, position[2] as number, zone.polygon))
      if (!home) return []
      return [{ catalogItemId: assetId, name, dimensions: dims, roomName: home.name }]
    })
    const clearTypes = new Set(['zone', 'wall', 'slab', 'ceiling', 'item'])
    session.destructiveSceneWriteStarted = true
    this.persistSession(session)
    this.destructiveWrites.add(session.sessionId)
    try {
      for (const [id, node] of Object.entries(nodes)) {
        if (!clearTypes.has(String(node.type))) continue
        try {
          await traceMcp('delete_node', { id, cascade: true })
        } catch {
          // Swallowed on purpose: usually the node was already removed by an
          // earlier cascade. Real failures are caught by the re-check below —
          // building the new plan on top of leftovers would mix old and new
          // structure into an unrecoverable hybrid.
        }
      }
    } catch (error) {
      throw new DestructiveSceneWriteError(sceneId, error)
    }
    const leftover = Object.values(
      snapshotSceneNodes(toolPayload(await this.callMcp(session.sessionId, 'get_scene', {}))),
    ).filter(node => clearTypes.has(String(node.type)))
    if (leftover.length > 0) {
      throw new DestructiveSceneWriteError(
        sceneId,
        new Error(`清除旧结构失败：${leftover.length} 个节点未能删除`),
      )
    }
    const built = await executeLayoutPlan({
      plan,
      levelId,
      callMcp: traceMcp,
      dedupeSharedWalls: () => this.dedupeSharedWalls(session.sessionId, levelId),
      beforeCall,
      onRoomCreated: created => this.spaceService.recordBuiltRoom(sceneId, created),
    })
    const furnitureRooms: FurnitureRoom[] = plan.rooms.map(planRoom => ({
      id: planRoom.id,
      name: planRoom.name,
      type: planRoom.type,
      polygon: planRoom.polygon,
      zoneId: built.rooms.find(entry => entry.planRoomId === planRoom.id)?.zoneId ?? null,
    }))
    const furnished = await executeFurniturePlan({
      rooms: furnitureRooms,
      connections: plan.connections,
      levelId,
      callMcp: traceMcp,
      beforeCall,
      market: resolveNormProfile(this.config.normProfile).id,
    })
    // Deferred furniture ops run against the rebuilt rooms.
    let furnReport: FurnitureModifyReport | null = null
    if (furnitureOps.length > 0) {
      furnReport = await executeFurnitureModifyOps({
        ops: furnitureOps,
        rooms: furnitureRooms,
        levelId,
        callMcp: traceMcp,
        beforeCall,
      })
    }
    const skippedResults = skippedFurnitureResults(skippedFurnitureOps)
    if (skippedResults.length > 0) {
      furnReport = {
        results: [...(furnReport?.results ?? []), ...skippedResults],
        executionIssues: furnReport?.executionIssues ?? [],
        writeEffect: furnReport?.writeEffect ?? 'no_write',
      }
    }
    const replay = await replayManualItems({
      items: manualItems,
      rooms: furnitureRooms,
      levelId,
      callMcp: traceMcp,
      beforeCall,
    })
    // R1.3: the clear+rebuild always committed real writes (destructive delete
    // + create_room); fold in every executor's side-effect verdict. This path
    // also flags destructiveSceneWriteStarted, so the failure wording stays
    // destructive regardless — but keep the effect coherent for consistency.
    session.modificationWriteEffect = combineWriteEffects(
      'write_confirmed',
      built.writeEffect,
      furnished.writeEffect,
      furnReport?.writeEffect,
      replay.writeEffect,
    )
    // P1: a deferred furniture write whose result is unknown must not complete
    // normally — throw so the (destructive) result-unknown reply fires instead
    // of saving a scene whose final state is uncertain.
    this.throwIfWriteUncertain(session.modificationWriteEffect, [
      ...built.executionIssues,
      ...(furnReport?.executionIssues ?? []),
      ...replay.executionIssues,
    ])
    // P2-A: verify the built structure against the ACTUAL zones FIRST. Only
    // once the scene provably matches `plan` do we refresh the session snapshot
    // to it — otherwise an incomplete build would leave the session holding the
    // ideal plan instead of the real, partial scene.
    const actualZonesPayload = toolPayload(await this.callMcp(session.sessionId, 'get_zones', {}))
    const actualZones = Array.isArray(actualZonesPayload.zones)
      ? actualZonesPayload.zones.filter(isZoneSummary)
      : []
    const executedFindings = await this.recordPreservationFindings(
      session,
      validateExecutedPlan(plan, actualZones),
    )
    if (executedFindings.length > 0) {
      throw new ModificationVerificationError(executedFindings.map(finding => finding.code))
    }
    // R5.2/R5.3: structure confirmed to match `plan` — refresh the session
    // snapshot NOW, before the furniture postcondition verification below, which
    // may throw. If it does, the session still reflects the rebuilt structure
    // (verified accurate above), never the pre-change one; otherwise the next
    // modify would compute against a snapshot conflicting with the actual scene.
    session.zoneRoomTypes = Object.fromEntries(
      furnitureRooms.filter(room => room.zoneId !== null).map(room => [room.zoneId as string, room.type]),
    )
    session.layoutIntent = intent
    session.layoutPlan = plan
    session.strategy = strategy
    // The room program is now user-edited: gates judge against the intent
    // from here on (see gateTargetsForSession).
    session.programEditedByModify = true
    this.persistSession(session)
    await this.verifyModificationPostconditions(session, validateModificationPostconditions({
      before: beforePlan,
      after: plan,
      plan: modifyPlan,
      furnitureReport: furnReport,
    }))
    trace.converged = true
    try {
      const result = await this.finishPlanFirstModify(session, sceneId, loadedVersion, trace, {
        okDetails: [
          ...appliedNotes,
          ...planNotes,
          ...(furnReport?.results.filter(r => r.ok).map(r => r.detail) ?? []),
          ...replay.replaced.map(name => `手动家具「${name}」已在重建后重新放置`),
        ],
        failedDetails: [
          ...built.executionIssues,
          ...furnished.missing.map(entry => `「${entry.room}」缺少${entry.label}：${entry.reason}`),
          ...furnished.executionIssues,
          ...(furnReport?.results.filter(r => !r.ok).map(r => r.detail) ?? []),
          ...replay.lost.map(entry => `手动家具「${entry.name}」未能重放：${entry.reason}`),
          ...replay.executionIssues,
        ],
        previousVersion: loadedVersion,
        baselineGateFailures,
        intentRemovals: furnReport?.results.flatMap(result => (result.removed ? [result.removed] : [])) ?? [],
      })
      this.destructiveWrites.delete(session.sessionId)
      delete session.destructiveSceneWriteStarted
      delete session.modificationWriteEffect
      return result
    } catch (error) {
      if (error instanceof DestructiveSceneWriteError) throw error
      throw new DestructiveSceneWriteError(sceneId, error)
    }
  }

  private async findLevelId(session: WorkflowSession): Promise<string | null> {
    const nodes = snapshotSceneNodes(toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})))
    return Object.entries(nodes).find(([, node]) => node.type === 'level')?.[0] ?? null
  }

  // Deterministic rejection (docs/MODIFY_REDESIGN.md §2): the edit itself is
  // invalid (unresolvable room, fatal area bound, infeasible partition) —
  // tell the user why instead of falling back to the legacy free-edit path,
  // which would "solve" it by violating the same constraint.
  private rejectPlanFirstModify(
    session: WorkflowSession,
    errors: string[],
  ): Partial<WorkflowGraphState> {
    delete session.pendingModification
    delete session.pendingOperation
    delete session.pendingModificationMode
    delete session.pendingModificationReasonCode
    delete session.pendingModificationPlanHash
    delete session.pendingModifyPlan
    delete session.pendingClearTargets
    delete session.modifyModeConfirmed
    delete session.modifyDriftConfirmed
    delete session.modificationWriteEffect
    session.phase = modifyFailureRecovery(false, Boolean(session.sceneResult)).phase
    const reply = t(session.language, 'modifyFailedNoRetry', { error: errors.join('；') })
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }

  private finishSafeModificationRejection(
    session: WorkflowSession,
    reply: string,
  ): Partial<WorkflowGraphState> {
    delete session.pendingModification
    delete session.pendingOperation
    delete session.pendingModificationMode
    delete session.pendingModificationReasonCode
    delete session.pendingModificationPlanHash
    delete session.pendingModifyPlan
    delete session.pendingClearTargets
    delete session.modifyModeConfirmed
    delete session.modifyDriftConfirmed
    delete session.modificationWriteEffect
    session.phase = session.sceneResult?.remainingIssueCount ? 'completed_with_issues' : 'completed'
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }

  private async finishPlanFirstModify(
    session: WorkflowSession,
    sceneId: string,
    loadedVersion: number | null,
    trace: { toolCounts: Record<string, number> },
    results: {
      okDetails: string[]
      failedDetails: string[]
      previousVersion?: number | null
      // §6 三修 gates 归责：修改前的失败基线 + 本次按用户要求删除的家具，
      // 见 effectiveGateFailures。
      baselineGateFailures: GateFailure[]
      intentRemovals?: IntentRemoval[]
      // P2: whether this turn actually wrote to the scene. A zero-write failure
      // (nothing found / no catalog match / no legal position) must NOT call
      // save_scene — the acceptance requires zero write-tool calls on a safe
      // failure. Defaults to true for paths that always write (rebuild/rename).
      sceneWasWritten?: boolean
    },
  ): Promise<Partial<WorkflowGraphState>> {
    const diagnostics = await this.collectDiagnostics(session, 'modify')
    // P2: skip the persistence write entirely when nothing was written to the
    // scene — otherwise a purely-failed furniture turn still bumps a version.
    const sceneVersion = results.sceneWasWritten === false
      ? loadedVersion
      : await this.persistScene(
        session.sessionId,
        sceneId,
        diagnostics.validation.valid,
        loadedVersion,
      )
    const gates = await this.evaluateGates(session, 'modify')
    const { effective, waived } = effectiveGateFailures(
      gates.report.failures,
      results.baselineGateFailures,
      results.intentRemovals ?? [],
    )
    // Failed ops surface through the furniture-issue channel; successful op
    // details ride the reply below (zh internal strings, same policy as the
    // executor reports).
    const furnitureIssues = results.failedDetails
    const remainingIssueCount = countAllIssues(diagnostics, furnitureIssues)
    session.sceneResult = {
      sceneId,
      editorUrl: publicEditorUrl(sceneId),
      version: sceneVersion,
      validation: diagnostics.validation,
      verificationIssues: diagnostics.verificationIssues,
      collisions: diagnostics.collisions,
      doorlessRooms: diagnostics.doorlessRooms,
      strayWindows: diagnostics.strayWindows,
      requirementMismatches: diagnostics.requirementMismatches,
      isolatedBedrooms: diagnostics.isolatedBedrooms,
      furnitureIssues,
      furniturePlacement: diagnostics.furniturePlacementIssues,
      repairRounds: 0,
      remainingIssueCount,
      modelCallsUsed: (session.toolTrace ?? []).reduce((sum, entry) => sum + entry.modelCalls, 0),
      gateFailures: effective.map(failure => failure.message),
      layoutQuality: gates.layoutQuality,
    }
    session.phase = remainingIssueCount === 0 && effective.length === 0
      ? 'completed'
      : 'completed_with_issues'
    delete session.pendingModification
    delete session.pendingOperation
    delete session.pendingModificationMode
    delete session.pendingModificationReasonCode
    delete session.pendingModificationPlanHash
    delete session.pendingModifyPlan
    delete session.pendingClearTargets
    delete session.modifyModeConfirmed
    delete session.modifyDriftConfirmed
    delete session.modificationWriteEffect
    const base = buildCompletionReply({
      lang: session.language ?? 'en',
      successText: t(session.language, 'modifySuccess', {}),
      repairRounds: 0,
      diagnostics,
      toolNamesUsed: new Set(Object.keys(trace.toolCounts)),
      furnitureIssues,
      gateFailures: effective,
    })
    const okDetails = results.okDetails.map(detail => `- ${detail}`)
    // Waived failures (pre-existing or user-requested removals) surface as
    // one neutral line — visible, but never re-litigated as this turn's fault.
    const waivedNote = waived.length > 0
      ? [t(session.language, 'modifyGatesWaived', { count: waived.length })]
      : []
    // §6 版本安全: the pre-change version rides the reply so the user can
    // roll a structural rebuild back through the store's version history.
    const versionNote = typeof results.previousVersion === 'number'
      ? [t(session.language, 'modifyPreviousVersion', { version: results.previousVersion })]
      : []
    const reply = [base, ...okDetails, ...waivedNote, ...versionNote].join('\n')
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }

  private async answerSceneQuestion(session: WorkflowSession, question: string): Promise<string> {
    const readOnlyTools = new Set([
      'get_scene',
      'get_node',
      'describe_node',
      'measure',
      'get_level_summary',
      'get_walls',
      'get_zones',
      'find_nodes',
      'validate_scene',
      'verify_scene',
      'check_collisions',
    ])
    const tools = (await this.mcp.listOpenAiTools()).filter(tool =>
      readOnlyTools.has(tool.function.name),
    )
    // Exclude the last entry: it's `question` itself, already pushed to
    // session.messages by routeExistingSceneRequest before this runs.
    const history = recentConversationBlock(session.messages.slice(0, -1))
    const prompt = renderPrompt('inspect', { history, question })
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.parts.system },
      { role: 'user', content: prompt.parts.user },
    ]
    for (let round = 0; round < this.config.maxToolRounds; round++) {
      this.throwIfCancelled(session.sessionId)
      const completion = await this.withModelFallback(session.sessionId, (model, hooks) =>
        model.chat(messages, tools, `${session.sessionId}:inspect`, {
          ...hooks,
          operation: 'inspect',
          ...promptAudit(prompt),
        }),
      )
      const assistant = completion.choices[0]?.message
      if (!assistant) throw new Error('Model API returned no assistant message')
      messages.push({
        role: 'assistant',
        content: assistant.content ?? null,
        tool_calls: assistant.tool_calls,
      })
      if (!assistant.tool_calls?.length) {
        return assistant.content?.trim() || '已完成场景核对，但模型没有返回说明。'
      }
      for (const toolCall of assistant.tool_calls) {
        messages.push(await this.executeToolCall(session.sessionId, toolCall))
      }
    }
    return '已核对当前场景，但查询步骤超过限制；场景没有被修改。'
  }

  private async extractRequirements(
    session: WorkflowSession,
    message: string,
    imageDataUrl?: string,
  ): Promise<ExtractionResponse> {
    const prompt = renderPrompt('extract', {
      briefJson: JSON.stringify(session.brief),
      message: message || '无附带文字',
      inputType: imageDataUrl
        ? '单张户型图；图片是现状依据，文字是目标或指令。请尽量从图中识别墙体、门、窗、房间及其大致布局/尺寸，作为 existingCondition 现状事实（识别不确定的放入 uncertainties，不要写成用户确认的事实）'
        : '纯文字需求',
    })

    // Retry once on malformed JSON — this call is exactly the kind of
    // strict-JSON-mode request that
    // occasionally fails format compliance (more so with an image attached),
    // and previously a single hiccup killed the whole turn.
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptPrompt = attempt > 0
        ? `${prompt.parts.user}\n${prompt.parts.retry}`
        : prompt.parts.user
      const content: ChatMessage['content'] = imageDataUrl
        ? [
            { type: 'text', text: attemptPrompt },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
          ]
        : attemptPrompt

      try {
        return await this.withModelFallback(session.sessionId, (model, hooks) =>
          model.json<ExtractionResponse>(
            [
              { role: 'system', content: prompt.parts.system },
              { role: 'user', content },
            ],
            `${session.sessionId}:extract:${attempt}`,
            { ...hooks, operation: 'extract', ...promptAudit(prompt) },
          ).then(result => result.output),
        )
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * Fetch and cache the MCP `pascal://agent-guide` resource text for the
   * lifetime of this process. Returns undefined (never throws) if the MCP
   * server has no such resource or the read fails for any reason.
   */
  private getAgentGuide(): Promise<string | undefined> {
    if (!this.agentGuidePromise) {
      this.agentGuidePromise = this.mcp.readResourceText('pascal://agent-guide').catch(() => undefined)
    }
    return this.agentGuidePromise
  }

  private async buildSceneAgentPrompt(
    purpose: string,
    history: string,
    brief: string,
  ): Promise<RenderedPrompt<'scene-agent'>> {
    const guide = await this.getAgentGuide()
    const sceneCreationRules = guide ? extractMarkdownSection(guide, 'Scene Creation Rules') : undefined
    return renderPrompt('scene-agent', {
      guide: sceneCreationRules ?? '',
      purpose,
      history,
      brief,
    })
  }

  private async runSceneAgent(
    session: WorkflowSession,
    purpose: string,
    conversation?: ChatMessage[],
    toolNamesUsed: Set<string> = new Set(),
    furnitureIssues: string[] = [],
    trace?: PhaseToolTrace,
    auditPrompt?: PromptAuditMetadata,
  ): Promise<{
    messages: ChatMessage[]
    converged: boolean
    toolNamesUsed: Set<string>
    furnitureIssues: string[]
  }> {
    const allowedTools = new Set([
      'load_scene',
      'get_scene',
      'get_node',
      'describe_node',
      'measure',
      'get_level_summary',
      'list_levels',
      'get_walls',
      'get_zones',
      'find_nodes',
      'search_assets',
      'create_level',
      'create_story_shell',
      'create_room',
      'add_door',
      'add_window',
      'furnish_room',
      'place_item',
      'set_zone',
      'apply_patch',
      'delete_node',
      'validate_scene',
      'verify_scene',
      'check_collisions',
    ])
    const tools = (await this.mcp.listOpenAiTools()).filter(tool =>
      allowedTools.has(tool.function.name),
    )
    // Reuse the caller's conversation when provided so this call remembers
    // what earlier phases/repair rounds already tried, instead of starting
    // from a blank slate every time.
    const isNewThread = !conversation
    const historyBlock = isNewThread ? recentConversationBlock(session.messages) : ''
    const prompt = await this.buildSceneAgentPrompt(
      purpose,
      historyBlock,
      session.summary || formatSummary(session.brief),
    )
    const messages: ChatMessage[] = conversation ?? [
      {
        role: 'system',
        content: prompt.parts.system,
      },
    ]
    // Only inject conversation history when this call starts a fresh thread
    // (repair rounds and later phases already carry it forward in `messages`
    // itself, so repeating it every round would just waste tokens).
    messages.push({
      role: 'user',
      content: prompt.parts.user,
    })

    for (let round = 0; round < this.config.maxToolRounds; round++) {
      this.throwIfCancelled(session.sessionId)
      const completion = await this.withModelFallback(session.sessionId, (model, hooks) =>
        model.chat(messages, tools, `${session.sessionId}:scene`, {
          ...hooks,
          operation: 'scene-agent',
          ...promptAudit(auditPrompt ?? prompt),
        }),
      )
      const assistant = completion.choices[0]?.message
      if (!assistant) throw new Error('Model API returned no assistant message')
      if (trace) trace.modelCalls++
      messages.push({
        role: 'assistant',
        content: assistant.content ?? null,
        tool_calls: assistant.tool_calls,
      })
      if (!assistant.tool_calls?.length) {
        return { messages, converged: true, toolNamesUsed, furnitureIssues }
      }
      for (const toolCall of assistant.tool_calls) {
        toolNamesUsed.add(toolCall.function.name)
        const toolMessage = await this.executeToolCall(session.sessionId, toolCall, furnitureIssues)
        if (trace) recordTraceToolCall(trace, toolCall, toolMessage)
        messages.push(toolMessage)
      }
    }
    return { messages, converged: false, toolNamesUsed, furnitureIssues }
  }

  // A phase that hits `maxToolRounds` without the model emitting a final
  // (tool-call-free) message is *not* done — it just ran out of turns
  // mid-task. Retrying with a fresh nudge, reusing the same conversation so
  // the model can see what it already built, gives it a bounded chance to
  // actually finish instead of silently being recorded as "completed".
  private static readonly PHASE_CONTINUATION_ATTEMPTS = 1

  private async runPhaseToConvergence(
    session: WorkflowSession,
    purpose: string,
    conversation: ChatMessage[] | undefined,
    toolNamesUsed: Set<string>,
    furnitureIssues: string[],
    phaseLabel: string,
  ): Promise<{ messages: ChatMessage[]; toolNamesUsed: Set<string>; furnitureIssues: string[] }> {
    const trace = startPhaseTrace(session, phaseLabel)
    let result = await this.runSceneAgent(session, purpose, conversation, toolNamesUsed, furnitureIssues, trace)
    let attempt = 0
    while (!result.converged && attempt < PascalAiAgent.PHASE_CONTINUATION_ATTEMPTS) {
      attempt++
      trace.continuationAttempts = attempt
      const continuation = renderPrompt('scene-agent', {
        guide: '',
        purpose,
        history: '',
        brief: '',
      })
      result = await this.runSceneAgent(
        session,
        continuation.parts.continuation,
        result.messages,
        result.toolNamesUsed,
        result.furnitureIssues,
        trace,
        continuation,
      )
    }
    trace.converged = result.converged
    if (!result.converged) {
      throw new Error(`${phaseLabel}在 ${PascalAiAgent.PHASE_CONTINUATION_ATTEMPTS + 1} 轮尝试后仍未收敛完成`)
    }
    return { messages: result.messages, toolNamesUsed: result.toolNamesUsed, furnitureIssues: result.furnitureIssues }
  }

  // `create_house_from_brief` only picks the closest of its 3 built-in
  // templates (its own tool description says as much for 3+ bedroom
  // requests), so it rarely matches an arbitrary room list. We use it purely
  // for project/site/building/level scaffolding and always clear its
  // template rooms so `constructSceneInPhases`'s structure phase can build
  // the actual layout room-by-room through MCP's own recommended tool
  // sequence (create_story_shell once, then create_room per room with
  // get_zones checked in between) instead of us precomputing geometry.
  // Count nodes in the currently-loaded scene that represent actual content
  // (walls, rooms, zones, openings, items, ...) as opposed to the structural
  // scaffolding every project has. Used to tell an empty project apart from
  // one the user has already put work into.
  private async countActiveContentNodes(sessionId: string): Promise<number> {
    const scene = toolPayload(await this.callMcp(sessionId, 'get_scene', {}))
    const nodes = isRecord(scene.nodes) ? scene.nodes : {}
    let count = 0
    for (const node of Object.values(nodes)) {
      if (isRecord(node) && typeof node.type === 'string' && !SCAFFOLDING_NODE_TYPES.has(node.type)) {
        count++
      }
    }
    return count
  }

  private async clearLevelForRebuild(session: WorkflowSession, levelId: string | null): Promise<void> {
    if (!levelId) throw new Error('Target level is missing')
    try {
      await clearLevelChildren((name, args) => this.callMcp(session.sessionId, name, args), levelId)
    } catch (error) {
      session.executionSteps?.push({ phase: 'structure', status: 'failed', label: '清空模板占位内容' })
      throw error
    }
  }

  // Safety cap on the resolve-one-overlap-and-rescan loop below. Wall counts
  // here are small (a handful of rooms, a handful of edges each), so this is
  // never expected to bind — it exists only to guarantee termination if some
  // pathological input kept producing new overlapping fragments forever.
  private static readonly MAX_DEDUPE_ITERATIONS = 500

  /**
   * Remove redundant/overlapping walls left behind by room-by-room
   * `create_room` calls (see the comment at the call site for why these
   * exist). Runs before the openings phase, so no wall here can host a door
   * or window yet — deleting/splitting freely is safe because zone/slab/
   * ceiling nodes carry their own polygon and never reference a wall by id.
   *
   * Two rooms built independently and sharing a full boundary produce two
   * walls with identical endpoints — the simple case. But a T junction
   * (one room's long edge bordering two or more smaller neighboring rooms)
   * produces a long wall whose interval only *partially* overlaps each of
   * several shorter walls, with no shared endpoints at all — exact endpoint
   * matching misses this entirely. We resolve overlaps by collinear-interval
   * comparison instead: for any two collinear walls whose intervals overlap
   * by more than a sliver, the shorter (more specific) one is kept as-is and
   * the longer one is clipped — split into whatever fragments of itself fall
   * outside the overlap, with the original deleted. Repeating this against
   * the growing/shrinking wall set until no overlaps remain correctly
   * collapses an N-way T junction, not just a single pair.
   *
   * Best-effort: on any failure we skip silently rather than fail the whole
   * generation over a cleanup pass — worst case is the pre-existing
   * double-wall behavior, not a broken scene.
   *
   * `protectedWallIds` (modify path): walls that existed before this turn are
   * READ-ONLY for the dedupe — when a new wall coincides with an original,
   * the new wall is the one deleted/clipped regardless of length, and a pair
   * of original walls is never touched at all. Fresh generation passes no
   * protected set and keeps the original shorter-wall-wins behavior.
   */
  private async dedupeSharedWalls(
    sessionId: string,
    levelId: string | null,
    protectedWallIds?: Set<string>,
  ): Promise<void> {
    if (!levelId) return
    try {
      const payload = toolPayload(await this.callMcp(sessionId, 'get_walls', { levelId }))
      const walls = Array.isArray(payload.walls) ? payload.walls.filter(isWallSummary) : []

      type WorkingWall = WallSummary & { isFragment: boolean }
      let working: WorkingWall[] = walls.map(w => ({ ...w, isFragment: false }))
      const deletedRealIds = new Set<string>()
      let fragmentCounter = 0

      let changed = true
      let iterations = 0
      while (changed && iterations < PascalAiAgent.MAX_DEDUPE_ITERATIONS) {
        changed = false
        iterations++
        resolvePass: for (let i = 0; i < working.length; i++) {
          for (let j = i + 1; j < working.length; j++) {
            const a = working[i]!
            const b = working[j]!
            const overlap = collinearOverlap(a, b)
            if (!overlap) continue
            const aProtected = !a.isFragment && protectedWallIds?.has(a.id) === true
            const bProtected = !b.isFragment && protectedWallIds?.has(b.id) === true
            // Two original walls overlapping is pre-existing state this
            // cleanup must not "fix" during a modification.
            if (aProtected && bProtected) continue
            const oa = segmentOrientation(a)!
            const ob = segmentOrientation(b)!
            const lenA = oa.hi - oa.lo
            const lenB = ob.hi - ob.lo
            const overlapLen = overlap.hi - overlap.lo
            const aFullyCovered = overlapLen >= lenA - MIN_MEANINGFUL_OVERLAP_M
            const bFullyCovered = overlapLen >= lenB - MIN_MEANINGFUL_OVERLAP_M

            if (aFullyCovered && bFullyCovered) {
              // Exact duplicate within tolerance — drop the unprotected one
              // (b by default, matching the original keep-a behavior).
              const dropIndex = aProtected ? j : bProtected ? i : j
              const dropped = working[dropIndex]!
              if (!dropped.isFragment) deletedRealIds.add(dropped.id)
              working.splice(dropIndex, 1)
              changed = true
              break resolvePass
            }

            // A protected wall is always the one kept; otherwise keep the
            // shorter (more specific) wall untouched and clip the longer one
            // down to whatever remains outside the overlap.
            const keepIsA = aProtected ? true : bProtected ? false : lenA <= lenB
            const clip = keepIsA ? b : a
            const clipIdx = keepIsA ? j : i
            const clipOrientation = keepIsA ? ob : oa

            const fragments: Array<[number, number]> = []
            if (overlap.lo - clipOrientation.lo > MIN_MEANINGFUL_OVERLAP_M) {
              fragments.push([clipOrientation.lo, overlap.lo])
            }
            if (clipOrientation.hi - overlap.hi > MIN_MEANINGFUL_OVERLAP_M) {
              fragments.push([overlap.hi, clipOrientation.hi])
            }

            if (!clip.isFragment) deletedRealIds.add(clip.id)
            working.splice(clipIdx, 1)
            for (const [lo, hi] of fragments) {
              fragmentCounter++
              const seg = orientationToSegment({ axis: clipOrientation.axis, constant: clipOrientation.constant, lo, hi })
              working.push({
                id: `dedupe_frag_${fragmentCounter}`,
                start: seg.start,
                end: seg.end,
                thickness: clip.thickness,
                height: clip.height,
                name: clip.name,
                isFragment: true,
              })
            }
            changed = true
            break resolvePass
          }
        }
      }

      const patches: Array<Record<string, unknown>> = []
      for (const id of deletedRealIds) {
        patches.push({ op: 'delete', id, cascade: true })
      }
      for (const wall of working) {
        if (!wall.isFragment) continue
        patches.push({
          op: 'create',
          node: {
            type: 'wall',
            start: wall.start,
            end: wall.end,
            ...(wall.thickness !== undefined ? { thickness: wall.thickness } : {}),
            ...(wall.height !== undefined ? { height: wall.height } : {}),
            ...(wall.name !== undefined ? { name: wall.name } : {}),
            metadata: { mcpTool: 'pascal-ai-mcp:dedupeSharedWalls' },
          },
          parentId: levelId,
        })
      }
      if (patches.length > 0) {
        await this.callMcp(sessionId, 'apply_patch', { patches })
      }
    } catch {
      // Best-effort cleanup — see doc comment above.
    }
  }

  // Steps ①–③ of the plan-first flow: one trace entry so eval reports can
  // see exactly how many completions planning took and whether it converged.
  private async buildPlanForSession(
    session: WorkflowSession,
    priorFailures?: string[],
  ): Promise<PlanBuildResult> {
    const trace = startPhaseTrace(
      session,
      priorFailures?.length ? '重规划阶段（注入验收失败事实）' : '规划阶段（Intent→分区→校验）',
    )
    // Experimental comparison path (§2 意见②): model-authored geometry
    // through the same validator. Deliberately an env flag, not AppConfig —
    // it exists to measure partitioner-vs-LLM layout quality, not to ship.
    const llmGeometry = process.env.AI_PLAN_LLM_GEOMETRY === '1'
    const temperature = llmGeometry
      ? this.config.aiTemperatureGeometry
      : this.config.aiTemperatureIntent
    const profile = resolveNormProfile(this.config.normProfile)
    const briefSummary = session.summary || formatSummary(session.brief)
    const targets = buildPlanTargets(session.brief)
    // Deterministic strategy decision (LAYOUT_STRATEGY_DESIGN.md §2) —
    // persisted on the session so modify turns and eval reports can see what
    // was decided and why.
    const strategy = deriveStrategy(briefFactsFor(session.brief, briefSummary), targets, profile)
    const directEligibility = directTemplateEligibility(session.brief, targets, strategy)
    session.strategy = strategy
    const result = await buildLayoutPlan(
      {
        briefSummary,
        targets,
      },
      async (messages, tag, prompt) => {
        this.throwIfCancelled(session.sessionId)
        trace.modelCalls++
        return this.withModelFallback(session.sessionId, (model, hooks) =>
          model.complete(messages, `${session.sessionId}:${tag}`, {
            ...hooks,
            // plan-builder tags carry the round number ("plan:intent:2") —
            // strip it so the label stays aggregatable.
            operation: tag.replace(/:\d+$/, ''),
            ...promptAudit(prompt),
            temperature,
          }).then(result => result.output),
        )
      },
      {
        llmGeometry,
        profile,
        strategy,
        directTemplateEligible: directEligibility.eligible,
        templatesDir: this.config.templatesDir,
        ...(priorFailures?.length ? { priorFailures } : {}),
      },
    )
    trace.converged = result.ok
    if (result.seedTrace?.length) trace.notes = result.seedTrace
    const requestContext = this.activeRequestContexts.get(session.sessionId)
    if (result.templateTrace && requestContext) {
      try {
        this.audits.recordTemplateMatch({
          decisionId: crypto.randomUUID(),
          requestId: requestContext.requestId,
          ...(requestContext.workflowRunId
            ? { workflowRunId: requestContext.workflowRunId }
            : {}),
          sessionId: session.sessionId,
          ...result.templateTrace,
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        console.error(
          `[template-audit] requestId=${requestContext.requestId} persistence=failed`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    await this.runValidationStage(session, 'plan', result.ok
      ? { layoutPlan: { plan: result.plan, targets, profile, validation: result.validation } }
      : { layoutPlanFailure: { failureCount: result.failures.length } })
    return result
  }

  // §5 completion hard gates + layout quality, judged on the ACTUAL scene
  // state. Used by fresh generation, the rebuild decision, and modify (§6
  // 接线 2: 门槛是场景性质，与怎么建出来无关).
  private resolveZoneTypes(session: WorkflowSession, zones: ZoneSummary[]): Record<string, RoomType> {
    try {
      return this.spaceService.resolveRoomTypes(
        session.sceneId,
        zones.map(zone => ({ id: zone.id, name: zone.name })),
        session.zoneRoomTypes,
      )
    } catch (error) {
      console.error(`scene-space projection read failed: ${errorMessage(error)}`)
      return {
        ...Object.fromEntries(zones.map(zone => [zone.id, classifyRoomTypeByName(zone.name)])),
        ...(session.zoneRoomTypes ?? {}),
      }
    }
  }

  private async evaluateGates(
    session: WorkflowSession,
    stage: ValidationStage = 'verification',
  ): Promise<{
    report: GateReport
    layoutQuality: number
  }> {
    let sources: [unknown, unknown, unknown]
    try {
      sources = await Promise.all([
        this.callMcp(session.sessionId, 'get_zones', {}),
        this.callMcp(session.sessionId, 'get_walls', {}),
        this.callMcp(session.sessionId, 'get_level_summary', {}),
      ])
    } catch (error) {
      await this.runValidationStage(session, stage, {
        unavailable: {
          validatorId: VALIDATOR_IDS.completionGates,
          reason: validationUnavailableReason(error),
        },
      })
      throw error
    }
    const [zonesRaw, wallsRaw, summaryRaw] = sources
    const zonesPayload = toolPayload(zonesRaw)
    const wallsPayload = toolPayload(wallsRaw)
    const summaryPayload = toolPayload(summaryRaw)
    const zones = Array.isArray(zonesPayload.zones) ? zonesPayload.zones.filter(isZoneSummary) : []
    const zoneTypes = this.resolveZoneTypes(session, zones)
    const walls: GateWall[] = Array.isArray(wallsPayload.walls)
      ? wallsPayload.walls.filter(isWallWithOpenings)
      : []
    const items = Array.isArray(summaryPayload.items) ? summaryPayload.items.filter(isItemSummary) : []
    // Gates judge the scene against the CURRENT requirement truth: the
    // intent snapshot for plan-first scenes (modify ops edit it — after a
    // confirmed remove_room the old brief must not keep failing gate 1/2
    // forever), the brief for legacy scenes.
    const planTargets = gateTargetsForSession(session)
    const requiredWindowRoomTypes = windowRoomTypesFromBrief(session.brief)
    const completion = {
      zones,
      walls,
      items,
      targets: {
      ...(planTargets.totalAreaSqm !== undefined ? { totalAreaSqm: planTargets.totalAreaSqm } : {}),
      ...(planTargets.requiredRooms ? { requiredRooms: planTargets.requiredRooms } : {}),
      ...(requiredWindowRoomTypes.length > 0 ? { requiredWindowRoomTypes } : {}),
      ...(Object.keys(zoneTypes).length > 0 ? { zoneTypes } : {}),
      market: resolveNormProfile(this.config.normProfile).id,
      },
    }
    const validationResults = await this.runValidationStage(session, stage, { completion })
    const report = validationValue<GateReport>(validationResults, VALIDATOR_IDS.completionGates)
    const layoutQuality = computeLayoutQuality(zones, walls, {
      ...(planTargets.totalAreaSqm !== undefined ? { targetTotalAreaSqm: planTargets.totalAreaSqm } : {}),
      ...(Object.keys(zoneTypes).length > 0 ? { zoneTypes } : {}),
    }).score
    return { report, layoutQuality }
  }

  // Steps ⑤–⑦: deterministic structure + openings from the plan (zero model
  // calls), then the model-driven furnishing pass (batch C replaces it with
  // the deterministic furniture executor), then verification + bounded
  // repair.
  private async constructScenePlanFirst(
    session: WorkflowSession,
    levelId: string | null,
    plan: LayoutPlan,
    options: { persistAfterRound?: (valid: boolean) => Promise<void> } = {},
  ): Promise<{
    diagnostics: Awaited<ReturnType<PascalAiAgent['collectDiagnostics']>>
    repairRounds: number
    toolNamesUsed: Set<string>
    furnitureIssues: string[]
    executionIssues: string[]
    structureViolations: string[]
    gates: GateReport
    layoutQuality: number
    // Gate 1–5 failure messages: the structural class that goes back to the
    // plan layer (§5 失败分流) instead of the free repair loop.
    structuralFailures: string[]
    furnitureCounts: { placed: number; required: number }
  }> {
    session.executionSteps ??= []
    if (!levelId) throw new Error('Target level is missing')
    // The executor phase must show up in the tool trace with modelCalls: 0 —
    // that zero is a batch-B hard metric, asserted by the eval harness.
    const trace = startPhaseTrace(session, '结构与门窗施工（确定性执行器）')
    let report: SceneExecutionReport
    try {
      report = await this.runWorkflowStep(session, 'structure-openings', () => executeLayoutPlan({
        plan,
        levelId,
        callMcp: async (name, args) => {
          const result = await this.callMcp(session.sessionId, name, args)
          trace.toolCounts[name] = (trace.toolCounts[name] ?? 0) + 1
          const detail = name === 'create_room' && typeof args.name === 'string' ? args.name : undefined
          trace.toolCalls.push({ name, ok: true, ...(detail ? { detail } : {}) })
          return result
        },
        dedupeSharedWalls: () => this.dedupeSharedWalls(session.sessionId, levelId),
        beforeCall: () => this.throwIfCancelled(session.sessionId),
        ...(session.sceneId
          ? { onRoomCreated: created => this.spaceService.recordBuiltRoom(session.sceneId!, created) }
          : {}),
      }))
      trace.converged = true
      session.executionSteps.push({ phase: 'structure', status: 'completed', label: '按计划批量建造房间结构' })
      session.executionSteps.push({ phase: 'openings', status: 'completed', label: '按计划开门窗' })
    } catch (error) {
      session.executionSteps.push({ phase: 'structure', status: 'failed', label: '确定性结构与门窗施工' })
      throw error
    }

    // ⑥ Deterministic furnishing (batch C): checklist-driven, zero model
    // calls, same trace contract as the structure executor above.
    const toolNamesUsed = new Set<string>()
    let furnitureIssues: string[] = []
    let furnitureCounts = { placed: 0, required: 0 }
    const furnitureTrace = startPhaseTrace(session, '家具布置（确定性执行器）')
    try {
      await this.runWorkflowStep(session, 'furniture', async () => {
        const furnitureRooms = plan.rooms.map(planRoom => ({
          id: planRoom.id,
          name: planRoom.name,
          type: planRoom.type,
          polygon: planRoom.polygon,
          zoneId: report.rooms.find(built => built.planRoomId === planRoom.id)?.zoneId ?? null,
        }))
        // Authoritative zone types for the gates/diagnostics: with this on the
        // session, room names can be in any language — nothing downstream needs
        // to guess types from 中/日/英 keywords for plan-first builds.
        session.zoneRoomTypes = Object.fromEntries(
          furnitureRooms
            .filter(room => room.zoneId !== null)
            .map(room => [room.zoneId as string, room.type]),
        )
        const furnished = await executeFurniturePlan({
          rooms: furnitureRooms,
          connections: plan.connections,
          levelId,
          callMcp: async (name, args) => {
            const result = await this.callMcp(session.sessionId, name, args)
            furnitureTrace.toolCounts[name] = (furnitureTrace.toolCounts[name] ?? 0) + 1
            const detail = name === 'search_assets' && typeof args.query === 'string'
              ? args.query
              : name === 'place_item' && typeof args.catalogItemId === 'string' ? args.catalogItemId : undefined
            furnitureTrace.toolCalls.push({ name, ok: true, ...(detail ? { detail } : {}) })
            return result
          },
          beforeCall: () => this.throwIfCancelled(session.sessionId),
          market: resolveNormProfile(this.config.normProfile).id,
        })
        furnitureTrace.converged = true
        if (furnished.placed.length > 0) toolNamesUsed.add('place_item')
        furnitureIssues = [
          ...furnished.missing.map(entry => `「${entry.room}」缺少${entry.label}：${entry.reason}`),
          ...furnished.executionIssues,
        ]
        furnitureCounts = {
          placed: furnished.placed.length,
          required: furnished.placed.length + furnished.missing.length,
        }
      })
      session.executionSteps.push({ phase: 'furnishing', status: 'completed', label: '按清单确定性布置家具' })
    } catch (error) {
      session.executionSteps.push({ phase: 'furnishing', status: 'failed', label: '确定性家具布置' })
      throw error
    }

    // §5 失败分流：gates run BEFORE any repair round. A structural failure
    // (gates 1–5) belongs to the plan layer — repairing decorations on a
    // scene that is about to be cleared and rebuilt would only burn model
    // calls, so verification is skipped entirely in that case.
    const preGates = await this.runWorkflowStep(
      session,
      'gates',
      () => this.evaluateGates(session, 'furniture'),
    )
    const structuralFailures = preGates.report.failures
      .filter(failure => failure.gate <= 5)
      .map(failure => failure.message)
    if (structuralFailures.length > 0) {
      const diagnostics = await this.collectDiagnostics(session, 'structure')
      return {
        diagnostics,
        repairRounds: 0,
        toolNamesUsed,
        furnitureIssues,
        executionIssues: report.executionIssues,
        structureViolations: [],
        gates: preGates.report,
        layoutQuality: preGates.layoutQuality,
        structuralFailures,
        furnitureCounts,
      }
    }

    // ⑦ Verification + bounded decorative repair, with the structure lock
    // active. The repair rounds start a fresh model conversation —
    // construction was model-free, so there is no prior thread to continue.
    const result = await this.runWorkflowStep(session, 'verification', () => this.refineAndDiagnose(
      session,
      `验证阶段：核对门窗宿主、家具碰撞和通行性，只修复检查发现的问题；禁止增删、移动或缩放任何房间，禁止改动已开好的门窗。\n${formatPlanSnapshot(plan)}`,
      {
        skipInitialAgent: true,
        toolNamesUsed,
        furnitureIssues,
        lockStructure: true,
        ...(options.persistAfterRound ? { persistAfterRound: options.persistAfterRound } : {}),
      },
    ))
    session.executionSteps.push({
      phase: 'verification',
      status: 'completed',
      label: '验证并自动修正',
    })
    // Re-judge the gates after repairs (repair rounds may have re-hosted a
    // window or refit furniture; the lock guarantees structure is unchanged).
    const postGates = await this.runWorkflowStep(
      session,
      'gates',
      () => this.evaluateGates(session, 'verification'),
    )
    return {
      ...result,
      executionIssues: report.executionIssues,
      gates: postGates.report,
      layoutQuality: postGates.layoutQuality,
      structuralFailures: postGates.report.failures
        .filter(failure => failure.gate <= 5)
        .map(failure => failure.message),
      furnitureCounts,
    }
  }

  private async refineAndDiagnose(
    session: WorkflowSession,
    purpose: string,
    options: {
      skipInitialAgent?: boolean
      conversation?: ChatMessage[]
      toolNamesUsed?: Set<string>
      furnitureIssues?: string[]
      phaseLabel?: string
      // Deterministic task-specific acceptance run alongside every
      // collectDiagnostics pass; returned issue strings are merged into
      // requirementMismatches, so they both trigger repair rounds and appear
      // verbatim in the repair prompt (used by the modification-protection
      // closed loop).
      extraChecks?: () => Promise<string[]>
      // §5 批次 D：repair rounds are decorative-only. When set, a snapshot is
      // taken before the loop; a round that moves/adds/removes structural
      // nodes is undone wholesale and the loop stops.
      lockStructure?: boolean
      // §8 批次 D 每轮 persistScene：called after every repair round with the
      // round's validation state, so each round leaves a saved version.
      persistAfterRound?: (valid: boolean) => Promise<void>
      validationStage?: ValidationStage
    } = {},
  ): Promise<{
    diagnostics: Awaited<ReturnType<PascalAiAgent['collectDiagnostics']>>
    repairRounds: number
    toolNamesUsed: Set<string>
    furnitureIssues: string[]
    structureViolations: string[]
  }> {
    let conversation = options.conversation
    let toolNamesUsed = options.toolNamesUsed ?? new Set<string>()
    let furnitureIssues = options.furnitureIssues ?? []
    if (!options.skipInitialAgent) {
      // Same convergence guarantee as the fresh-generation structure/openings
      // phases: a modify/incremental-edit call that exhausts maxToolRounds
      // mid-task is not done, and must not be silently treated as if it
      // were — otherwise an unfinished edit on an *existing* scene slips
      // through the same way an unfinished fresh build used to.
      const result = await this.runPhaseToConvergence(
        session,
        purpose,
        conversation,
        toolNamesUsed,
        furnitureIssues,
        options.phaseLabel ?? '场景修改',
      )
      conversation = result.messages
      toolNamesUsed = result.toolNamesUsed
      furnitureIssues = result.furnitureIssues
    }
    const withExtraChecks = async (
      diagnostics: Awaited<ReturnType<PascalAiAgent['collectDiagnostics']>>,
    ): Promise<typeof diagnostics> => {
      if (!options.extraChecks) return diagnostics
      const extra = await options.extraChecks()
      if (extra.length === 0) return diagnostics
      return { ...diagnostics, requirementMismatches: [...diagnostics.requirementMismatches, ...extra] }
    }
    const validationStage = options.validationStage ?? 'verification'
    let diagnostics = await this.collectDiagnostics(session, validationStage)
    diagnostics = await this.repairKnownOpeningBounds(diagnostics, session, validationStage)
    diagnostics = await withExtraChecks(diagnostics)
    let repairRounds = 0
    const structureViolations: string[] = []
    let lockSnapshot = options.lockStructure
      ? snapshotSceneNodes(toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})))
      : null
    // Each repair round reuses the same conversation, so the model can see
    // what it already tried and why the previous round's fix didn't fully
    // resolve the diagnostics, instead of re-guessing from scratch.
    while (repairRounds < this.config.maxRepairRounds && countDiagnosticIssues(diagnostics) > 0) {
      this.throwIfCancelled(session.sessionId)
      repairRounds++
      const repairTrace = startPhaseTrace(session, `自动修正第${repairRounds}轮`)
      const repairPrompt = renderPrompt('repair', {
        purpose,
        round: String(repairRounds),
        diagnostics: JSON.stringify(diagnostics),
      })
      const result = await this.runWorkflowStep(
        session,
        `repair:${repairRounds}`,
        () => this.runSceneAgent(
          session,
          repairPrompt.parts.user,
          conversation,
          toolNamesUsed,
          furnitureIssues,
          repairTrace,
          repairPrompt,
        ),
      )
      repairTrace.converged = result.converged
      conversation = result.messages
      toolNamesUsed = result.toolNamesUsed
      furnitureIssues = result.furnitureIssues
      // §5 structure lock: a repair round that touched walls/zones is undone
      // wholesale (one history step per mutating call it made) and the loop
      // ends — structural problems belong to the plan layer, not free repair.
      if (lockSnapshot) {
        const afterSnapshot = snapshotSceneNodes(
          toolPayload(await this.callMcp(session.sessionId, 'get_scene', {})),
        )
        const drift = structuralDrift(lockSnapshot, afterSnapshot)
        if (drift.length > 0) {
          const mutating = repairTrace.toolCalls.filter(call => MUTATING_TOOLS.has(call.name)).length
          if (mutating > 0) {
            try {
              await this.callMcp(session.sessionId, 'undo', { steps: mutating })
            } catch (error) {
              structureViolations.push(`撤销修复轮改动失败：${errorMessage(error)}`)
            }
          }
          structureViolations.push(
            `自动修正第 ${repairRounds} 轮试图改动房间结构（${drift.slice(0, 3).join('；')}${drift.length > 3 ? '……' : ''}），该轮改动已整体撤销`,
          )
          diagnostics = await this.collectDiagnostics(session, validationStage)
          diagnostics = await this.repairKnownOpeningBounds(diagnostics, session, validationStage)
          diagnostics = await withExtraChecks(diagnostics)
          break
        }
        lockSnapshot = afterSnapshot
      }
      diagnostics = await this.collectDiagnostics(session, validationStage)
      diagnostics = await this.repairKnownOpeningBounds(diagnostics, session, validationStage)
      diagnostics = await withExtraChecks(diagnostics)
      if (options.persistAfterRound) {
        await options.persistAfterRound(diagnostics.validation.valid)
      }
    }
    return { diagnostics, repairRounds, toolNamesUsed, furnitureIssues, structureViolations }
  }

  private async repairKnownOpeningBounds(
    diagnostics: Awaited<ReturnType<PascalAiAgent['collectDiagnostics']>>,
    session: WorkflowSession,
    validationStage: ValidationStage = 'verification',
  ): Promise<Awaited<ReturnType<PascalAiAgent['collectDiagnostics']>>> {
    const ids = dedupe(
      diagnostics.verificationIssues.flatMap(issue => {
        const match = issue.match(/^(?:door|window)\s+(\S+)\s+(?:extends outside|vertical bounds)/)
        return match?.[1] ? [match[1]] : []
      }),
    )
    if (ids.length === 0) return diagnostics

    const patches: Array<{ op: 'update'; id: string; data: Record<string, unknown> }> = []
    for (const id of ids) {
      const node = toolPayload(await this.callMcp(session.sessionId, 'get_node', { id })).node
      if (!isRecord(node)) continue
      const wallId = typeof node.parentId === 'string'
        ? node.parentId
        : typeof node.wallId === 'string' ? node.wallId : undefined
      if (!wallId) continue
      const wall = toolPayload(await this.callMcp(session.sessionId, 'get_node', { id: wallId })).node
      if (!isRecord(wall)) continue
      const data = buildOpeningRepairData(node, wall)
      if (data) patches.push({ op: 'update', id, data })
    }
    if (patches.length === 0) return diagnostics
    await this.callMcp(session.sessionId, 'apply_patch', { patches })
    return this.collectDiagnostics(session, validationStage)
  }

  private async persistScene(
    sessionId: string,
    sceneId: string | undefined,
    valid: boolean,
    expectedVersion: number | null,
  ): Promise<number | null> {
    if (!valid || !sceneId) return expectedVersion
    const status = toolPayload(await this.callMcp(sessionId, 'get_project_status', { id: sceneId }))
    const currentVersion = nullableNumber(status.version) ?? expectedVersion
    const saved = toolPayload(await this.callMcp(sessionId, 'save_scene', {
      id: sceneId,
      projectId: sceneId,
      name: 'Pascal AI 户型方案',
      saveMode: 'draft',
      includeCurrentScene: true,
      ...(currentVersion !== null ? { expectedVersion: currentVersion } : {}),
    }))
    return nullableNumber(saved.version) ?? currentVersion
  }

  private async sceneBoundary(sessionId: string, sceneId: string): Promise<SceneBoundary> {
    const status = toolPayload(await this.callMcp(sessionId, 'get_project_status', { id: sceneId }))
    const version = nullableNumber(status.version)
    const graphHash = nullableString(status.graphHash)
    if (version === null || !graphHash) {
      throw new Error(`Scene ${sceneId} did not expose an authoritative version and graph hash`)
    }
    return { version, graphHash }
  }

  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    furnitureIssues?: string[],
  ): Promise<ChatMessage> {
    try {
      let args = normalizeToolArgs(toolCall.function.name, parseToolArgs(toolCall.function.arguments))
      args = await this.correctFloorItemHeight(sessionId, toolCall.function.name, args)
      const result = await this.callMcp(sessionId, toolCall.function.name, args)
      if (furnitureIssues) {
        recordFurnitureIssues(toolCall.function.name, args, toolPayload(result), furnitureIssues)
      }
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify(result),
      }
    } catch (error) {
      // A cancel that aborted this tool call must propagate as a cancellation,
      // not be swallowed into a tool-result error the model would try to
      // "recover" from.
      this.throwIfCancelled(sessionId)
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify({ error: errorMessage(error) }),
      }
    }
  }

  // place_item never validates or snaps the Y coordinate for floor items
  // (target is a level/slab/zone) — whatever height the model guesses is
  // used verbatim. furnish_room's own deterministic placements always use
  // Y=0 and let each catalog asset's own `offset` field handle vertical
  // fine-tuning, so that's the correct convention; place_item just doesn't
  // enforce it. A model-guessed non-zero Y here makes the item appear to
  // float above or sink into the floor. This can't be fixed inside the MCP
  // tool without editing it, so we correct it at the boundary: look up the
  // target node's type, and zero the Y coordinate only when the target is
  // genuinely a floor (wall/ceiling targets legitimately need non-zero Y
  // for mounting height, so those are left untouched).
  private async correctFloorItemHeight(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolName !== 'place_item') return args
    const targetNodeId = args.targetNodeId
    const position = args.position
    if (typeof targetNodeId !== 'string' || !Array.isArray(position) || position.length !== 3) {
      return args
    }
    if (position[1] === 0) return args
    try {
      const target = toolPayload(await this.callMcp(sessionId, 'get_node', { id: targetNodeId })).node
      const targetType = isRecord(target) ? target.type : undefined
      if (targetType !== 'level' && targetType !== 'slab' && targetType !== 'zone') return args
    } catch {
      // Can't verify the target type — leave the position untouched rather
      // than guess.
      return args
    }
    return { ...args, position: [position[0], 0, position[2]] }
  }

  private async collectDiagnostics(
    session: WorkflowSession,
    stage: ValidationStage = 'verification',
  ): Promise<{
    validation: { valid: boolean; errors: string[] }
    verificationIssues: string[]
    collisions: Array<{ aId: string; bId: string; kind: string }>
    doorlessRooms: string[]
    strayWindows: string[]
    requirementMismatches: string[]
    isolatedBedrooms: string[]
    furniturePlacementIssues: FurniturePlacementIssue[]
    strayWallIds: string[]
    mismatchL10n: Array<MismatchFinding['l10n']>
  }> {
    let sources: [Awaited<ReturnType<typeof readMcpValidationSources>>, unknown, unknown, unknown]
    try {
      sources = await Promise.all([
        readMcpValidationSources((name, args) => this.callMcp(session.sessionId, name, args)),
        this.callMcp(session.sessionId, 'get_zones', {}),
        this.callMcp(session.sessionId, 'get_walls', {}),
        this.callMcp(session.sessionId, 'get_level_summary', {}),
      ])
    } catch (error) {
      await this.runValidationStage(session, stage, {
        unavailable: {
          validatorId: VALIDATOR_IDS.sceneDiagnostics,
          reason: validationUnavailableReason(error),
        },
      })
      throw error
    }
    const [{ validationRaw, verificationRaw, collisionsRaw }, zonesRaw, wallsRaw, levelSummaryRaw] = sources
    const validationPayload = toolPayload(validationRaw)
    const verificationPayload = toolPayload(verificationRaw)
    const collisionPayload = toolPayload(collisionsRaw)
    const zonesPayload = toolPayload(zonesRaw)
    const wallsPayload = toolPayload(wallsRaw)
    const validationErrors = Array.isArray(validationPayload.errors)
      ? validationPayload.errors.map(error =>
          typeof error === 'string' ? error : JSON.stringify(error),
        )
      : []
    const verificationIssues = Array.isArray(verificationPayload.issues)
      ? verificationPayload.issues.map(issue =>
          typeof issue === 'string' ? issue : JSON.stringify(issue),
        )
      : []
    const collisions = Array.isArray(collisionPayload.collisions)
      ? collisionPayload.collisions.filter(isCollision)
      : []
    const zones = Array.isArray(zonesPayload.zones) ? zonesPayload.zones.filter(isZoneSummary) : []
    const zoneTypes = this.resolveZoneTypes(session, zones)
    const walls = Array.isArray(wallsPayload.walls) ? wallsPayload.walls.filter(isWallWithOpenings) : []
    const levelSummaryPayload = toolPayload(levelSummaryRaw)
    const items = Array.isArray(levelSummaryPayload.items)
      ? levelSummaryPayload.items.filter(isItemSummary)
      : []
    const mismatchFindings = [
      ...compareRoomsToRequirements(zones, session.brief, zoneTypes),
      ...checkAreaRequirements(zones, session.brief),
    ]
    const strayWallIds = findStrayWindows(zones, walls)
    const furniturePlacementIssues = checkFurniturePlacement(zones, walls, items)
    const diagnostics = {
      validation: {
        valid: validationPayload.valid === true,
        errors: validationErrors,
      },
      verificationIssues,
      collisions,
      doorlessRooms: findDoorlessRooms(zones, walls),
      strayWindows: strayWallIds.map(wallId => issueText('zh', 'strayWindow', { wallId })),
      requirementMismatches: mismatchFindings.map(finding => finding.message),
      isolatedBedrooms: findIsolatedBedrooms(zones, walls, zoneTypes),
      furniturePlacementIssues,
      // Structured sources for reply-language re-rendering (see
      // describeRemainingIssues). Extra strings appended later by
      // extraChecks have no l10n and pass through untranslated.
      strayWallIds,
      mismatchL10n: mismatchFindings.map(finding => finding.l10n),
    }
    await this.runValidationStage(session, stage, {
      mcpValidation: {
        valid: diagnostics.validation.valid,
        errors: diagnostics.validation.errors,
        verificationIssues: diagnostics.verificationIssues,
        collisions: diagnostics.collisions,
      },
      furniturePlacementIssues,
      sceneDiagnostics: diagnostics,
    })
    return diagnostics
  }

  private modelHooks(sessionId: string): RequestHooks {
    return {
      signal: this.runAbortControllers.get(sessionId)?.signal,
      // Charged BEFORE each real HTTP attempt (internal retries and the
      // fallback call below included): a budget throw here aborts the
      // attempt without spending provider money. onAttemptFinished is the
      // metering truth source — the T1.2 persistence sink subscribes there.
      onAttemptStarted: () => this.chargeModelCall(sessionId),
      onAttemptFinished: result => {
        const context = this.activeRequestContexts.get(sessionId)
        let persistence = 'failed'
        try {
          if (!context) throw new Error('Missing request context for model attempt')
          this.modelAttempts.record({ ...context, sessionId }, result)
          persistence = 'ok'
        } catch (error) {
          console.error(
            `[req ${context?.requestId ?? '-'}] [trace ${context?.traceId ?? '-'}] model-attempt persistence failed: ${errorMessage(error)}`,
          )
        }
        console.log(
          `[req ${context?.requestId ?? '-'}] [trace ${context?.traceId ?? '-'}] model-attempt op=${result.operation ?? '-'} call=${result.callId} n=${result.attemptNo} status=${result.status} model=${result.model ?? result.requestedModel} latency=${result.latencyMs}ms persistence=${persistence}${result.usage?.totalTokens !== undefined ? ` tokens=${result.usage.totalTokens}` : ''}`,
        )
      },
    }
  }

  private async withModelFallback<T>(
    sessionId: string,
    operation: (model: ModelClient, hooks: RequestHooks) => Promise<T>,
  ): Promise<T> {
    if (!this.model) {
      throw new Error('The configured AI provider API key is missing')
    }
    const hooks = this.modelHooks(sessionId)
    try {
      return await operation(this.model, hooks)
    } catch (primaryError) {
      // A cancel must not silently fall back to the secondary model — turn it
      // into a cancellation the outer generation loop understands.
      this.throwIfCancelled(sessionId)
      // An exhausted budget is absolute for the turn/session — retrying on
      // the fallback model would just spend more, not succeed.
      if (primaryError instanceof BudgetExceededError) throw primaryError
      if (!this.fallbackModel) throw primaryError
      return operation(this.fallbackModel, hooks)
    }
  }

  /**
   * Route low-stakes classification calls to the cheap/fast model when one is
   * configured. Falls back to the main model on error or when no fast model
   * is configured, so callers never lose reliability by using this.
   */
  private async withFastModel<T>(
    sessionId: string,
    operation: (model: ModelClient, hooks: RequestHooks) => Promise<T>,
  ): Promise<T> {
    if (!this.fastModel) return this.withModelFallback(sessionId, operation)
    try {
      return await operation(this.fastModel, this.modelHooks(sessionId))
    } catch (fastError) {
      this.throwIfCancelled(sessionId)
      if (fastError instanceof BudgetExceededError) throw fastError
      return this.withModelFallback(sessionId, operation)
    }
  }
}

function isTerminalWorkflowPhase(phase: WorkflowSession['phase']): boolean {
  return phase === 'completed' || phase === 'completed_with_issues'
    || phase === 'failed' || phase === 'cancelled'
}

/**
 * Pure decision for `modify()`'s catch block: whether a failed modification
 * attempt should be left in a retryable state. Extracted so it's unit
 * testable without constructing a live `PascalAiAgent`.
 */
/**
 * Requirement truth for the completion gates: the layoutIntent snapshot when
 * the scene is plan-first (kept current by every modify), the brief
 * otherwise. Only the four gate-checked types become requirements — the
 * intent's circulation/service rooms are layout output, not user asks.
 */
export function gateTargetsForSession(
  session: Pick<WorkflowSession, 'brief' | 'layoutIntent' | 'programEditedByModify'>,
): PlanTargets {
  // The intent becomes the requirement truth ONLY after the user edited the
  // program through modify ops. At generation time the brief stays the
  // independent check — otherwise a model intent that under-delivers
  // (case-04: 2 bedrooms for a 3-bedroom brief) would grade its own homework.
  const intent = session.programEditedByModify ? session.layoutIntent : undefined
  if (!intent) return buildPlanTargets(session.brief)
  const counts = new Map<RoomType, number>()
  for (const room of intent.rooms) counts.set(room.type, (counts.get(room.type) ?? 0) + 1)
  const requiredRooms = (['bedroom', 'living', 'kitchen', 'bathroom'] as RoomType[])
    .filter(type => (counts.get(type) ?? 0) > 0)
    .map(type => ({ type, count: counts.get(type)! }))
  return {
    ...(intent.targetTotalAreaSqm > 0 ? { totalAreaSqm: intent.targetTotalAreaSqm } : {}),
    ...(requiredRooms.length > 0 ? { requiredRooms } : {}),
  }
}

/**
 * P0 (eval case-06): brief facts for the strategy layer. Lot dimensions come
 * FIRST from the structured brief facts — the model-written summary
 * rephrases the user's wording ("宽 5 米、长 18 米" → prose the regex scan
 * misses), while the extraction prompt pins dimensions under stable keys.
 * Prose parsing over the summary stays as the fallback.
 */
// 修改路径的 gates 归责语义（MODIFY_REDESIGN §6 三修，用户实测反馈驱动）：
// gates 的职责是兜住「AI 本次做砸的、且用户没要求的」，不是对用户自己的
// 决定做规范审计。两层过滤：
// ① 基线差分——修改前就存在的失败（比如用户此前手动删光了厨房家具）不算
//   本次修改的账，否则之后每一轮无关修改都会重复追责一次；
// ② 意图豁免——本次 ops 里用户明确要求删除的家具，其对应的 missing-
//   equipment/furniture 新失败同样不计（「把灶台删掉」执行成功却报
//   「厨房缺少灶台」，是把执行成功误判成失败）。
// 被滤掉的失败降级为一句不影响 phase 的中性备注。生成路径（全新建）没有
// 基线也没有删除意图，仍然全量跑，安全网不受影响。
// P0（case-06 复盘二修）：抽取模型（temp=1）会偶发丢掉用户口述的地块尺寸
// （「宽 5 米、长 18 米」→ brief 里只剩 plot_shape），prompt 补丁治标不治本。
// ingest 后对用户原话跑确定性提取；brief 里没有任何可解析出尺寸的事实时，
// 补写一条 boundary_dimensions 硬约束 —— briefFactsFor 的结构化扫描就能吃
// 到，策略层稳定拿到 footprintHint，模型丢了也在。
const SITE_DIMENSIONS_LABEL: Record<Lang, string> = { zh: '地块尺寸', ja: '敷地寸法', en: 'Lot dimensions' }

export function ensureSiteDimensionFact(brief: DesignBrief, userMessage: string, lang: Lang): void {
  const hint = detectSiteHint(userMessage)
  if (!hint) return
  const pools = [brief.hardConstraints, brief.existingCondition, brief.designGoals, brief.assumptions]
  const hasParseable = pools.some(pool =>
    pool.some(fact => detectSiteHint(`${fact.key} ${fact.label} ${formatValue(fact.value)}`) !== undefined))
  if (hasParseable) return
  brief.hardConstraints = [
    // An unparseable model-written boundary fact would shadow the injected
    // key on the next mergeFacts round — replace it, the user's own numbers
    // are strictly more reliable.
    ...brief.hardConstraints.filter(fact => fact.key !== 'boundary_dimensions'),
    {
      key: 'boundary_dimensions',
      label: SITE_DIMENSIONS_LABEL[lang],
      value: `${hint.widthM}m × ${hint.depthM}m`,
      source: 'user',
      confidence: 1,
      confirmationStatus: 'confirmed',
    },
  ]
}

export function briefFactsFor(brief: DesignBrief, briefSummary: string): BriefFacts {
  const facts = deriveBriefFacts(briefSummary)
  const pools = [brief.hardConstraints, brief.existingCondition, brief.designGoals, brief.assumptions]
  if (!facts.siteHint) {
    outer: for (const pool of pools) {
      for (const fact of pool) {
        const hint = detectSiteHint(`${fact.key} ${fact.label} ${formatValue(fact.value)}`)
        if (hint) {
          facts.siteHint = hint
          break outer
        }
      }
    }
  }
  // Room program: the GOAL pools (designGoals/hardConstraints) outrank
  // everything — a renovation brief reads "现状户型：2DK / 目标户型：2LDK"
  // and both the summary regex (first match wins) and a flat pool scan would
  // pick up the CURRENT program instead of the requested one. Only when no
  // goal fact carries a program does the summary-derived value stand, with
  // assumptions/existingCondition as the last resort.
  const programFromPools = (scan: RequirementFact[][]) => {
    for (const pool of scan) {
      for (const fact of pool) {
        const parsed = parseRoomProgram(`${fact.key} ${fact.label} ${formatValue(fact.value)}`)
        if (parsed) return parsed
      }
    }
    return undefined
  }
  const applyProgram = (parsed: NonNullable<ReturnType<typeof parseRoomProgram>>) => {
    facts.roomProgram = parsed.program
    if (parsed.serviceRoomCount > 0) facts.serviceRoomCount = parsed.serviceRoomCount
    else delete facts.serviceRoomCount
  }
  const goalProgram = programFromPools([brief.designGoals, brief.hardConstraints])
  if (goalProgram) {
    applyProgram(goalProgram)
  } else if (!facts.roomProgram) {
    const fallback = programFromPools([brief.assumptions, brief.existingCondition])
    if (fallback) applyProgram(fallback)
  }
  // Kitchen preference is a GOAL statement too: only explicit wording in the
  // goal pools may override the summary-derived value, and existingCondition
  // never contributes — a renovation brief's 现状 2LDK must not read as an
  // open-kitchen demand for the 1K target (Codex 复审 #2).
  const preferenceFromPools = (scan: RequirementFact[][]) => {
    for (const pool of scan) {
      for (const fact of pool) {
        const preference = detectKitchenPreference(`${fact.key} ${fact.label} ${formatValue(fact.value)}`)
        if (preference) return preference
      }
    }
    return undefined
  }
  // Goal-source priority: designGoals/hardConstraints > confirmed
  // assumptions（用户确认 brief 后 assumptions 就是生成输入，不是现状）>
  // summary free text. Only existingCondition identifies pollution.
  const preferenceFromGoals = preferenceFromPools([brief.designGoals, brief.hardConstraints])
    ?? preferenceFromPools([brief.assumptions])
  if (preferenceFromGoals) {
    facts.kitchenPreference = preferenceFromGoals
  } else if (
    facts.kitchenPreference !== undefined
    && preferenceFromPools([brief.existingCondition]) === facts.kitchenPreference
  ) {
    // The summary concatenates 现状+目标 and this preference matches wording
    // that lives only in the CURRENT-state pool（复现：现状「独立厨房」＋
    // 目标 1LDK 曾把目标错锁成 closed/user）——treat it as 现状 pollution,
    // not a goal, and let the program / band default decide.
    delete facts.kitchenPreference
  }
  return facts
}

/**
 * Manual-edit drift detection (MODIFY_REDESIGN.md §6): does the live scene's
 * room set still match the plan snapshot it was built from? Each zone polygon
 * must correspond to one plan room polygon (any vertex rotation/winding,
 * ±0.15m per vertex for executor rounding) — deliberately NOT names (renames
 * are a supported non-structural edit). Comparing polygons rather than an
 * area profile means area-preserving edits — a translated room, two
 * equal-size rooms swapped, a wall moved and compensated elsewhere — also
 * count as drift, instead of being silently overwritten by the next rebuild.
 */
export function sceneDriftedFromPlan(
  zones: Array<{ polygon: Array<[number, number]> }>,
  plan: LayoutPlan,
): boolean {
  if (zones.length !== plan.rooms.length) return true
  const eps = 0.15
  const dropCollinear = (poly: Array<[number, number]>): Array<[number, number]> =>
    poly.filter((curr, i) => {
      const prev = poly[(i - 1 + poly.length) % poly.length]!
      const next = poly[(i + 1) % poly.length]!
      const cross = (curr[0] - prev[0]) * (next[1] - prev[1]) - (curr[1] - prev[1]) * (next[0] - prev[0])
      return Math.abs(cross) > 1e-6
    })
  const samePolygon = (a: Array<[number, number]>, b: Array<[number, number]>): boolean => {
    if (a.length !== b.length) return false
    const n = a.length
    const aligned = (candidate: Array<[number, number]>): boolean => {
      for (let offset = 0; offset < n; offset++) {
        let ok = true
        for (let i = 0; i < n; i++) {
          const [x1, z1] = candidate[(i + offset) % n]!
          const [x2, z2] = b[i]!
          if (Math.abs(x1 - x2) > eps || Math.abs(z1 - z2) > eps) { ok = false; break }
        }
        if (ok) return true
      }
      return false
    }
    return aligned(a) || aligned([...a].reverse())
  }
  const remaining = plan.rooms.map(room => dropCollinear(room.polygon))
  for (const zone of zones) {
    const polygon = dropCollinear(zone.polygon)
    const index = remaining.findIndex(candidate => samePolygon(polygon, candidate))
    if (index === -1) return true
    remaining.splice(index, 1)
  }
  return false
}

// —— stuck-state guard（状态持久化审计缺口，2026-07-15）——
// generating/modifying/inspecting 是内存中的异步任务：进程重启（或极端情况
// 下逃逸了 catch 的异常）会让持久化的 session 永远停在 in-flight phase，用户
// 回来面对一个卡死的状态。恢复语义：
// - generating → 回到 awaiting_confirmation（brief 已确认，发确认即重新生成）；
// - modifying  → 复用 modifyFailureRecovery（有 pending 修改可确认重试）；
// - inspecting → 只读操作，按有无 sceneResult 回落到完成态/failed。
// 场景可能停在中断时的中间状态——恢复消息里如实说明，不静默。
const IN_FLIGHT_PHASES: ReadonlySet<WorkflowSession['phase']> = new Set([
  'generating', 'modifying', 'inspecting',
])

export function staleSessionRecovery(
  session: Pick<WorkflowSession, 'phase' | 'pendingModification' | 'sceneResult' | 'destructiveSceneWriteStarted'>,
): { phase: WorkflowSession['phase']; template: 'staleGenerating' | 'staleModifying' | 'staleDestructive' | 'staleInspecting' } | null {
  if (!IN_FLIGHT_PHASES.has(session.phase)) return null
  if (session.phase === 'generating') {
    return { phase: 'awaiting_confirmation', template: 'staleGenerating' }
  }
  if (session.phase === 'modifying') {
    if (session.destructiveSceneWriteStarted) {
      return {
        phase: session.sceneResult ? 'completed_with_issues' : 'failed',
        template: 'staleDestructive',
      }
    }
    const recovery = modifyFailureRecovery(
      Boolean(session.pendingModification),
      Boolean(session.sceneResult),
    )
    return { phase: recovery.phase, template: 'staleModifying' }
  }
  return {
    phase: session.sceneResult ? 'completed_with_issues' : 'failed',
    template: 'staleInspecting',
  }
}

/**
 * Whether a plain (non-confirm/cancel) message arriving while `phase` is
 * `awaiting_modification_confirmation` (left there by a failed modify
 * attempt, see `modifyFailureRecovery`) should be treated as a brand new
 * modification instruction against the existing scene, rather than falling
 * through to generic requirement extraction.
 */
/**
 * session.messages records every turn but was previously never read back
 * into any model prompt, so cross-turn references ("that one", "same as
 * before", "still wrong") were invisible to the model even though they were
 * sitting right there in the transcript. This turns the last few turns into
 * plain text so callers can inject it into their prompts.
 */
function recentConversationText(messages: ChatMessage[], limit = 8): string {
  const recent = messages.slice(-limit)
  if (recent.length === 0) return ''
  return recent
    .map(m => {
      const text = typeof m.content === 'string' ? m.content : '[图片或结构化内容]'
      const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text
      return `${m.role === 'user' ? '用户' : '助手'}：${trimmed}`
    })
    .join('\n')
}

function recentConversationBlock(messages: ChatMessage[]): string {
  const text = recentConversationText(messages)
  if (!text) return ''
  return `Recent conversation with the user (use this to resolve references like "that one" or "same as before"):\n${text}\n\n`
}

/**
 * Extract the body of a markdown `## <heading>` section (text up to the next
 * `## ` heading or end of document). Returns undefined if the heading is not
 * present, so callers can fall back gracefully when upstream guide content
 * is renamed or restructured.
 */
function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n')
  const startIndex = lines.findIndex(line => line.trim() === `## ${heading}`)
  if (startIndex === -1) return undefined
  const rest = lines.slice(startIndex + 1)
  const endIndex = rest.findIndex(line => line.startsWith('## '))
  const body = (endIndex === -1 ? rest : rest.slice(0, endIndex)).join('\n').trim()
  return body.length > 0 ? body : undefined
}

// Tools that create/move item (furniture) nodes. check_collisions only
// compares unrotated bounding boxes between items and never checks items
// against walls or room bounds, and verify_scene/validate_scene don't look
// at item placement at all — so "passed automatic checks" does not cover
// furniture placement quality. apply_patch is included because it can touch
// an item node just as easily as any other node type.
// Tools that write scene history — each successful call is one undo step.
// Used by the repair-round structure lock to roll a violating round back.
const MUTATING_TOOLS = new Set([
  'create_room', 'create_level', 'create_story_shell', 'add_door', 'add_window',
  'place_item', 'furnish_room', 'apply_patch', 'delete_node', 'set_zone',
])

// Combined remaining-issue count = structural diagnostics + furniture that
// wasn't placed as intended. Furniture failures used to be invisible to
// remainingIssueCount/phase (they only appeared in reply text), so a scene
// with overlapping/out-of-bounds furniture was mislabeled fully `completed`.
// Plan-stage failures (partitioner/validator, via PlanBuildFailure) carry an
// aligned l10n ref; re-render per language, zh/无模板 falls back to the
// canonical zh text.
function renderPlanFailure(message: string, l10n: IssueL10n | null, lang: Lang): string {
  if (lang === 'zh' || !l10n) return message
  try {
    const render = issueText as (l: Lang, id: string, params: unknown) => string
    return render(lang, l10n.id, l10n.params)
  } catch {
    return message
  }
}

// Gate failures carry {id, params}; re-render in the reply language, falling
// back to the canonical zh message when a failure predates the l10n field.
/**
 * `place_item` silently swaps in a placeholder box when its `catalogItemId`
 * isn't in the catalog (status: 'catalog_unavailable'), and `furnish_room`
 * silently drops placements that don't fit (status stays 'ok' but each drop
 * is listed in `skipped`). Both were previously invisible to the user —
 * the model could see them in the tool result but nothing surfaced them in
 * the final reply. This captures human-readable notes for both cases.
 */
// Re-derive a LayoutIntent from a locally-edited plan so gates, drift checks
// and future modifies keep a snapshot that MATCHES the real geometry: room
// areas come straight from the polygons and the total is the (unchanged)
// footprint area — a local edit never grows the building (§8).
function intentFromLocalPlan(plan: LayoutPlan): LayoutIntent {
  const rooms: LayoutIntentRoom[] = plan.rooms.map(room => ({
    id: room.id,
    name: room.name,
    type: room.type,
    targetAreaSqm: Math.round(polygonArea(room.polygon) * 10) / 10,
    ...(room.requiresExteriorWindow ? { requiresExteriorWindow: true } : {}),
  }))
  const intent: LayoutIntent = {
    targetTotalAreaSqm: Math.round(footprintArea(plan.footprint) * 10) / 10,
    rooms,
  }
  const adjacency = plan.connections.map(connection => ({ a: connection.from, b: connection.to }))
  if (adjacency.length > 0) intent.adjacency = adjacency
  return intent
}

function planTargetsForIntent(intent: LayoutIntent): PlanTargets {
  const requiredRooms = [...intent.rooms.reduce((acc, room) => {
    acc.set(room.type, (acc.get(room.type) ?? 0) + 1)
    return acc
  }, new Map<RoomType, number>())].map(([type, count]) => ({ type, count }))
  return { totalAreaSqm: intent.targetTotalAreaSqm, requiredRooms }
}

// Creates a fresh per-phase trace and registers it on the session. Kept on
// the session (not a local) so a phase that *throws* — e.g. structure
// non-convergence — still leaves its trace in the persisted session for the
// eval report to explain what the phase spent its rounds on.
function startPhaseTrace(session: WorkflowSession, phaseLabel: string): PhaseToolTrace {
  const trace: PhaseToolTrace = {
    phase: phaseLabel,
    modelCalls: 0,
    toolCalls: [],
    toolCounts: {},
    converged: false,
    continuationAttempts: 0,
  }
  session.toolTrace = [...(session.toolTrace ?? []), trace]
  return trace
}

// Tools whose primary argument is worth keeping in the trace: for create_room
// the room name answers "which room did the structure phase get to before
// running out of rounds"; for place_item/search_assets the asset/query shows
// what the furnishing rounds were spent on.
const TRACE_DETAIL_ARGS: Record<string, string> = {
  create_room: 'name',
  place_item: 'catalogItemId',
  search_assets: 'query',
}

function recordTraceToolCall(trace: PhaseToolTrace, toolCall: ToolCall, toolMessage: ChatMessage): void {
  const name = toolCall.function.name
  trace.toolCounts[name] = (trace.toolCounts[name] ?? 0) + 1
  // executeToolCall wraps a failed call as {"error": ...} — cheap prefix
  // check instead of parsing potentially large payloads.
  const ok = typeof toolMessage.content !== 'string' || !toolMessage.content.startsWith('{"error"')
  let detail: string | undefined
  const detailArg = TRACE_DETAIL_ARGS[name]
  if (detailArg) {
    try {
      const value = (JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>)[detailArg]
      if (typeof value === 'string' && value) detail = value
    } catch {
      // Unparseable args — trace entry still records the call itself.
    }
  }
  trace.toolCalls.push({ name, ok, ...(detail ? { detail } : {}) })
}

function recordFurnitureIssues(
  toolName: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown>,
  out: string[],
): void {
  if (toolName === 'place_item' && payload.status === 'catalog_unavailable') {
    const catalogItemId = typeof args.catalogItemId === 'string' ? args.catalogItemId : '未知素材'
    out.push(`目录中找不到 "${catalogItemId}"，已用占位方块代替`)
    return
  }
  if (toolName !== 'furnish_room' || !Array.isArray(payload.skipped)) return
  // Every `skipped` entry means the item was NOT placed into the scene —
  // "overlaps another item" is a prediction that made furnish_room decline
  // the placement, not an actual overlap between placed items. Prefix the
  // note accordingly so replies/reports don't mislabel these as overlaps
  // (actual placed-item problems come from checkFurniturePlacement instead).
  for (const entry of payload.skipped) {
    if (typeof entry === 'string' && entry.trim()) out.push(`未能放置 ${entry.trim()}`)
  }
}

export function buildOpeningRepairData(
  node: Record<string, unknown>,
  wall: Record<string, unknown>,
): Record<string, unknown> | null {
  if ((node.type !== 'door' && node.type !== 'window') || wall.type !== 'wall') return null
  if (!isNumberPair(wall.start) || !isNumberPair(wall.end) || !isNumberTriple(node.position)) {
    return null
  }
  const currentPosition = node.position
  const wallLength = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
  const wallHeight = positiveNumber(wall.height, 2.5)
  const defaultWidth = node.type === 'door' ? 0.9 : 1.5
  const defaultHeight = node.type === 'door' ? 2.1 : 1.5
  const width = Math.min(positiveNumber(node.width, defaultWidth), Math.max(0.1, wallLength - 0.02))
  const height = Math.min(positiveNumber(node.height, defaultHeight), Math.max(0.1, wallHeight - 0.02))
  const x = clamp(currentPosition[0], width / 2, Math.max(width / 2, wallLength - width / 2))
  const y = clamp(currentPosition[1], height / 2, Math.max(height / 2, wallHeight - height / 2))
  const position: [number, number, number] = [x, y, currentPosition[2]]
  if (
    width === node.width && height === node.height &&
    position.every((value, index) => value === currentPosition[index])
  ) return null
  return { position, width, height }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNumberPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'number')
}

function isNumberTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number')
}

type WallSummary = {
  id: string
  start: [number, number]
  end: [number, number]
  thickness?: number
  height?: number
  name?: string
}

function isWallSummary(value: unknown): value is WallSummary {
  return isRecord(value) && typeof value.id === 'string' &&
    isNumberPair(value.start) && isNumberPair(value.end)
}

function isWallWithOpenings(value: unknown): value is WallWithOpenings {
  if (!isWallSummary(value)) return false
  const openings = (value as { openings?: unknown }).openings
  return Array.isArray(openings) && openings.every(
    o => isRecord(o) && typeof o.type === 'string',
  )
}

function isZoneSummary(value: unknown): value is ZoneSummary {
  return isRecord(value) && typeof value.id === 'string' &&
    typeof value.name === 'string' && isPolygon(value.polygon)
}

function isPolygon(value: unknown): value is Array<[number, number]> {
  return Array.isArray(value) && value.length >= 3 && value.every(isNumberPair)
}

// ---------------------------------------------------------------------------
// Deterministic current-state furniture placement check. check_collisions
// ignores item rotation and never tests items against room polygons or door
// swings, so a scene could pass every automated check with a rotated sofa in
// the wall and a fridge in the doorway. This check recomputes each floor
// item's rotated footprint (same math and 8cm gap convention as MCP's
// furnish_room) and reports pairwise overlaps, out-of-room placements, and
// door-clearance violations. Results feed countDiagnosticIssues, so they
// trigger and steer repair rounds like any structural problem.
// ---------------------------------------------------------------------------

export type ItemSummary = {
  id: string
  name?: string
  position: [number, number, number]
  rotation?: [number, number, number]
  asset?: { dimensions?: [number, number, number]; attachTo?: string | null }
}

function isItemSummary(value: unknown): value is ItemSummary {
  return isRecord(value) && typeof value.id === 'string' && isNumberTriple(value.position)
}

type Footprint2D = { minX: number; maxX: number; minZ: number; maxZ: number }

const FURNITURE_GAP_M = 0.08
const FOOTPRINT_BOUNDS_SLACK_M = 0.05

function itemFootprint2D(item: ItemSummary): Footprint2D {
  const [w = 1, , d = 1] = item.asset?.dimensions ?? [1, 1, 1]
  const rotationY = item.rotation?.[1] ?? 0
  const cos = Math.abs(Math.cos(rotationY))
  const sin = Math.abs(Math.sin(rotationY))
  const halfW = (w * cos + d * sin) / 2
  const halfD = (w * sin + d * cos) / 2
  const [x, , z] = item.position
  return { minX: x - halfW, maxX: x + halfW, minZ: z - halfD, maxZ: z + halfD }
}

function footprintsIntersect(a: Footprint2D, b: Footprint2D, gap: number): boolean {
  return a.maxX - gap > b.minX && a.minX + gap < b.maxX && a.maxZ - gap > b.minZ && a.minZ + gap < b.maxZ
}

export function checkFurniturePlacement(
  zones: ZoneSummary[],
  walls: WallWithOpenings[],
  items: ItemSummary[],
): FurniturePlacementIssue[] {
  const issues: FurniturePlacementIssue[] = []
  // Wall/ceiling-mounted items have no floor footprint to check.
  const floorItems = items.filter(item => {
    const attachTo = item.asset?.attachTo
    return attachTo !== 'wall' && attachTo !== 'ceiling'
  })
  const footprints = floorItems.map(itemFootprint2D)
  const label = (item: ItemSummary) => item.name || item.id

  for (let i = 0; i < floorItems.length; i++) {
    for (let j = i + 1; j < floorItems.length; j++) {
      if (footprintsIntersect(footprints[i]!, footprints[j]!, FURNITURE_GAP_M)) {
        issues.push({
          kind: 'overlap',
          itemId: floorItems[i]!.id,
          itemName: floorItems[i]!.name,
          otherItemId: floorItems[j]!.id,
          message: `家具「${label(floorItems[i]!)}」与「${label(floorItems[j]!)}」实际重叠，请移动其中一件到空位`,
        })
      }
    }
  }

  for (let i = 0; i < floorItems.length; i++) {
    const item = floorItems[i]!
    const [x, , z] = item.position
    const home = zones.find(zone => pointInPolygon(x, z, zone.polygon))
    if (!home) {
      issues.push({
        kind: 'out_of_bounds',
        itemId: item.id,
        itemName: item.name,
        message: `家具「${label(item)}」的中心不在任何房间内，请移到目标房间的多边形内部`,
      })
      continue
    }
    const fp = footprints[i]!
    const corners: Array<[number, number]> = [
      [fp.minX + FOOTPRINT_BOUNDS_SLACK_M, fp.minZ + FOOTPRINT_BOUNDS_SLACK_M],
      [fp.maxX - FOOTPRINT_BOUNDS_SLACK_M, fp.minZ + FOOTPRINT_BOUNDS_SLACK_M],
      [fp.maxX - FOOTPRINT_BOUNDS_SLACK_M, fp.maxZ - FOOTPRINT_BOUNDS_SLACK_M],
      [fp.minX + FOOTPRINT_BOUNDS_SLACK_M, fp.maxZ - FOOTPRINT_BOUNDS_SLACK_M],
    ]
    if (corners.some(([cx, cz]) => !pointInPolygon(cx, cz, home.polygon))) {
      issues.push({
        kind: 'out_of_bounds',
        itemId: item.id,
        itemName: item.name,
        room: home.name || home.id,
        message: `家具「${label(item)}」超出了房间「${home.name || home.id}」的边界（考虑旋转后的实际占地），请移入房间内部`,
      })
    }
  }

  // Door clearance: a rectangle centered on each door must stay free of
  // furniture so the door can open and people can pass.
  for (const wall of walls) {
    const orientation = segmentOrientation(wall)
    if (!orientation) continue // diagonal wall — skip, best-effort
    for (const opening of wall.openings) {
      if (opening.type !== 'door') continue
      const record = opening as Record<string, unknown>
      const localX = isNumberTriple(record.position) ? record.position[0] : undefined
      if (typeof localX !== 'number') continue
      const width = typeof record.width === 'number' ? record.width : 0.9
      // add_door stores localX measured from wall.start; for an axis-aligned
      // wall that equals the low coordinate when start < end, otherwise it
      // measures back from the high end — normalize via the actual start.
      const startCoord = orientation.axis === 'x' ? wall.start[0] : wall.start[1]
      const endCoord = orientation.axis === 'x' ? wall.end[0] : wall.end[1]
      const doorCenterAlong = startCoord <= endCoord ? startCoord + localX : startCoord - localX
      const alongLo = doorCenterAlong - width / 2 - FOOTPRINT_BOUNDS_SLACK_M
      const alongHi = doorCenterAlong + width / 2 + FOOTPRINT_BOUNDS_SLACK_M
      const depths = doorClearanceDepths(
        wall.start,
        wall.end,
        zones.map(zone => ({
          type: classifyRoomTypeByName(zone.name),
          polygon: zone.polygon,
        })),
        doorCenterAlong,
      )
      const clearance: Footprint2D = orientation.axis === 'x'
        ? { minX: alongLo, maxX: alongHi, minZ: orientation.constant - depths.negative, maxZ: orientation.constant + depths.positive }
        : { minX: orientation.constant - depths.negative, maxX: orientation.constant + depths.positive, minZ: alongLo, maxZ: alongHi }
      for (let i = 0; i < floorItems.length; i++) {
        if (footprintsIntersect(footprints[i]!, clearance, 0)) {
          const item = floorItems[i]!
          issues.push({
            kind: 'door_clearance',
            itemId: item.id,
            itemName: item.name,
            message: `家具「${label(item)}」占用了墙 ${wall.id} 上房门的开启/通行空间，请移开并让出门口净空`,
          })
        }
      }
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Modification-protection closed loop (modify path). A "before" snapshot of
// the node map is taken at the start of the turn; after the modification and
// after every repair round, `checkModificationProtection` diffs the current
// graph against it and reports violations as repairable issue strings. This
// is the deterministic counterpart of the eval harness's modification
// assertions — same geometry-field semantics (walls compare start/end/
// thickness/height; a wall gaining a door child is NOT a modified wall; the
// door/window nodes themselves are checked separately).
// ---------------------------------------------------------------------------

export type SceneNodeSnapshot = Record<string, Record<string, unknown>>

export function snapshotSceneNodes(payload: Record<string, unknown>): SceneNodeSnapshot {
  const nodes = payload.nodes
  if (!isRecord(nodes)) return {}
  const out: SceneNodeSnapshot = {}
  for (const [id, node] of Object.entries(nodes)) {
    if (isRecord(node)) out[id] = node
  }
  return out
}

function localPatchAllowances(
  renamedZoneIds: string[],
  report: FurnitureModifyReport | null,
  rooms: FurnitureRoom[],
  operations: FurnitureModifyOp[],
  levelId: string | null,
): LocalPatchAllowance[] {
  const fieldsByNode = new Map<string, Set<string> | 'all'>()
  const allowFields = (nodeId: string | null | undefined, fields: string[] | 'all') => {
    if (!nodeId) return
    if (fields === 'all' || fieldsByNode.get(nodeId) === 'all') {
      fieldsByNode.set(nodeId, 'all')
      return
    }
    const current = fieldsByNode.get(nodeId)
    const merged = current instanceof Set ? current : new Set<string>()
    for (const field of fields) merged.add(field)
    fieldsByNode.set(nodeId, merged)
  }

  for (const zoneId of renamedZoneIds) allowFields(zoneId, ['name'])
  for (const result of report?.results ?? []) {
    allowFields(result.removedItemId, 'all')
    allowFields(result.addedItemId, 'all')
    // R4: a bulk clear removes many items in one op.
    for (const removedId of result.removedItemIds ?? []) allowFields(removedId, 'all')
  }
  for (const operation of operations) {
    const room = rooms.find(entry =>
      entry.id === operation.room
      || entry.zoneId === operation.room
      || entry.name === operation.room)
    allowFields(room?.zoneId, ['children'])
  }
  if (operations.length > 0) allowFields(levelId, ['children'])

  return [...fieldsByNode.entries()].map(([nodeId, fields]) => ({
    nodeId,
    fields: fields === 'all' ? 'all' : [...fields].sort(),
  }))
}

// 1mm: genuine edits move geometry by far more; re-serialization noise never does.
const GEOM_FIELD_EPS = 0.001

function geomNumbersDiffer(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) > GEOM_FIELD_EPS
  return a !== b
}

function geomPairDiffers(a: unknown, b: unknown): boolean {
  if (isNumberPair(a) && isNumberPair(b)) {
    return geomNumbersDiffer(a[0], b[0]) || geomNumbersDiffer(a[1], b[1])
  }
  return JSON.stringify(a) !== JSON.stringify(b)
}

export function wallGeometryFieldsChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return (
    geomPairDiffers(before.start, after.start) ||
    geomPairDiffers(before.end, after.end) ||
    geomNumbersDiffer(before.thickness, after.thickness) ||
    geomNumbersDiffer(before.height, after.height)
  )
}

export function openingFieldsChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const positionDiffers = isNumberTriple(before.position) && isNumberTriple(after.position)
    ? before.position.some((value, index) => geomNumbersDiffer(value, (after.position as number[])[index]))
    : JSON.stringify(before.position) !== JSON.stringify(after.position)
  return (
    positionDiffers ||
    geomNumbersDiffer(before.width, after.width) ||
    geomNumbersDiffer(before.height, after.height) ||
    before.parentId !== after.parentId ||
    before.wallId !== after.wallId
  )
}

/**
 * Whether the modification request itself asks for the existing structure to
 * be preserved ("保持…不变", "不修改其他墙体", "最小改动", …). Strict wall/
 * opening protection is only enforced when the user asked for it — a resize
 * request ("把卧室扩大") legitimately moves original walls, and enforcing
 * protection there would trap the repair loop on unfixable issues.
 */
export function requestsStructurePreservation(request: string): boolean {
  return /保持[^。；\n]{0,20}不变|不(?:要)?(?:修改|改动|变动|移动)其他|除[^。；\n]{0,30}外[^。；\n]{0,10}不(?:修改|改动|变动)|最小改动|其余[^。；\n]{0,10}保持/.test(request)
}

/**
 * Extract an explicit area range like "6–8㎡ / 6~8平米 / 6-8 平方米" from the
 * request text. Returns null when absent or ambiguous (multiple distinct
 * ranges), so the caller only ever enforces a constraint the user clearly
 * stated once.
 */
export function extractAreaRangeConstraint(text: string): { min: number; max: number } | null {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[–—~～\-至到]\s*(\d+(?:\.\d+)?)\s*(?:㎡|平方米|平米|平)/g)]
  const ranges = new Set(matches.map(m => `${m[1]}|${m[2]}`))
  if (ranges.size !== 1) return null
  const [minRaw, maxRaw] = [...ranges][0]!.split('|')
  const min = Number.parseFloat(minRaw!)
  const max = Number.parseFloat(maxRaw!)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null
  return { min, max }
}

/**
 * Deterministic acceptance for a modification turn. Always checks any
 * explicit added-room area range in the request; additionally enforces
 * original-wall/opening protection when the request asked for preservation.
 * Issue strings are written as repair instructions, since they are forwarded
 * verbatim to the repair-round prompt.
 */
export function checkModificationProtection(
  before: SceneNodeSnapshot,
  after: SceneNodeSnapshot,
  request: string,
): string[] {
  const issues: string[] = []
  if (requestsStructurePreservation(request)) {
    for (const [id, node] of Object.entries(before)) {
      const type = node.type
      if (type !== 'wall' && type !== 'door' && type !== 'window') continue
      const label = type === 'wall' ? '墙' : type === 'door' ? '门' : '窗'
      const current = after[id]
      if (!current) {
        issues.push(`原${label} ${id} 被删除了——用户要求保持原有结构不变，除新增节点外不得删除既有${label}体，请恢复`)
        continue
      }
      const changed = type === 'wall'
        ? wallGeometryFieldsChanged(node, current)
        : openingFieldsChanged(node, current)
      if (changed) {
        issues.push(`原${label} ${id} 的几何（位置/尺寸/宿主）被修改——用户要求保持原有结构不变，请把它恢复为修改前的状态，改用新增隔墙实现需求`)
      }
    }
  }
  const range = extractAreaRangeConstraint(request)
  if (range) {
    for (const [id, node] of Object.entries(after)) {
      if (id in before || node.type !== 'zone' || !isPolygon(node.polygon)) continue
      const area = Math.round(polygonArea(node.polygon) * 100) / 100
      if (area < range.min || area > range.max) {
        const name = typeof node.name === 'string' && node.name ? node.name : id
        issues.push(
          `新增房间「${name}」实测面积 ${area}㎡，不在要求的 ${range.min}–${range.max}㎡ 内。请调整该房间的边界使面积落入范围，并把被它挤占的相邻房间恢复原状`,
        )
      }
    }
  }
  return issues
}

/**
 * `create_room` has no `type` field, only a model-chosen `name`, so this is
 * necessarily a fuzzy keyword match rather than an exact comparison. Scoped
 * to the two things we can check with reasonable confidence: bedroom count
 * (a concrete number in the brief) and presence of support spaces the brief
 * *itself* explicitly asked for.
 *
 * Deliberately does NOT infer "this must be a full home" from bedroom count
 * alone — a brief that only requested N bedrooms should not have a kitchen,
 * bathroom, or living room forced onto it during repair rounds just because
 * it mentioned a number of bedrooms. Only requestedRooms (the brief's own
 * explicit room list) drives which support spaces are checked for.
 */
function compareRoomsToRequirements(
  zones: ZoneSummary[],
  brief: DesignBrief,
  zoneTypes: Record<string, RoomType> = {},
): MismatchFinding[] {
  const issues: MismatchFinding[] = []
  const actualTypes = zones.map(zone => zoneTypes[zone.id] ?? classifyRoomTypeByName(zone.name))
  const bedroomCount = numberFact(brief, ['bedroom_count', 'bedrooms'])
  if (bedroomCount !== undefined && bedroomCount > 0) {
    const actual = actualTypes.filter(type => type === 'bedroom').length
    if (actual < bedroomCount) {
      const params = { expected: bedroomCount, actual }
      issues.push({ message: issueText('zh', 'bedroomShortfall', params), l10n: { id: 'bedroomShortfall', params } })
    }
  }
  const requestedRooms = arrayFact(brief, ['rooms', 'required_rooms', 'function_spaces'])
  const supportSpaces: Array<[string, RegExp, ReadonlySet<RoomType>]> = [
    ['厨房', ROOM_NAME_PATTERNS.kitchen, new Set(['kitchen', 'living_kitchen'])],
    ['卫生间', ROOM_NAME_PATTERNS.bathroom, new Set(['bathroom'])],
    ['客厅', ROOM_NAME_PATTERNS.living, new Set(['living', 'living_kitchen'])],
  ]
  for (const [label, pattern, acceptedTypes] of supportSpaces) {
    const wasRequested = requestedRooms.some(room => pattern.test(room))
    if (wasRequested && !actualTypes.some(type => acceptedTypes.has(type))) {
      const params = { label }
      issues.push({ message: issueText('zh', 'missingSupportSpace', params), l10n: { id: 'missingSupportSpace', params } })
    }
  }
  return issues
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function createSession(input: ChatInput, now: string): WorkflowSession {
  return {
    sessionId: input.sessionId,
    ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    inputType: input.imageDataUrl ? 'image' : 'text',
    phase: 'intake',
    availability: 'partially_usable',
    brief: structuredClone(EMPTY_BRIEF),
    questions: [],
    reasons: [],
    summary: '',
    messages: [],
    clarificationRounds: 0,
    createdAt: now,
    updatedAt: now,
  }
}

export function mergeBrief(current: DesignBrief, extraction: ExtractionResponse): DesignBrief {
  return {
    existingCondition: mergeFacts(current.existingCondition, extraction.existingCondition),
    designGoals: mergeFacts(current.designGoals, extraction.designGoals),
    hardConstraints: mergeFacts(current.hardConstraints, extraction.hardConstraints),
    assumptions: mergeFacts(current.assumptions, extraction.assumptions),
    uncertainties: mergeFacts(current.uncertainties, extraction.uncertainties),
    conflicts: normalizeConflicts(extraction.conflicts, current.conflicts),
  }
}

function mergeFacts(current: RequirementFact[], raw: unknown): RequirementFact[] {
  const map = new Map(current.map(fact => [fact.key, fact]))
  if (!Array.isArray(raw)) return [...map.values()]
  for (const candidate of raw) {
    const fact = normalizeFact(candidate)
    if (fact) map.set(fact.key, fact)
  }
  return [...map.values()]
}

function normalizeFact(raw: unknown): RequirementFact | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.key !== 'string' || typeof value.label !== 'string') return null
  if (!isFactValue(value.value)) return null
  const source = SOURCE_VALUES.has(value.source as InformationSource)
    ? (value.source as InformationSource)
    : 'agent_inference'
  const confirmationStatus = CONFIRMATION_VALUES.has(value.confirmationStatus as ConfirmationStatus)
    ? (value.confirmationStatus as ConfirmationStatus)
    : source === 'user' ? 'confirmed' : 'unconfirmed'
  return {
    key: value.key,
    label: value.label,
    value: value.value,
    source,
    confidence: clampConfidence(value.confidence),
    confirmationStatus,
    ...(typeof value.evidence === 'string' ? { evidence: value.evidence } : {}),
  }
}

function normalizeConflicts(
  raw: unknown,
  current: DesignBrief['conflicts'],
): DesignBrief['conflicts'] {
  const map = new Map(current.map(conflict => [conflict.key, conflict]))
  if (!Array.isArray(raw)) return [...map.values()]
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    if (
      typeof value.key === 'string' &&
      typeof value.existingValue === 'string' &&
      typeof value.requestedValue === 'string' &&
      typeof value.question === 'string'
    ) {
      map.set(value.key, {
        key: value.key,
        existingValue: value.existingValue,
        requestedValue: value.requestedValue,
        question: value.question,
      })
    }
  }
  return [...map.values()]
}

export function evaluateBrief(
  brief: DesignBrief,
  inputType: 'text' | 'image',
  config: Pick<AppConfig, 'usableConfidence' | 'partialConfidence'>,
  lang: Lang = 'zh',
): Evaluation {
  const allFacts = [
    ...brief.existingCondition,
    ...brief.designGoals,
    ...brief.hardConstraints,
    ...brief.assumptions,
  ]
  const keys = new Set(allFacts.map(fact => fact.key.toLowerCase()))
  // Key fragments alone are brittle — the extraction model's key wording
  // drifts (especially at temperature 1). A numeric area/dimension signal in
  // any fact's label/value is just as much geometry as an 'area' key.
  const GEOMETRY_VALUE_PATTERN =
    /(\d+(\.\d+)?\s*(平米|㎡|平方米|m2|m²|sqm|帖|坪))|(\d+(\.\d+)?\s*[x×*]\s*\d+(\.\d+)?\s*(米|m\b))|面积|边界|間口|奥行/i
  const hasGeometry = hasAnyKey(keys, ['area', 'size', 'dimension', 'boundary', 'width', 'depth', 'floor', 'space', '面积'])
    || allFacts.some(fact => GEOMETRY_VALUE_PATTERN.test(`${fact.label} ${formatValue(fact.value)}`))
  // 覆盖常见房型写法："两室一厅"、"2卧1卫1厨"、"3LDK"、"two-bed"——
  // 抽取模型对 key/label 的措辞不稳定（尤其 temperature=1 下），漏判会把
  // 信息完整的请求误送进澄清循环。value 也纳入匹配（房型常在值里）。
  const functionPattern = /(room|bed|living|kitchen|bath|dining|study|ldk|space|function|layout|program|房|室|厅|卧|卫|厨|居|功能|户型)/i
  const hasFunction = brief.designGoals.some(fact =>
    functionPattern.test(`${fact.key} ${fact.label} ${formatValue(fact.value)}`),
  )
  const confidenceFacts = allFacts.filter(fact => fact.source !== 'default_assumption')
  const averageConfidence = confidenceFacts.length > 0
    ? confidenceFacts.reduce((sum, fact) => sum + fact.confidence, 0) / confidenceFacts.length
    : 0
  const reasons: string[] = []
  const questions: string[] = []

  if (!hasGeometry) {
    reasons.push('缺少面积或边界尺寸')
    questions.push(t(lang, 'askFloorArea', {}))
  }
  if (!hasFunction) {
    reasons.push('缺少必要功能空间')
    questions.push(t(lang, 'askRequiredRooms', {}))
  }
  if (brief.conflicts.length > 0) {
    reasons.push('现状与设计目标存在尚未解决的冲突')
    questions.push(...brief.conflicts.map(conflict => conflict.question))
  }
  questions.push(...brief.uncertainties.map(fact =>
    t(lang, 'askConfirmFact', { label: fact.label, value: formatValue(fact.value) })))

  if (inputType === 'image' && averageConfidence < config.partialConfidence && !hasGeometry) {
    return {
      availability: 'unusable',
      reasons: ['图片无法可靠识别主边界、比例或有效户型内容', ...reasons],
      questions: dedupe(questions),
    }
  }
  if (reasons.length > 0 || averageConfidence < config.usableConfidence) {
    return { availability: 'partially_usable', reasons, questions: dedupe(questions) }
  }
  return { availability: 'usable', reasons: [], questions: [] }
}

/**
 * User-facing brief summary in plain language — no confidence numbers or
 * source labels (those read like debug output to a non-expert homeowner).
 * Assumptions and uncertainties are surfaced explicitly as "will be treated
 * as defaults unless you correct them", so confirming is informed consent
 * rather than a silent acceptance of everything the system inferred.
 */
export function formatUserFacingSummary(brief: DesignBrief, lang: Lang = 'zh'): string {
  // Fact labels/values come from extraction in the user's own language; only
  // the frame text is templated.
  const list = (facts: RequirementFact[]) =>
    facts.map(fact => `${fact.label}：${formatValue(fact.value)}`).join('；')
  const lines: string[] = [t(lang, 'summaryIntro', {})]
  if (brief.existingCondition.length > 0) lines.push(t(lang, 'summaryExisting', { list: list(brief.existingCondition) }))
  if (brief.designGoals.length > 0) lines.push(t(lang, 'summaryGoals', { list: list(brief.designGoals) }))
  if (brief.hardConstraints.length > 0) lines.push(t(lang, 'summaryConstraints', { list: list(brief.hardConstraints) }))
  const unconfirmed = [...brief.assumptions, ...brief.uncertainties]
  if (unconfirmed.length > 0) {
    lines.push(t(lang, 'summaryAssumptions', {}))
    for (const fact of unconfirmed) lines.push(`  - ${fact.label}：${formatValue(fact.value)}`)
  }
  for (const conflict of brief.conflicts) {
    lines.push(t(lang, 'summaryConflict', { question: conflict.question }))
  }
  if (lines.length === 1) {
    lines.push(t(lang, 'summaryEmpty', {}))
  }
  return lines.join('\n')
}

export function formatSummary(brief: DesignBrief): string {
  const section = (title: string, facts: RequirementFact[]) => {
    if (facts.length === 0) return `${title}\n- 无`
    return `${title}\n${facts.map(fact =>
      `- ${fact.label}：${formatValue(fact.value)}（${sourceLabel(fact.source)}，置信度 ${fact.confidence.toFixed(2)}）`,
    ).join('\n')}`
  }
  return [
    '结构化需求摘要',
    section('现状基础', brief.existingCondition),
    section('设计目标', brief.designGoals),
    section('硬性约束', brief.hardConstraints),
    section('系统假设', brief.assumptions),
    section('不确定项', brief.uncertainties),
  ].join('\n\n')
}

// Plan-validator targets from the confirmed brief. Bedroom count comes from
// the numeric fact and is reliable. Kitchen/bathroom/living presence comes
// from the fuzzy requested-rooms list, and the validator compares counts
// EXACTLY — so a type is only included when every matching entry plausibly
// names a single room; an entry that embeds its own quantity ("两个卫生间")
// would make entry-counting wrong in both directions, so that type is left
// to the post-build checks instead.
// Deterministic bedroom-count fallback when the extraction produced no
// numeric bedroom_count fact (case-04: "三室两厅两卫" landed only as a
// room_program string, leaving the validator and gate 1 with nothing to
// check). Scans every fact's label+value text for N室/N卧/N bedrooms/NLDK.
const CJK_DIGITS: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const BEDROOM_COUNT_TEXT_PATTERN =
  /([0-9０-９一两二三四五六七八九])\s*(?:间?卧|室(?![内外]))|(\d+)\s*bed(?:room)?s?\b|(\d+)\s*[sl]?l?dk/i

export function bedroomCountFromBriefText(brief: DesignBrief): number | undefined {
  const facts = [...brief.designGoals, ...brief.hardConstraints, ...brief.existingCondition]
  for (const fact of facts) {
    const match = BEDROOM_COUNT_TEXT_PATTERN.exec(`${fact.label} ${formatValue(fact.value)}`)
    if (!match) continue
    const raw = match[1] ?? match[2] ?? match[3]
    if (!raw) continue
    const count = CJK_DIGITS[raw] ?? Number.parseInt(raw.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)), 10)
    if (Number.isFinite(count) && count > 0 && count <= 9) return count
  }
  return undefined
}

export function buildPlanTargets(brief: DesignBrief): PlanTargets {
  const totalAreaSqm = numberFact(brief, FLOOR_AREA_FACT_KEYS)
  const requiredRooms: Array<{ type: RoomType; count: number }> = []
  const bedrooms = numberFact(brief, ['bedroom_count', 'bedrooms'])
    ?? bedroomCountFromBriefText(brief)
  if (bedrooms !== undefined && bedrooms > 0) {
    requiredRooms.push({ type: 'bedroom', count: bedrooms })
  }
  const requested = arrayFact(brief, ['rooms', 'required_rooms', 'room_program', 'function_spaces'])
  const requestedText = requested.join('、')
  const compactCount = (pattern: RegExp): number | undefined => {
    const match = pattern.exec(requestedText.normalize('NFKC'))
    if (!match?.[1]) return undefined
    const raw = match[1]
    return CJK_DIGITS[raw] ?? Number.parseInt(raw, 10)
  }
  const bathroomCount = compactCount(/([1-9一两二三四五六七八九])\s*(?:个|间)?(?:卫(?:生间)?|浴室)/)
  const kitchenCount = compactCount(/([1-9一两二三四五六七八九])\s*(?:个|间)?厨(?:房)?/)
  if (bathroomCount) requiredRooms.push({ type: 'bathroom', count: bathroomCount })
  else if (requested.some(room => ROOM_NAME_PATTERNS.bathroom.test(room))) {
    requiredRooms.push({ type: 'bathroom', count: 1 })
  }
  if (kitchenCount) requiredRooms.push({ type: 'kitchen', count: kitchenCount })
  else if (requested.some(room => ROOM_NAME_PATTERNS.kitchen.test(room))) {
    requiredRooms.push({ type: 'kitchen', count: 1 })
  }
  if (requested.some(room => ROOM_NAME_PATTERNS.living.test(room) || /厅/.test(room))) {
    requiredRooms.push({ type: 'living', count: 1 })
  }
  return {
    ...(totalAreaSqm !== undefined && totalAreaSqm > 0 ? { totalAreaSqm } : {}),
    ...(requiredRooms.length > 0 ? { requiredRooms } : {}),
  }
}

// Room types the brief EXPLICITLY requests exterior windows for (gate 4 only
// covers explicit requests; default lighting preferences live in the plan).
// Scans every fact whose key/label/value mentions windows and maps the room
// words found alongside.
export function windowRoomTypesFromBrief(brief: DesignBrief): RoomType[] {
  const roomTypes: RoomType[] = ['bedroom', 'living', 'study', 'kitchen', 'dining', 'bathroom']
  const types = new Set<RoomType>()
  for (const fact of [
    ...brief.designGoals, ...brief.hardConstraints, ...brief.existingCondition, ...brief.assumptions,
  ]) {
    const text = `${fact.key} ${fact.label} ${formatValue(fact.value)}`
    if (!WINDOW_PATTERN.test(text)) continue
    for (const type of roomTypes) {
      if (roomNamePattern(type)?.test(text)) types.add(type)
    }
  }
  return [...types]
}

// Structural node types the repair rounds must never touch (§5: 修复 prompt
// 禁改房间结构，本函数是其确定性兜底). Doors/windows/items are legitimately
// repairable and deliberately absent.
const STRUCTURE_NODE_TYPES = new Set(['wall', 'zone', 'slab', 'ceiling'])

// Geometry drift of structural nodes between two scene snapshots: additions,
// deletions, and moved/resized walls or room polygons. Same 1mm epsilon as
// checkModificationProtection.
export function structuralDrift(before: SceneNodeSnapshot, after: SceneNodeSnapshot): string[] {
  const drift: string[] = []
  const structural = (snapshot: SceneNodeSnapshot) =>
    Object.entries(snapshot).filter(([, node]) => STRUCTURE_NODE_TYPES.has(String(node.type)))
  const beforeMap = new Map(structural(before))
  const afterMap = new Map(structural(after))
  for (const [id, node] of beforeMap) {
    if (!afterMap.has(id)) drift.push(`结构节点被删除：${String(node.type)} ${id}`)
  }
  for (const [id, node] of afterMap) {
    if (!beforeMap.has(id)) drift.push(`新增了结构节点：${String(node.type)} ${id}`)
  }
  const geomEqual = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= GEOM_FIELD_EPS
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((value, i) => geomEqual(value, b[i]))
    }
    return a === b
  }
  for (const [id, beforeNode] of beforeMap) {
    const afterNode = afterMap.get(id)
    if (!afterNode) continue
    for (const field of ['start', 'end', 'polygon', 'thickness', 'height'] as const) {
      if (field in beforeNode || field in afterNode) {
        if (!geomEqual(beforeNode[field], afterNode[field])) {
          drift.push(`结构节点 ${String(beforeNode.type)} ${id} 的 ${field} 被修改`)
          break
        }
      }
    }
  }
  return drift
}

// Compact plan facts for the furnishing / repair prompts: the room list is
// settled and the model must treat it as read-only ground truth.
export function formatPlanSnapshot(plan: LayoutPlan): string {
  const nameById = new Map(plan.rooms.map(room => [room.id, room.name]))
  const rooms = plan.rooms.map(room => {
    const entry = room.id === plan.entry.roomId ? '，入户' : ''
    return `- ${room.name}（${room.type}，约 ${round1(polygonArea(room.polygon))}㎡${entry}）`
  }).join('\n')
  const doors = plan.connections
    .map(conn => `${nameById.get(conn.from) ?? conn.from}↔${nameById.get(conn.to) ?? conn.to}`)
    .join('、')
  return `既定房间计划（只读事实，不可改动）：\n${rooms}\n房间连通（均已开门）：${doors || '无'}`
}

function buildGenerationArgs(session: WorkflowSession): Record<string, unknown> {
  const bedrooms = numberFact(session.brief, ['bedroom_count', 'bedrooms'])
  const rooms = arrayFact(session.brief, ['rooms', 'required_rooms', 'function_spaces'])
  const widthM = numberFact(session.brief, ['width_m', 'room_width_m', 'width'])
  const depthM = numberFact(session.brief, [
    'depth_m',
    'length_m',
    'room_depth_m',
    'room_length_m',
    'depth',
    'length',
  ])
  const floorAreaM2 = numberFact(session.brief, [
    'floor_area_sqm',
    'area_sqm',
    'room_area_sqm',
    'area',
  ])
  const style = stringFact(session.brief, ['style', 'design_style'])
  const constraints = session.brief.hardConstraints
    .map(fact => `${fact.label}: ${formatValue(fact.value)}`)
    .join('; ')
  return {
    brief: session.summary || formatSummary(session.brief),
    ...(session.sceneId ? { projectId: session.sceneId } : {}),
    projectName: 'Pascal AI 户型方案',
    ...(bedrooms !== undefined ? { bedroomCount: bedrooms } : {}),
    ...(rooms.length > 0 ? { rooms } : {}),
    ...(widthM !== undefined ? { widthM } : {}),
    ...(depthM !== undefined ? { depthM } : {}),
    ...(floorAreaM2 !== undefined ? { floorAreaM2 } : {}),
    ...(style ? { style } : {}),
    ...(constraints ? { constraints } : {}),
  }
}

// place_item's `rotation` parameter is interpreted as radians by the scene
// renderer (Three.js convention), but nothing in the tool's schema or
// description tells the model that — so it reliably supplies degree-shaped
// values instead (0, 90, 180, 270), which then get applied as radians and
// spin the item into an almost-arbitrary orientation. We can't add a unit
// hint to the MCP tool itself (out of scope here), so we correct it at the
// boundary instead: a genuine single-axis radian value for a sane rotation
// is always within one full turn (±2π); anything larger than that is
// unambiguously a degree value that slipped through, so we reinterpret it
// as degrees and convert before forwarding the call to MCP.
const RADIAN_SANITY_BOUND = Math.PI * 2 + 0.01

function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== 'place_item') return args
  const rotation = args.rotation
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) return args
  if (Math.abs(rotation) <= RADIAN_SANITY_BOUND) return args
  return { ...args, rotation: (rotation * Math.PI) / 180 }
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function isFactValue(value: unknown): value is RequirementFact['value'] {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every(item => typeof item === 'string'))
  )
}

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, Math.round(value * 100) / 100))
    : 0.5
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function hasAnyKey(keys: Set<string>, fragments: string[]): boolean {
  return [...keys].some(key => fragments.some(fragment => key.includes(fragment)))
}

function formatValue(value: RequirementFact['value']): string {
  return Array.isArray(value) ? value.join('、') : String(value)
}

function sourceLabel(source: InformationSource): string {
  return {
    user: '用户提供',
    system_recognition: '系统识别',
    agent_inference: 'Agent 推断',
    default_assumption: '默认假设',
    pending_confirmation: '待确认',
  }[source]
}

function facts(brief: DesignBrief): RequirementFact[] {
  return [...brief.existingCondition, ...brief.designGoals, ...brief.hardConstraints, ...brief.assumptions]
}

function findFact(brief: DesignBrief, keys: string[]): RequirementFact | undefined {
  return facts(brief).find(fact => keys.includes(fact.key.toLowerCase()))
}

function numberFact(brief: DesignBrief, keys: string[]): number | undefined {
  const value = findFact(brief, keys)?.value
  return numericFactValue(value)
}

function arrayFact(brief: DesignBrief, keys: string[]): string[] {
  const value = findFact(brief, keys)?.value
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value.split(/[,，、]/).map(item => item.trim()).filter(Boolean) : []
}

function stringFact(brief: DesignBrief, keys: string[]): string | undefined {
  const value = findFact(brief, keys)?.value
  return typeof value === 'string' ? value : undefined
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// `count` is the number of *content* nodes (scaffolding excluded, see
// `countActiveContentNodes`). Any real content at all means the scene is the
// user's existing work and must be modified incrementally rather than cleared
// and rebuilt.
export function shouldModifyExistingScene(count: number): boolean {
  return count > 0
}

function isSceneIntent(value: unknown): value is SceneIntent {
  return value === 'query' || value === 'create' || value === 'update' ||
    value === 'delete' || value === 'ambiguous' || value === 'off_topic'
}

function isCollision(value: unknown): value is { aId: string; bId: string; kind: string } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.aId === 'string' && typeof record.bId === 'string' && typeof record.kind === 'string'
}

function latestAssistantReply(session: WorkflowSession): string {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index]
    if (message?.role === 'assistant' && typeof message.content === 'string') return message.content
  }
  return ''
}

function promptAudit(prompt: PromptAuditMetadata): PromptAuditMetadata {
  return {
    promptVersion: prompt.promptVersion,
    promptHash: prompt.promptHash,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
