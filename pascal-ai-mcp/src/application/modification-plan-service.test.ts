import { describe, expect, test } from 'bun:test'
import {
  canonicalModifyPlanHash,
  resolveModifyPlanForExecution,
} from './modification-plan-service'

describe('modification plan service', () => {
  test('confirmation executes the persisted plan without consuming another model output', async () => {
    let translations = 0
    const pendingPlan = {
      ops: [{ op: 'resize_room' as const, room: '主卧', targetAreaSqm: 16 }],
    }
    const resolved = await resolveModifyPlanForExecution({
      confirmed: true,
      pendingPlan,
      translate: async () => {
        translations++
        return {
          plan: {
            ops: [{ targetAreaSqm: 15.8, room: '主卧', op: 'resize_room' as const }],
          },
          errors: [],
        }
      },
    })
    expect(translations).toBe(0)
    expect(resolved.plan).toEqual(pendingPlan)
    expect(resolved.plan).not.toBe(pendingPlan)
  })

  test('canonical hash ignores object key insertion order', () => {
    const left = {
      ops: [{ op: 'resize_room' as const, room: '主卧', targetAreaSqm: 16 }],
    }
    const right = {
      ops: [{ targetAreaSqm: 16, room: '主卧', op: 'resize_room' as const }],
    }
    expect(canonicalModifyPlanHash(left)).toBe(canonicalModifyPlanHash(right))
  })
})
