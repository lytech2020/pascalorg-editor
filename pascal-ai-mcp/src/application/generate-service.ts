import type { GateFailure, GateReport } from '../completion-gates'
import { issueText, t, type Lang } from '../lang/i18n'
import type { LayoutPlan } from '../layout-plan'
import type { PlanBuildResult } from '../plan-builder'
import type { FurniturePlacementIssue, SceneResult, WorkflowSession } from '../types'
import type { WorkflowGraphState } from '../workflow-state'

export type DiagnosticsSummary = {
  validation: { valid?: boolean; errors: string[] }
  verificationIssues: string[]
  collisions: Array<{ aId: string; bId: string; kind: string }>
  doorlessRooms: string[]
  strayWindows: string[]
  requirementMismatches: string[]
  isolatedBedrooms: string[]
  furniturePlacementIssues?: FurniturePlacementIssue[]
  strayWallIds?: string[]
  mismatchL10n?: Array<{
    id: 'zoneOverlap' | 'totalAreaOff' | 'bedroomShortfall' | 'missingSupportSpace'
    params: Record<string, string | number>
  }>
}

export type FinishSceneWorkflowArgs = {
  session: WorkflowSession
  sceneId: string | null
  editorUrl: string | null
  version: number | null
  diagnostics: DiagnosticsSummary
  repairRounds: number
  toolNamesUsed: Set<string>
  furnitureIssues: string[]
  gateFailures: GateFailure[]
  gatesPassed: boolean
  successText: string
  replySuffix?: string
  executionIssues?: string[]
  layoutQuality?: number
  furniture?: { placed: number; required: number }
}

const FURNITURE_TOOLS = new Set(['place_item', 'furnish_room', 'apply_patch'])

export type GenerateConstructionResult = {
  diagnostics: DiagnosticsSummary
  repairRounds: number
  toolNamesUsed: Set<string>
  furnitureIssues: string[]
  executionIssues: string[]
  structureViolations: string[]
  gates: GateReport
  layoutQuality: number
  structuralFailures: string[]
  furnitureCounts: { placed: number; required: number }
}

export type GenerateWorkflowDependencies = {
  persistSession: (session: WorkflowSession) => void
  runStep: <T>(
    session: WorkflowSession,
    operationKey: string,
    work: () => Promise<T>,
    accepts?: (result: T) => boolean,
    rejectedErrorCode?: string,
  ) => Promise<T>
  buildGenerationArgs: (session: WorkflowSession) => Record<string, unknown>
  loadScene: (session: WorkflowSession, sceneId: string) => Promise<Record<string, unknown>>
  countActiveContentNodes: (sessionId: string) => Promise<number>
  shouldModifyExistingScene: (count: number) => boolean
  applyToExistingScene: (
    session: WorkflowSession,
    loaded: Record<string, unknown>,
  ) => Promise<Partial<WorkflowGraphState>>
  buildPlan: (session: WorkflowSession, failures?: string[]) => Promise<PlanBuildResult>
  renderPlanFailure: (message: string, index: number, plan: PlanBuildResult) => string
  startFreshBuild: (session: WorkflowSession) => string
  createScaffold: (
    session: WorkflowSession,
    args: Record<string, unknown>,
  ) => Promise<{ sceneId: string | null; levelId: string | null; version: number | null }>
  identifyFreshBuild: (buildId: string, sceneId: string) => Promise<void>
  updateFreshBuildBoundary: (buildId: string, sessionId: string, sceneId: string) => Promise<void>
  clearLevel: (session: WorkflowSession, levelId: string | null) => Promise<void>
  construct: (
    session: WorkflowSession,
    levelId: string | null,
    plan: LayoutPlan,
    persistAfterRound: (valid: boolean) => Promise<void>,
  ) => Promise<GenerateConstructionResult>
  persistScene: (
    sessionId: string,
    sceneId: string | undefined,
    valid: boolean,
    expectedVersion: number | null,
  ) => Promise<number | null>
  succeedFreshBuild: (buildId: string, sessionId: string, sceneId: string) => Promise<void>
  abandonFreshBuild: (buildId: string, errorCode: string) => void
  isCancellationError: (error: unknown) => boolean
  errorMessage: (error: unknown) => string
}

export async function runGenerateWorkflow(
  state: WorkflowGraphState,
  preparedPlan: boolean,
  dependencies: GenerateWorkflowDependencies,
): Promise<Partial<WorkflowGraphState>> {
  const session = structuredClone(state.session)
  const priorSceneId = session.sceneId
  let freshBuildId: string | undefined
  try {
    if (!preparedPlan) {
      session.executionSteps = []
      session.toolTrace = []
      dependencies.persistSession(session)
    }
    const generationArgs = dependencies.buildGenerationArgs(session)
    if (session.sceneId) {
      const loaded = await dependencies.loadScene(session, session.sceneId)
      const contentNodes = await dependencies.countActiveContentNodes(session.sessionId)
      if (dependencies.shouldModifyExistingScene(contentNodes)) {
        return await dependencies.runStep(
          session,
          'modify',
          () => dependencies.applyToExistingScene(session, loaded),
        )
      }
      const expectedVersion = finiteNumber(loaded.version)
      if (expectedVersion !== null) generationArgs.expectedVersion = expectedVersion
    }

    let activePlan = preparedPlan ? session.layoutPlan : undefined
    if (!activePlan) {
      const planned = await dependencies.runStep(
        session,
        'plan',
        () => dependencies.buildPlan(session),
        result => result.ok,
        'plan_rejected',
      )
      if (!planned.ok) {
        session.phase = 'failed'
        const reply = t(session.language, 'planRejected', {
          rounds: planned.modelCalls,
          list: planned.failures
            .map((failure, index) => `- ${dependencies.renderPlanFailure(failure, index, planned)}`)
            .join('\n'),
        })
        session.messages.push({ role: 'assistant', content: reply })
        return { session, reply, next: 'finish' }
      }
      if (planned.intent) session.layoutIntent = planned.intent
      activePlan = planned.plan
      session.layoutPlan = activePlan
      dependencies.persistSession(session)
    }

    if (!priorSceneId) freshBuildId = dependencies.startFreshBuild(session)
    const created = await dependencies.runStep(
      session,
      'scaffold',
      () => dependencies.createScaffold(session, generationArgs),
    )
    session.sceneId = created.sceneId ?? undefined
    if (freshBuildId && session.sceneId) {
      await dependencies.identifyFreshBuild(freshBuildId, session.sceneId)
      await dependencies.updateFreshBuildBoundary(freshBuildId, session.sessionId, session.sceneId)
    }
    const persistAfterRound = async (valid: boolean) => {
      await dependencies.persistScene(session.sessionId, session.sceneId, valid, created.version)
      if (freshBuildId && session.sceneId) {
        await dependencies.updateFreshBuildBoundary(freshBuildId, session.sessionId, session.sceneId)
      }
    }
    await dependencies.clearLevel(session, created.levelId)
    let construction = await dependencies.construct(session, created.levelId, activePlan, persistAfterRound)
    if (construction.structuralFailures.length > 0) {
      const replanned = await dependencies.runStep(
        session,
        'plan',
        () => dependencies.buildPlan(session, construction.structuralFailures),
        result => result.ok,
        'plan_rejected',
      )
      if (replanned.ok) {
        if (replanned.intent) session.layoutIntent = replanned.intent
        activePlan = replanned.plan
        session.layoutPlan = activePlan
        dependencies.persistSession(session)
        await dependencies.clearLevel(session, created.levelId)
        construction = await dependencies.construct(session, created.levelId, activePlan, persistAfterRound)
      }
    }

    const { diagnostics, repairRounds, toolNamesUsed, furnitureIssues, executionIssues } = construction
    const sceneVersion = await dependencies.persistScene(
      session.sessionId,
      session.sceneId,
      diagnostics.validation.valid === true,
      created.version,
    )
    if (freshBuildId && session.sceneId) {
      await dependencies.succeedFreshBuild(freshBuildId, session.sessionId, session.sceneId)
    }
    const sceneId = created.sceneId
    const { reply } = finishSceneWorkflow({
      session,
      sceneId,
      editorUrl: publicEditorUrl(sceneId),
      version: sceneVersion,
      diagnostics,
      repairRounds,
      toolNamesUsed,
      furnitureIssues,
      gateFailures: construction.gates.failures,
      gatesPassed: construction.gates.passed,
      successText: t(session.language, 'generateSuccess', { url: publicEditorUrl(sceneId) }),
      executionIssues: [...executionIssues, ...construction.structureViolations],
      layoutQuality: construction.layoutQuality,
      furniture: construction.furnitureCounts,
    })
    return { session, reply, next: 'finish' }
  } catch (error) {
    const abandonedSceneId = session.sceneId !== priorSceneId ? session.sceneId : undefined
    if (session.sceneId !== priorSceneId) {
      if (session.sceneId) {
        console.warn(`[pascal-ai-mcp] abandoned half-built scene ${session.sceneId} after generate failure`)
      }
      session.sceneId = priorSceneId
    }
    if (freshBuildId) {
      dependencies.abandonFreshBuild(
        freshBuildId,
        dependencies.isCancellationError(error) ? 'cancelled_by_user' : 'scene_build_failed',
      )
    }
    if (dependencies.isCancellationError(error)) {
      session.phase = 'cancelled'
      const reply = [
        t(session.language, 'generateCancelled', {}),
        ...(abandonedSceneId
          ? [t(session.language, 'generateAbandonedScene', { sceneId: abandonedSceneId })]
          : []),
      ].join('\n')
      session.messages.push({ role: 'assistant', content: reply })
      return { session, reply, next: 'finish' }
    }
    session.phase = 'failed'
    const reply = [
      t(session.language, 'generateFailed', { error: dependencies.errorMessage(error) }),
      ...(abandonedSceneId
        ? [t(session.language, 'generateAbandonedScene', { sceneId: abandonedSceneId })]
        : []),
    ].join('\n')
    session.messages.push({ role: 'assistant', content: reply })
    return { session, reply, next: 'finish' }
  }
}

export function publicEditorUrl(sceneId: string | null): string | null {
  return sceneId ? `/scene/${encodeURIComponent(sceneId)}` : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function countDiagnosticIssues(diagnostics: DiagnosticsSummary): number {
  return diagnostics.validation.errors.length
    + diagnostics.verificationIssues.length
    + diagnostics.collisions.length
    + diagnostics.doorlessRooms.length
    + diagnostics.strayWindows.length
    + diagnostics.requirementMismatches.length
    + diagnostics.isolatedBedrooms.length
    + (diagnostics.furniturePlacementIssues?.length ?? 0)
}

export function countAllIssues(diagnostics: DiagnosticsSummary, furnitureIssues: string[]): number {
  return countDiagnosticIssues(diagnostics) + furnitureIssues.length
}

export function describeRemainingIssues(
  diagnostics: DiagnosticsSummary,
  lang: Lang = 'zh',
  limit = 5,
): string {
  const mismatchCount = diagnostics.mismatchL10n?.length ?? 0
  const mismatches = diagnostics.mismatchL10n
    ? [
        ...diagnostics.mismatchL10n.map(entry => issueText(lang, entry.id, entry.params as never)),
        ...diagnostics.requirementMismatches.slice(mismatchCount),
      ]
    : diagnostics.requirementMismatches
  const strayWindows = diagnostics.strayWallIds
    ? diagnostics.strayWallIds.map(wallId => issueText(lang, 'strayWindow', { wallId }))
    : diagnostics.strayWindows
  const items = [
    ...diagnostics.validation.errors,
    ...diagnostics.verificationIssues,
    ...diagnostics.collisions.map(c => issueText(lang, 'collision', { a: c.aId, b: c.bId, kind: c.kind })),
    ...diagnostics.doorlessRooms.map(room => issueText(lang, 'doorlessRoom', { room })),
    ...strayWindows,
    ...mismatches,
    ...diagnostics.isolatedBedrooms.map(room => issueText(lang, 'isolatedBedroom', { room })),
    ...(diagnostics.furniturePlacementIssues ?? []).map(issue => renderPlacementIssue(issue, lang)),
  ]
  if (items.length === 0) return ''
  const shown = items.slice(0, limit).map(item => `- ${item}`).join('\n')
  const more = items.length > limit ? t(lang, 'moreItems', { count: items.length - limit }) : ''
  return `\n${shown}${more}`
}

export function buildCompletionReply(args: {
  lang: Lang
  successText: string
  repairRounds: number
  diagnostics: DiagnosticsSummary
  toolNamesUsed: Set<string>
  furnitureIssues: string[]
  gateFailures?: GateFailure[]
}): string {
  const structural = countDiagnosticIssues(args.diagnostics)
  const furniture = args.furnitureIssues.length
  const gates = args.gateFailures?.length ?? 0
  const generalNote = [...args.toolNamesUsed].some(name => FURNITURE_TOOLS.has(name))
    ? t(args.lang, 'furnitureGeneralNote', {})
    : ''
  if (structural === 0 && furniture === 0 && gates === 0) return `${args.successText}${generalNote}`
  const parts: string[] = []
  if (structural > 0) {
    parts.push(t(args.lang, 'repairCapReached', {
      rounds: args.repairRounds,
      count: structural,
      list: describeRemainingIssues(args.diagnostics, args.lang),
    }))
  }
  if (gates > 0) {
    const list = args.gateFailures!.map(failure => `- ${renderGateFailure(failure, args.lang)}`).join('\n')
    parts.push(t(args.lang, 'gatesNotPassed', { count: gates, list }))
  }
  if (furniture > 0) parts.push(describeFurnitureIssues(args.furnitureIssues, args.lang))
  return `${parts.join('\n\n')}${t(args.lang, 'remainingIssuesHint', {})}${generalNote}`
}

export function finishSceneWorkflow(args: FinishSceneWorkflowArgs): {
  sceneResult: SceneResult
  reply: string
} {
  const remainingIssueCount = countAllIssues(args.diagnostics, args.furnitureIssues)
  const sceneResult: SceneResult = {
    sceneId: args.sceneId,
    editorUrl: args.editorUrl,
    version: args.version,
    validation: {
      valid: args.diagnostics.validation.valid ?? args.diagnostics.validation.errors.length === 0,
      errors: args.diagnostics.validation.errors,
    },
    verificationIssues: args.diagnostics.verificationIssues,
    collisions: args.diagnostics.collisions,
    doorlessRooms: args.diagnostics.doorlessRooms,
    strayWindows: args.diagnostics.strayWindows,
    requirementMismatches: args.diagnostics.requirementMismatches,
    isolatedBedrooms: args.diagnostics.isolatedBedrooms,
    furnitureIssues: args.furnitureIssues,
    furniturePlacement: args.diagnostics.furniturePlacementIssues,
    repairRounds: args.repairRounds,
    remainingIssueCount,
    modelCallsUsed: (args.session.toolTrace ?? []).reduce((sum, trace) => sum + trace.modelCalls, 0),
    gateFailures: args.gateFailures.map(failure => failure.message),
    ...(args.executionIssues ? { executionIssues: args.executionIssues } : {}),
    ...(args.layoutQuality !== undefined ? { layoutQuality: args.layoutQuality } : {}),
    ...(args.furniture ? { furniture: args.furniture } : {}),
  }
  args.session.sceneResult = sceneResult
  args.session.phase = remainingIssueCount === 0 && args.gatesPassed
    ? 'completed'
    : 'completed_with_issues'
  const completionReply = buildCompletionReply({
    lang: args.session.language ?? 'en',
    successText: args.successText,
    repairRounds: args.repairRounds,
    diagnostics: args.diagnostics,
    toolNamesUsed: args.toolNamesUsed,
    furnitureIssues: args.furnitureIssues,
    gateFailures: args.gateFailures,
  })
  const reply = args.replySuffix
    ? [completionReply, args.replySuffix].join('\n')
    : completionReply
  args.session.messages.push({ role: 'assistant', content: reply })
  return { sceneResult, reply }
}

function renderPlacementIssue(issue: FurniturePlacementIssue, lang: Lang): string {
  if (lang === 'zh') return issue.message
  const item = issue.itemName || issue.itemId
  switch (issue.kind) {
    case 'overlap':
      return issueText(lang, 'placementOverlap', { item, other: issue.otherItemId ?? '?' })
    case 'out_of_bounds':
      return issueText(lang, 'placementOutOfBounds', { item, room: issue.room ?? null })
    case 'door_clearance':
      return issueText(lang, 'placementDoorClearance', { item })
    default:
      return issue.message
  }
}

function describeFurnitureIssues(furnitureIssues: string[], lang: Lang, limit = 5): string {
  const shown = furnitureIssues.slice(0, limit).map(issue => `- ${issue}`).join('\n')
  return t(lang, 'furnitureIssuesSummary', {
    count: furnitureIssues.length,
    list: shown,
    moreCount: Math.max(0, furnitureIssues.length - limit),
  })
}

function renderGateFailure(failure: GateFailure, lang: Lang): string {
  if (lang === 'zh' || !failure.l10n) return failure.message
  try {
    const render = issueText as (language: Lang, id: string, params: unknown) => string
    return render(lang, failure.l10n.id, failure.l10n.params)
  } catch {
    return failure.message
  }
}
