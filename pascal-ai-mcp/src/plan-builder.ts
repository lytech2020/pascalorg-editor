// ---------------------------------------------------------------------------
// Plan builder (GENERATION_REDESIGN.md §1 steps ①–③): the only place a model
// appears between brief confirmation and scene construction.
//
// The model outputs a LayoutIntent (semantics only, no coordinates); the
// deterministic partitioner turns it into a LayoutPlan; the validator judges
// the plan. Fatal findings — parse defects, partitioner dead-ends, validator
// violations — are quoted back in a correction prompt and the model retries,
// up to `maxRounds` total attempts. Everything here runs BEFORE any Pascal
// scene exists, so a failed build costs prompts, never abandoned scenes.
//
// The experimental `llmGeometry` switch asks the model for LayoutPlan
// geometry directly (skipping the partitioner) and pushes it through the
// same validator — a comparison path for measuring partitioner-vs-LLM layout
// quality. Off by default; never the main path.
// ---------------------------------------------------------------------------

import {
  parseLayoutIntent,
  ROOM_TYPES,
  type IssueL10n,
  type LayoutIntent,
  type LayoutPlan,
  type RoomType,
} from './layout-plan'
import { partitionLayout } from './layout-partitioner'
import {
  findDirectTemplateSeed,
  findTemplateSeed,
  type TemplateMatchTrace,
} from './template-seed'
import { DEFAULT_NORM_PROFILE, type NormProfile } from './norms/profile'
import { validateLayoutPlan, type PlanTargets, type PlanValidation } from './plan-validator'
import { applyStrategy, strategyPromptLines, type StrategyDecision } from './strategy'
import type { ChatMessage } from './types'
import { renderPrompt, type PromptAuditMetadata } from './prompts/registry'
import { checkWetRoomFurnitureFeasibility } from './domain/furniture-feasibility'

// One plain-text completion (no tools). The agent wires this to its model
// client with fallback + call budgeting; tests inject a stub.
export type CompleteText = (
  messages: ChatMessage[],
  tag: string,
  prompt: PromptAuditMetadata,
) => Promise<string>

export type PlanBuildOptions = {
  // Total model attempts (1 initial + corrections). §9 budgets "Intent 1–3".
  maxRounds?: number
  // Experimental: model emits LayoutPlan geometry directly (§2, 意见②).
  llmGeometry?: boolean
  // Rebuild path (§5 失败分流): acceptance failures from the previous build,
  // quoted into the FIRST prompt so the replan avoids them from round one.
  priorFailures?: string[]
  // Market/regulation parameters for the partitioner (NORMS_PROFILE_DESIGN.md).
  profile?: NormProfile
  // Strategy decision (LAYOUT_STRATEGY_DESIGN.md): injected into the Intent
  // prompt and enforced on the parsed intent before partitioning.
  strategy?: StrategyDecision
  // Must be the same library startup health checks validated.
  templatesDir?: string
  // The direct path skips Intent enrichment. Callers must prove that every
  // active planning fact is represented by the deterministic template query;
  // absent/false stays on the model-enrichment path.
  directTemplateEligible?: boolean
}

export type PlanBuildSuccess = {
  ok: true
  intent: LayoutIntent | null // null on the llmGeometry path
  plan: LayoutPlan
  validation: PlanValidation
  modelCalls: number
  // Template-seed rejection reasons (docs/TEMPLATES.md) — debug data for the
  // request trace, never rendered to users.
  seedTrace?: string[]
  templateTrace?: TemplateMatchTrace
}

export type PlanBuildFailure = {
  ok: false
  // Last round's blocking findings, for the failure reply / eval report.
  // zh canonical (correction prompts quote these verbatim).
  failures: string[]
  // Aligned with `failures`: template refs so the planRejected reply can
  // re-render each line in the user's language; null = zh passthrough.
  failuresL10n: Array<IssueL10n | null>
  modelCalls: number
  // Template-seed rejection reasons from the last round (debug trace only).
  seedTrace?: string[]
  templateTrace?: TemplateMatchTrace
}

export type PlanBuildResult = PlanBuildSuccess | PlanBuildFailure

const DEFAULT_MAX_ROUNDS = 3

// Tolerant parse for the experimental LLM-geometry path. Deliberately
// minimal: shape defects surface as validator fatals, which feed the same
// correction loop.
export function parseLayoutPlanJson(raw: string): { plan: LayoutPlan | null; errors: string[] } {
  const text = raw.replace(/```(?:json)?/gi, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return { plan: null, errors: ['回复中找不到 JSON 对象'] }
  let data: unknown
  try {
    data = JSON.parse(text.slice(start, end + 1))
  } catch (error) {
    return { plan: null, errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`] }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { plan: null, errors: ['LayoutPlan 必须是 JSON 对象'] }
  }
  const value = data as Record<string, unknown>
  const errors: string[] = []
  const footprint = value.footprint as { width?: unknown; depth?: unknown; polygon?: unknown } | undefined
  const width = typeof footprint?.width === 'number' ? footprint.width : undefined
  const depth = typeof footprint?.depth === 'number' ? footprint.depth : undefined
  if (width === undefined || depth === undefined || width <= 0 || depth <= 0) {
    errors.push('footprint.width/depth 缺失或不是正数')
  }
  // Optional non-rectangular outline (S5) — keep it, or the validator loses
  // the very shape it's supposed to check against.
  const footprintPolygon = Array.isArray(footprint?.polygon)
    ? footprint.polygon.filter((point): point is [number, number] =>
        Array.isArray(point) && point.length === 2
        && typeof point[0] === 'number' && typeof point[1] === 'number')
    : []
  const entryRoomId = (value.entry as { roomId?: unknown } | undefined)?.roomId
  if (typeof entryRoomId !== 'string' || !entryRoomId) errors.push('entry.roomId 缺失')
  const roomsRaw = Array.isArray(value.rooms) ? value.rooms : []
  if (roomsRaw.length === 0) errors.push('rooms 缺失或为空')
  const rooms: LayoutPlan['rooms'] = []
  for (let i = 0; i < roomsRaw.length; i++) {
    const entry = roomsRaw[i] as Record<string, unknown>
    const polygon = Array.isArray(entry?.polygon)
      ? entry.polygon.filter((p): p is [number, number] =>
          Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number')
      : []
    if (typeof entry?.id !== 'string' || polygon.length < 3) {
      errors.push(`rooms[${i}] 缺少 id 或合法 polygon`)
      continue
    }
    const type = (ROOM_TYPES as readonly string[]).includes(entry.type as string)
      ? entry.type as RoomType
      : 'other'
    rooms.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      type,
      polygon,
      requiresExteriorWindow: entry.requiresExteriorWindow === true,
    })
  }
  const connections: LayoutPlan['connections'] = []
  if (Array.isArray(value.connections)) {
    for (const item of value.connections) {
      const conn = item as Record<string, unknown>
      if (typeof conn?.from === 'string' && typeof conn?.to === 'string') {
        connections.push({ from: conn.from, to: conn.to, type: 'door' })
      }
    }
  }
  if (errors.length > 0 || rooms.length === 0) return { plan: null, errors }
  return {
    plan: {
      footprint: {
        width: width!,
        depth: depth!,
        ...(footprintPolygon.length >= 4 ? { polygon: footprintPolygon } : {}),
      },
      entry: { roomId: entryRoomId as string },
      rooms,
      connections,
    },
    errors: [],
  }
}

export async function buildLayoutPlan(
  inputs: {
    // Confirmed brief text, authoritative for room list / area / constraints.
    briefSummary: string
    targets: PlanTargets
  },
  complete: CompleteText,
  options: PlanBuildOptions = {},
): Promise<PlanBuildResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  const llmGeometry = options.llmGeometry === true
  const profile = options.profile ?? DEFAULT_NORM_PROFILE
  let directTemplateTrace: TemplateMatchTrace | undefined
  if (
    !llmGeometry
    && !options.priorFailures?.length
    && options.strategy
    && options.directTemplateEligible === true
  ) {
    const direct = findDirectTemplateSeed(
      inputs.targets.totalAreaSqm,
      profile,
      options.strategy,
      { targets: inputs.targets, templatesDir: options.templatesDir },
    )
    directTemplateTrace = direct.matchTrace
    if (direct.seed && direct.intent) {
      const furnitureFeasibility = checkWetRoomFurnitureFeasibility(direct.seed.plan, profile.id)
      if (furnitureFeasibility.length > 0) {
        directTemplateTrace.rejections.push({
          templateId: direct.seed.templateId,
          reasonCodes: furnitureFeasibility.map(finding =>
            `${finding.roomId}:${finding.requirementKey}:required_wet_fixture_set_unplaceable`),
        })
      } else {
        const extraNotes = [...direct.seed.notes, ...options.strategy.notes]
        return {
          ok: true,
          intent: direct.intent,
          plan: {
            ...direct.seed.plan,
            notes: [...(direct.seed.plan.notes ?? []), ...extraNotes],
          },
          validation: direct.seed.validation,
          modelCalls: 0,
          templateTrace: direct.matchTrace,
        }
      }
    }
  }
  const promptId = llmGeometry ? 'plan:geometry' as const : 'plan:intent' as const
  const promptVariables = {
    briefSummary: inputs.briefSummary,
    totalArea: inputs.targets.totalAreaSqm !== undefined ? String(inputs.targets.totalAreaSqm) : '',
    requiredRooms: inputs.targets.requiredRooms?.length
      ? inputs.targets.requiredRooms.map(r => `${r.type}×${r.count}`).join('、')
      : '',
    strategy: options.strategy && !llmGeometry ? strategyPromptLines(options.strategy) : '',
    priorFailures: options.priorFailures?.length
      ? options.priorFailures.map(f => `- ${f}`).join('\n')
      : '',
    findings: '',
  }
  const prompt = renderPrompt(promptId, promptVariables)
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.parts.system },
    { role: 'user', content: prompt.parts.user },
  ]

  let modelCalls = 0
  let lastFailures: string[] = []
  let lastFailuresL10n: Array<IssueL10n | null> = []
  let lastSeedTrace: string[] | undefined
  let lastTemplateTrace: TemplateMatchTrace | undefined = llmGeometry
    ? undefined
    : directTemplateTrace ?? {
        mode: 'fallback',
        market: profile.id,
        ...(options.strategy?.roomProgram ? { roomProgram: options.strategy.roomProgram } : {}),
        ...(inputs.targets.totalAreaSqm !== undefined
          ? { targetAreaSqm: inputs.targets.totalAreaSqm }
          : {}),
        candidates: [],
        rejections: [],
      }
  for (let round = 0; round < maxRounds; round++) {
    modelCalls++
    const reply = await complete(messages, `${promptId}:${round}`, prompt)
    messages.push({ role: 'assistant', content: reply })

    const attempt = llmGeometry
      ? evaluateGeometryReply(reply, inputs.targets, profile)
      : evaluateIntentReply(reply, inputs.targets, profile, options.strategy, options.templatesDir)
    if (attempt.ok) return { ...attempt.result, modelCalls }

    lastFailures = attempt.failures
    lastFailuresL10n = attempt.failuresL10n
    lastSeedTrace = attempt.seedTrace
    lastTemplateTrace = attempt.templateTrace ?? lastTemplateTrace
    messages.push({
      role: 'user',
      content: renderPrompt(promptId, {
        ...promptVariables,
        findings: attempt.failures.map(f => `- ${f}`).join('\n'),
      }).parts.correction,
    })
  }
  return {
    ok: false,
    failures: lastFailures,
    failuresL10n: lastFailuresL10n,
    modelCalls,
    ...(lastSeedTrace?.length ? { seedTrace: lastSeedTrace } : {}),
    ...(lastTemplateTrace ? { templateTrace: lastTemplateTrace } : {}),
  }
}

type Attempt =
  | { ok: true; result: Omit<PlanBuildSuccess, 'modelCalls'> }
  | {
      ok: false
      failures: string[]
      failuresL10n: Array<IssueL10n | null>
      seedTrace?: string[]
      templateTrace?: TemplateMatchTrace
    }

const noL10n = (failures: string[]): Array<IssueL10n | null> => failures.map(() => null)

function evaluateIntentReply(
  reply: string,
  targets: PlanTargets,
  profile: NormProfile,
  strategy?: StrategyDecision,
  templatesDir?: string,
): Attempt {
  const parsed = parseLayoutIntent(reply)
  const errors = parsed.errors
  if (!parsed.intent) {
    const failures = errors.length > 0 ? errors : ['LayoutIntent 解析失败']
    return { ok: false, failures, failuresL10n: noL10n(failures) }
  }
  // Tier-1 strategy enforcement (LAYOUT_STRATEGY_DESIGN.md §4): silent
  // deterministic corrections instead of a model correction round. The
  // applied intent is what gets partitioned AND what the caller persists.
  const applied = strategy ? applyStrategy(parsed.intent, strategy, profile) : { intent: parsed.intent, notes: [] }
  const intent = inputsAreaOverride(applied.intent, targets)
  // Template seeding (docs/TEMPLATES.md): a good reference with the same
  // core program beats the solver — real listed plans carry idioms the
  // partitioner hasn't learned. No hit (or a post-scale fatal) falls through
  // to partitionLayout below.
  const seedTrace: string[] = []
  const templateTrace: TemplateMatchTrace = {
    mode: 'after_enrichment',
    market: profile.id,
    ...(strategy?.roomProgram ? { roomProgram: strategy.roomProgram } : {}),
    targetAreaSqm: intent.targetTotalAreaSqm,
    candidates: [],
    rejections: [],
  }
  const seed = findTemplateSeed(intent, profile, strategy, {
    targets,
    trace: seedTrace,
    templatesDir,
    matchTrace: templateTrace,
  })
  const seedTraceField = seedTrace.length > 0 ? { seedTrace } : {}
  if (seed) {
    const furnitureFeasibility = checkWetRoomFurnitureFeasibility(seed.plan, profile.id)
    if (furnitureFeasibility.length > 0) {
      seedTrace.push(...furnitureFeasibility.map(finding =>
        `${finding.roomId}:${finding.requirementKey}:required_wet_fixture_set_unplaceable`))
    } else {
      const extraNotes = [...seed.notes, ...(strategy?.notes ?? []), ...applied.notes]
      const plan = { ...seed.plan, notes: [...(seed.plan.notes ?? []), ...extraNotes] }
      return {
        ok: true,
        result: {
          ok: true,
          intent,
          plan,
          validation: seed.validation,
          templateTrace,
          ...seedTraceField,
        },
      }
    }
  }
  templateTrace.mode = 'fallback'
  // Recoverable parse defects (dropped fields, renamed ids) don't block on
  // their own — the partitioned plan is judged on its merits below.
  const partition = partitionLayout(intent, profile, strategy)
  if (!partition.ok) {
    const details = partition.details ?? []
    return {
      ok: false,
      failures: [
        ...errors,
        `分区器无法排布该意图：${partition.reason}`,
        ...details.map(detail => detail.message),
      ],
      failuresL10n: [
        ...noL10n(errors),
        partition.l10n ?? null,
        ...details.map(detail => detail.l10n ?? null),
      ],
      templateTrace,
      ...seedTraceField,
    }
  }
  const validation = validateLayoutPlan(partition.plan, targets, profile)
  const furnitureFeasibility = checkWetRoomFurnitureFeasibility(partition.plan, profile.id)
  if (validation.fatal.length > 0 || furnitureFeasibility.length > 0) {
    const furnitureFailures = furnitureFeasibility.map(finding =>
      `湿区 ${finding.roomId} 无法放置必备设备组合（${finding.requirementKey}）`)
    return {
      ok: false,
      failures: [...errors, ...validation.fatal, ...furnitureFailures],
      failuresL10n: [...noL10n(errors), ...validation.fatalL10n, ...noL10n(furnitureFailures)],
      templateTrace,
      ...seedTraceField,
    }
  }
  // Strategy decision rationale rides the plan notes — without this the
  // typology/kitchen reasoning would be write-only (§ 每个字段必须有消费者).
  const extraNotes = [...(strategy?.notes ?? []), ...applied.notes]
  const plan = extraNotes.length > 0
    ? { ...partition.plan, notes: [...(partition.plan.notes ?? []), ...extraNotes] }
    : partition.plan
  return {
    ok: true,
    result: { ok: true, intent, plan, validation, templateTrace, ...seedTraceField },
  }
}

function inputsAreaOverride(intent: LayoutIntent, targets: PlanTargets): LayoutIntent {
  return targets.totalAreaSqm !== undefined && targets.totalAreaSqm > 0
    ? { ...intent, targetTotalAreaSqm: targets.totalAreaSqm }
    : intent
}

function evaluateGeometryReply(reply: string, targets: PlanTargets, profile: NormProfile): Attempt {
  const { plan, errors } = parseLayoutPlanJson(reply)
  if (!plan) return { ok: false, failures: errors, failuresL10n: noL10n(errors) }
  const validation = validateLayoutPlan(plan, targets, profile)
  const furnitureFeasibility = checkWetRoomFurnitureFeasibility(plan, profile.id)
  if (validation.fatal.length > 0 || furnitureFeasibility.length > 0) {
    const furnitureFailures = furnitureFeasibility.map(finding =>
      `湿区 ${finding.roomId} 无法放置必备设备组合（${finding.requirementKey}）`)
    return {
      ok: false,
      failures: [...validation.fatal, ...furnitureFailures],
      failuresL10n: [...validation.fatalL10n, ...noL10n(furnitureFailures)],
    }
  }
  return { ok: true, result: { ok: true, intent: null, plan, validation } }
}
