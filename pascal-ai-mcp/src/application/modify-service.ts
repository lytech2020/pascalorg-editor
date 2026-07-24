import type { GateFailure } from '../completion-gates'
import { requirementLabelsSatisfiedBy } from '../furniture-checklist'
import { t } from '../lang/i18n'
import type { LayoutPlan } from '../layout-plan'
import type { ChatMessage, WorkflowSession } from '../types'
import type { DiagnosticsSummary } from './generate-service'
import { finishSceneWorkflow, publicEditorUrl } from './generate-service'
import type { WorkflowGraphState } from '../workflow-state'
import { renderPrompt } from '../prompts/registry'

export type IntentRemoval = { roomName: string; itemName: string }

export type SceneNodeSnapshot = Record<string, Record<string, unknown>>

export type ModifyPhaseResult = {
  messages: ChatMessage[]
  toolNamesUsed: Set<string>
  furnitureIssues: string[]
}

export type ModifyWorkflowDependencies = {
  persistSession: (session: WorkflowSession) => void
  loadScene: (session: WorkflowSession, sceneId: string) => Promise<Record<string, unknown>>
  runPlanFirst: (
    session: WorkflowSession,
    feedback: string,
    sceneId: string,
    loadedVersion: number | null,
  ) => Promise<Partial<WorkflowGraphState>>
  snapshotScene: (session: WorkflowSession) => Promise<SceneNodeSnapshot>
  runLegacyPhase: (session: WorkflowSession, purpose: string) => Promise<ModifyPhaseResult>
  dedupeSharedWalls: (
    sessionId: string,
    levelId: string | null,
    protectedWallIds: Set<string>,
  ) => Promise<void>
  checkProtection: (
    session: WorkflowSession,
    before: SceneNodeSnapshot,
    after: SceneNodeSnapshot,
    feedback: string,
  ) => Promise<string[]>
  refine: (
    session: WorkflowSession,
    purpose: string,
    phase: ModifyPhaseResult,
    extraChecks?: () => Promise<string[]>,
  ) => Promise<{
    diagnostics: DiagnosticsSummary
    repairRounds: number
    toolNamesUsed: Set<string>
    furnitureIssues: string[]
  }>
  persistScene: (
    sessionId: string,
    sceneId: string,
    valid: boolean,
    expectedVersion: number | null,
  ) => Promise<number | null>
  evaluateGates: (session: WorkflowSession) => Promise<{
    report: { passed: boolean; failures: GateFailure[] }
    layoutQuality: number
  }>
  clearDestructiveWrite: (sessionId: string) => boolean
  isCancellationError: (error: unknown) => boolean
  errorMessage: (error: unknown) => string
  planSnapshot: (plan: LayoutPlan) => string
}

export async function runModifyWorkflow(
  state: WorkflowGraphState,
  dependencies: ModifyWorkflowDependencies,
): Promise<Partial<WorkflowGraphState>> {
  const session = structuredClone(state.session)
  const feedback = session.pendingModification ?? state.input.message?.trim() ?? ''
  const operation = session.pendingOperation ?? 'update'
  const sceneId = session.sceneResult?.sceneId ?? session.sceneId
  if (!sceneId) {
    session.phase = 'failed'
    return { session, reply: t(session.language, 'modifyNoScene', {}), next: 'finish' }
  }

  try {
    session.toolTrace = []
    dependencies.persistSession(session)
    const loaded = await dependencies.loadScene(session, sceneId)
    const loadedVersion = finiteNumber(loaded.version)
    if (process.env.PASCAL_MODIFY_LEGACY !== '1') {
      return await dependencies.runPlanFirst(session, feedback, sceneId, loadedVersion)
    }

    const legacyNoSnapshot = !session.layoutIntent || !session.layoutPlan
    const isDeleteOperation = operation === 'delete'
    const beforeNodes = isDeleteOperation ? {} : await dependencies.snapshotScene(session)
    const protectedWallIds = new Set(
      Object.entries(beforeNodes).filter(([, node]) => node.type === 'wall').map(([id]) => id),
    )
    const levelId = Object.entries(beforeNodes).find(([, node]) => node.type === 'level')?.[0] ?? null
    const planSnapshot = session.layoutPlan && !isDeleteOperation
      ? `\n${dependencies.planSnapshot(session.layoutPlan)}`
      : ''
    const modificationGuard = renderPrompt('modification-guard', {}).parts.content
    const purpose = isDeleteOperation
      ? `用户已确认对当前场景执行${operation}操作：${feedback}`
      : `用户已确认对当前场景执行${operation}操作：${feedback}\n${modificationGuard}${planSnapshot}`
    const phase = await dependencies.runLegacyPhase(session, purpose)
    if (!isDeleteOperation) {
      await dependencies.dedupeSharedWalls(session.sessionId, levelId, protectedWallIds)
    }
    const extraChecks = isDeleteOperation
      ? undefined
      : async () => dependencies.checkProtection(
        session,
        beforeNodes,
        await dependencies.snapshotScene(session),
        feedback,
      )
    const { diagnostics, repairRounds, toolNamesUsed, furnitureIssues } = await dependencies.refine(
      session,
      purpose,
      phase,
      extraChecks,
    )
    const sceneVersion = await dependencies.persistScene(
      session.sessionId,
      sceneId,
      diagnostics.validation.valid === true,
      loadedVersion,
    )
    const gates = await dependencies.evaluateGates(session)
    delete session.pendingModification
    delete session.pendingOperation
    delete session.pendingModificationMode
    delete session.pendingModificationReasonCode
    delete session.pendingModificationPlanHash
    delete session.pendingModifyPlan
    delete session.pendingClearTargets
    delete session.modifyModeConfirmed
    delete session.modifyDriftConfirmed
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
      successText: t(session.language, 'modifySuccess', {}),
      replySuffix: legacyNoSnapshot ? t(session.language, 'modifyLegacyNoSnapshot', {}) : undefined,
      layoutQuality: gates.layoutQuality,
    })
    return { session, reply, next: 'finish' }
  } catch (error) {
    // R1.4: the failure wording is driven by the REAL side-effect state, not a
    // pre-call guess. `no_write` (including a definitively-rejected write) is a
    // safe, recoverable failure — never the "scene may be partially modified"
    // warning. Confirmed / partial writes keep that warning; a result-unknown
    // write gets its own honest wording and is never auto-replayed.
    // Consume the in-memory destructive-write guard exactly once. A structural
    // rebuild that entered the destructive clear is treated as a confirmed
    // write regardless of the ledger.
    const wasDestructiveRebuild = dependencies.clearDestructiveWrite(session.sessionId)
    const writeEffect = session.destructiveSceneWriteStarted === true || wasDestructiveRebuild
      ? 'write_confirmed'
      : session.modificationWriteEffect ?? 'no_write'
    const clearModifyState = () => {
      delete session.destructiveSceneWriteStarted
      delete session.modificationWriteEffect
      delete session.pendingModification
      delete session.pendingOperation
      delete session.pendingModificationMode
      delete session.pendingModificationReasonCode
      delete session.pendingModificationPlanHash
      delete session.pendingModifyPlan
      delete session.pendingClearTargets
      delete session.modifyModeConfirmed
      delete session.modifyDriftConfirmed
    }
    if (writeEffect === 'write_confirmed' || writeEffect === 'partial_write_confirmed') {
      clearModifyState()
      session.phase = session.sceneResult ? 'completed_with_issues' : 'failed'
      const reply = t(session.language, 'modifyDestructiveFailed', {
        sceneId,
        error: dependencies.errorMessage(error),
      })
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }
    if (writeEffect === 'write_attempted') {
      // A mutation's result is unknown (transport failure). Do not claim the
      // scene is fine, and do not auto-retry — surface the uncertainty.
      clearModifyState()
      session.phase = session.sceneResult ? 'completed_with_issues' : 'failed'
      const reply = t(session.language, 'modifyResultUnknown', {
        sceneId,
        error: dependencies.errorMessage(error),
      })
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }
    // no_write: nothing committed — safe to recover / re-submit.
    delete session.modificationWriteEffect
    if (dependencies.isCancellationError(error)) {
      return finishModificationFailure(session, 'cancelled')
    }
    return finishModificationFailure(session, 'failed', dependencies.errorMessage(error))
  }
}

export function effectiveGateFailures(
  failures: GateFailure[],
  baseline: GateFailure[],
  removals: IntentRemoval[],
): { effective: GateFailure[]; waived: GateFailure[] } {
  const baselineKeys = new Set(baseline.map(failure => failure.message))
  const removalCovers = (failure: GateFailure): boolean => {
    const l10n = failure.l10n
    if (!l10n || (l10n.id !== 'gateMissingEquipment' && l10n.id !== 'gateMissingBedroomFurniture')) return false
    const room = String(l10n.params.room ?? '')
    const label = String(l10n.params.label ?? '')
    return removals.some(removal =>
      room.length > 0 && removal.roomName.length > 0
      && (room.includes(removal.roomName) || removal.roomName.includes(room))
      && requirementLabelsSatisfiedBy(removal.itemName).includes(label))
  }
  const effective: GateFailure[] = []
  const waived: GateFailure[] = []
  for (const failure of failures) {
    (baselineKeys.has(failure.message) || removalCovers(failure) ? waived : effective).push(failure)
  }
  return { effective, waived }
}

export function modifyFailureRecovery(
  hasPendingModification: boolean,
  hasSceneResult: boolean,
): { canRetry: boolean; phase: WorkflowSession['phase'] } {
  return {
    canRetry: hasPendingModification,
    phase: hasPendingModification
      ? 'awaiting_modification_confirmation'
      : (hasSceneResult ? 'completed_with_issues' : 'failed'),
  }
}

export function finishModificationFailure(
  session: WorkflowSession,
  kind: 'cancelled' | 'failed',
  publicError?: string,
): { session: WorkflowSession; reply: string; next: 'finish' } {
  if (kind === 'cancelled') {
    session.phase = 'awaiting_modification_confirmation'
    const reply = t(session.language, 'modifyCancelled', {})
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }
  const recovery = modifyFailureRecovery(Boolean(session.pendingModification), Boolean(session.sceneResult))
  session.phase = recovery.phase
  const reply = recovery.canRetry
    ? t(session.language, 'modifyFailedRetry', { error: publicError ?? '' })
    : t(session.language, 'modifyFailedNoRetry', { error: publicError ?? '' })
  session.messages.push({ role: 'assistant', content: reply })
  return { session, reply, next: 'finish' }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
