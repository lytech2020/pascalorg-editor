import { FLOOR_AREA_FACT_KEYS } from '../area-validation'
import { detectKitchenPreference, parseRoomProgram } from '../../lang/strategy-vocab'
import type { PlanTargets } from '../../plan-validator'
import type { StrategyDecision } from '../../strategy'
import type { DesignBrief, RequirementFact } from '../../types'

export type DirectTemplateEligibility = {
  eligible: boolean
  reasonCodes: Array<
    | 'existing_condition_requires_enrichment'
    | 'unresolved_brief'
    | 'unsupported_layout_fact'
  >
  unsupportedFactKeys: string[]
}

const AREA_KEYS = new Set([
  ...FLOOR_AREA_FACT_KEYS,
  'total_area',
  'total_area_sqm',
])
const BEDROOM_KEYS = new Set(['bedroom_count', 'bedrooms'])
const ROOM_PROGRAM_KEYS = new Set(['room_program'])
const KITCHEN_KEYS = new Set([
  'kitchen',
  'kitchen_layout',
  'kitchen_mode',
  'kitchen_preference',
  'open_kitchen',
  'closed_kitchen',
])
const NON_LAYOUT_KEYS = new Set([
  'area_measurement_basis',
  'style',
  'design_style',
  'furniture',
  'furniture_requirements',
  'furnishing',
  'material',
  'materials',
  'color_scheme',
  'lighting_style',
])

function normalizedKey(fact: RequirementFact): string {
  return fact.key.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function factText(fact: RequirementFact): string {
  const value = Array.isArray(fact.value) ? fact.value.join('、') : String(fact.value)
  return `${fact.key} ${fact.label} ${value}`
}

function numericFactValue(fact: RequirementFact): number | undefined {
  if (typeof fact.value === 'number') return fact.value
  if (typeof fact.value !== 'string') return undefined
  const parsed = Number.parseFloat(fact.value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isRepresentedByDirectQuery(
  fact: RequirementFact,
  targets: PlanTargets,
  strategy: StrategyDecision,
): boolean {
  const key = normalizedKey(fact)
  if (NON_LAYOUT_KEYS.has(key)) return true
  if (AREA_KEYS.has(key)) {
    const value = numericFactValue(fact)
    return value !== undefined
      && targets.totalAreaSqm !== undefined
      && Math.abs(value - targets.totalAreaSqm) < 0.01
  }
  if (BEDROOM_KEYS.has(key)) {
    const value = numericFactValue(fact)
    return value !== undefined
      && targets.requiredRooms?.some(room => room.type === 'bedroom' && room.count === value) === true
  }
  if (ROOM_PROGRAM_KEYS.has(key)) {
    return parseRoomProgram(factText(fact))?.program === strategy.roomProgram
  }
  if (KITCHEN_KEYS.has(key)) {
    return detectKitchenPreference(factText(fact)) === strategy.kitchenMode
  }
  return false
}

/**
 * The zero-model direct-template path is an optimization, so it is allowed
 * only when every active planning fact is represented by its deterministic
 * query. Unknown facts fall back to Intent enrichment instead of being
 * silently discarded.
 */
export function directTemplateEligibility(
  brief: DesignBrief,
  targets: PlanTargets,
  strategy: StrategyDecision,
): DirectTemplateEligibility {
  const reasonCodes = new Set<DirectTemplateEligibility['reasonCodes'][number]>()
  const unsupportedFactKeys = new Set<string>()
  const active = (facts: RequirementFact[]) =>
    facts.filter(fact => fact.confirmationStatus !== 'rejected')

  if (active(brief.existingCondition).length > 0) {
    reasonCodes.add('existing_condition_requires_enrichment')
  }
  if (active(brief.uncertainties).length > 0 || brief.conflicts.length > 0) {
    reasonCodes.add('unresolved_brief')
  }
  for (const fact of active([
    ...brief.designGoals,
    ...brief.hardConstraints,
    ...brief.assumptions,
  ])) {
    if (isRepresentedByDirectQuery(fact, targets, strategy)) continue
    reasonCodes.add('unsupported_layout_fact')
    unsupportedFactKeys.add(normalizedKey(fact))
  }

  return {
    eligible: reasonCodes.size === 0,
    reasonCodes: [...reasonCodes],
    unsupportedFactKeys: [...unsupportedFactKeys].sort(),
  }
}
