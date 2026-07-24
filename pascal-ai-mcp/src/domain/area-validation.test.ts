import { describe, expect, test } from 'bun:test'
import type { DesignBrief, RequirementFact } from '../types'
import {
  checkAreaRequirements,
  computeZoneAreaStats,
  numericFactValue,
  pointInPolygon,
  polygonArea,
} from './area-validation'

const rectangle = (id: string, name: string, x: number, z: number, width: number, depth: number) => ({
  id,
  name,
  polygon: [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]] as Array<[number, number]>,
})

function areaBrief(area: number): DesignBrief {
  const fact: RequirementFact = {
    key: 'floor_area_sqm',
    label: '面积',
    value: area,
    source: 'user',
    confidence: 1,
    confirmationStatus: 'confirmed',
  }
  return {
    existingCondition: [fact],
    designGoals: [],
    hardConstraints: [],
    assumptions: [],
    uncertainties: [],
    conflicts: [],
  }
}

describe('area validation domain', () => {
  test('numeric facts prefer an area-qualified value and reject ambiguous bare numbers', () => {
    expect(numericFactValue('3室2厅约140平方米')).toBe(140)
    expect(numericFactValue('2026年翻新，约140㎡')).toBe(140)
    expect(numericFactValue('约 180')).toBe(180)
    expect(numericFactValue('3室2厅')).toBeUndefined()
  })

  test('measures polygons and point inclusion without infrastructure', () => {
    const polygon = rectangle('room', 'Room', 0, 0, 4, 3).polygon
    expect(polygonArea(polygon)).toBe(12)
    expect(pointInPolygon(2, 2, polygon)).toBe(true)
    expect(pointInPolygon(5, 2, polygon)).toBe(false)
  })

  test('computes union area and reports pair overlap', () => {
    const stats = computeZoneAreaStats([
      rectangle('a', 'Living', 0, 0, 6, 4),
      rectangle('b', 'Bedroom', 4, 0, 6, 4),
    ])
    expect(stats.sumArea).toBe(48)
    expect(stats.unionArea).toBe(40)
    expect(stats.overlapArea).toBe(8)
    expect(stats.overlappingPairs[0]?.areaSqMeters).toBe(8)
  })

  test('checks target area tolerance and overlap independently', () => {
    expect(checkAreaRequirements([rectangle('a', 'Living', 0, 0, 10, 7)], areaBrief(70))).toEqual([])
    const findings = checkAreaRequirements([
      rectangle('a', 'Living', 0, 0, 6, 7),
      rectangle('b', 'Bedroom', 5, 0, 5, 7),
    ], areaBrief(70))
    expect(findings.map(finding => finding.l10n.id)).toContain('zoneOverlap')
  })
})
