import { describe, expect, test } from 'bun:test'
import { JP_NORM_PROFILE } from '../../norms/profile-jp'
import { deriveStrategy } from '../../strategy'
import type { DesignBrief, RequirementFact } from '../../types'
import { directTemplateEligibility } from './direct-template-policy'

function fact(key: string, value: RequirementFact['value']): RequirementFact {
  return {
    key,
    label: key,
    value,
    source: 'user',
    confidence: 1,
    confirmationStatus: 'confirmed',
  }
}

function brief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  return {
    existingCondition: [],
    designGoals: [],
    hardConstraints: [],
    assumptions: [],
    uncertainties: [],
    conflicts: [],
    ...overrides,
  }
}

describe('direct template eligibility', () => {
  const targets = {
    totalAreaSqm: 55,
    requiredRooms: [{ type: 'bedroom' as const, count: 2 }],
  }
  const strategy = deriveStrategy({ roomProgram: '2ldk', kitchenPreference: 'open' }, targets, JP_NORM_PROFILE)

  test('allows facts fully represented by the deterministic template query', () => {
    const result = directTemplateEligibility(brief({
      designGoals: [
        fact('total_area', 55),
        fact('room_program', '2LDK'),
        fact('bedroom_count', 2),
        fact('kitchen_layout', '开放式厨房'),
        fact('design_style', '现代简约'),
      ],
      assumptions: [fact('area_measurement_basis', '按建筑面积理解')],
    }), targets, strategy)

    expect(result).toEqual({ eligible: true, reasonCodes: [], unsupportedFactKeys: [] })
  })

  test('forces Intent enrichment for an unrepresented explicit constraint', () => {
    const result = directTemplateEligibility(brief({
      designGoals: [fact('total_area', 55), fact('room_program', '2LDK')],
      hardConstraints: [fact('bedroom_windows', '两间卧室都必须朝南并有外窗')],
    }), targets, strategy)

    expect(result.eligible).toBe(false)
    expect(result.reasonCodes).toContain('unsupported_layout_fact')
    expect(result.unsupportedFactKeys).toEqual(['bedroom_windows'])
  })

  test('rejects a recognized fact when its value disagrees with the query', () => {
    const result = directTemplateEligibility(brief({
      designGoals: [fact('total_area', 60), fact('room_program', '2LDK')],
    }), targets, strategy)

    expect(result.eligible).toBe(false)
    expect(result.unsupportedFactKeys).toEqual(['total_area'])
  })

  test('does not replace an existing layout or unresolved brief with a template', () => {
    const result = directTemplateEligibility(brief({
      existingCondition: [fact('current_layout', '现有两居室')],
      uncertainties: [fact('balcony_requirement', '是否保留阳台')],
    }), targets, strategy)

    expect(result.eligible).toBe(false)
    expect(result.reasonCodes).toContain('existing_condition_requires_enrichment')
    expect(result.reasonCodes).toContain('unresolved_brief')
  })

  test('ignores facts explicitly rejected by the user', () => {
    const rejected = { ...fact('ensuite', true), confirmationStatus: 'rejected' as const }
    expect(directTemplateEligibility(brief({ hardConstraints: [rejected] }), targets, strategy).eligible).toBe(true)
  })
})
