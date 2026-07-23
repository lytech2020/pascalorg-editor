import { describe, expect, test } from 'bun:test'
import { JP_NORM_PROFILE } from '../../norms/profile-jp'
import { TYPE_TO_KIND, areaBoundFor } from './room-policy'

describe('room policy domain', () => {
  const context = { totalAreaSqm: 45, bedroomCount: 2 }

  test('maps scene room types into metrics kinds', () => {
    expect(TYPE_TO_KIND.bedroom).toBe('bedroom')
    expect(TYPE_TO_KIND.hallway).toBe('circulation')
    expect(TYPE_TO_KIND.storage).toBe('other')
  })

  test('selects the narrower DK band only for dining-kitchen names', () => {
    const dk = areaBoundFor(JP_NORM_PROFILE, context, 'living_kitchen', 'DK')!
    const ldk = areaBoundFor(JP_NORM_PROFILE, context, 'living_kitchen', 'LDK')!
    expect(dk.fatalMin).toBeLessThan(ldk.fatalMin)
  })

  test('selects the LD band when a standalone kitchen exists', () => {
    const ld = areaBoundFor(JP_NORM_PROFILE, context, 'living', 'Living Dining', true)!
    const combined = areaBoundFor(JP_NORM_PROFILE, context, 'living', 'Living Dining', false)!
    expect(ld.fatalMin).toBeLessThan(combined.fatalMin)
  })
})
