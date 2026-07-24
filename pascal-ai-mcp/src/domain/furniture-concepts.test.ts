import { describe, expect, test } from 'bun:test'
import { placementStrategyFor, resolveFurnitureConcept } from './furniture-concepts'

describe('resolveFurnitureConcept', () => {
  test('a vague 桌子/table is ambiguous, never silently a desk (P2-2)', () => {
    const resolution = resolveFurnitureConcept('桌子')
    expect(resolution.kind).toBe('ambiguous')
    if (resolution.kind === 'ambiguous') {
      const keys = resolution.candidates.map(concept => concept.key)
      expect(keys).toContain('dining_table')
      expect(keys).toContain('coffee_table')
      expect(keys).toContain('desk')
    }
    expect(resolveFurnitureConcept('table').kind).toBe('ambiguous')
  })

  test('specific words resolve to a single concept', () => {
    expect(resolveFurnitureConcept('书桌')).toMatchObject({ kind: 'concept', concept: { key: 'desk' } })
    expect(resolveFurnitureConcept('餐桌')).toMatchObject({ kind: 'concept', concept: { key: 'dining_table' } })
    expect(resolveFurnitureConcept('茶几')).toMatchObject({ kind: 'concept', concept: { key: 'coffee_table' } })
    expect(resolveFurnitureConcept('沙发')).toMatchObject({ kind: 'concept', concept: { key: 'sofa' } })
  })

  test('unknown furniture is reported as unknown, not forced to a concept', () => {
    expect(resolveFurnitureConcept('不存在的东西').kind).toBe('unknown')
  })
})

describe('placementStrategyFor', () => {
  test('centre-of-room furniture uses room_center; wall furniture uses wall_aligned', () => {
    expect(placementStrategyFor('餐桌')).toBe('room_center')
    expect(placementStrategyFor('茶几')).toBe('room_center')
    expect(placementStrategyFor('书桌')).toBe('wall_aligned')
    expect(placementStrategyFor('床')).toBe('wall_aligned')
    // Unknown terms fall back to the broadly-safe wall strategy.
    expect(placementStrategyFor('不存在的东西')).toBe('wall_aligned')
  })
})
