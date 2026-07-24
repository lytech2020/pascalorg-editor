import { describe, expect, it } from 'bun:test'
import type { LayoutPlan } from '../layout-plan'
import { validateModifiedLayoutPlan } from './local-structural-validation'

// 10m × 4m footprint (40㎡). `slim` is a 4×1 "other" room — aspect 4:1, which
// is a fatal-level slenderness at GENERATION time. It is the pre-existing issue
// the grandfathering logic must tolerate on an unrelated modify.
function planWithSlenderRoom(): LayoutPlan {
  return {
    footprint: { width: 10, depth: 4 },
    entry: { roomId: 'ldk' },
    rooms: [
      { id: 'ldk', name: 'LDK', type: 'living_kitchen', requiresExteriorWindow: true,
        polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
      { id: 'slim', name: '储藏', type: 'other', requiresExteriorWindow: false,
        polygon: [[6, 0], [10, 0], [10, 1], [6, 1]] },
      { id: 'bed', name: '卧室', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 1], [10, 1], [10, 4], [6, 4]] },
    ],
    connections: [
      { from: 'ldk', to: 'slim', type: 'door' },
      { from: 'ldk', to: 'bed', type: 'door' },
      { from: 'slim', to: 'bed', type: 'door' },
    ],
  }
}

describe('validateModifiedLayoutPlan', () => {
  it('grandfathers a pre-existing slender room the edit did not touch', () => {
    const before = planWithSlenderRoom()
    const after = structuredClone(before)
    const result = validateModifiedLayoutPlan({ before, after, affectedRoomIds: [] })
    expect(result.fatal).toHaveLength(0)
    const aspectWarn = result.warnings.find(w => w.code === 'room_aspect' && w.roomId === 'slim')
    expect(aspectWarn?.reason).toBe('existing_issue_not_worsened')
  })

  it('blocks the write when a pre-existing issue measurably worsens', () => {
    const before = planWithSlenderRoom()
    const after = structuredClone(before)
    // slim gets even slenderer (4×0.7 → 5.7:1); bed grows to keep coverage.
    after.rooms[1]!.polygon = [[6, 0], [10, 0], [10, 0.7], [6, 0.7]]
    after.rooms[2]!.polygon = [[6, 0.7], [10, 0.7], [10, 4], [6, 4]]
    const result = validateModifiedLayoutPlan({ before, after, affectedRoomIds: [] })
    const worse = result.fatal.find(f => f.code === 'room_aspect' && f.roomId === 'slim')
    expect(worse?.reason).toBe('existing_issue_worsened')
  })

  it('always rejects a newly-introduced overlap (integrity, never grandfathered)', () => {
    const before = planWithSlenderRoom()
    const after = structuredClone(before)
    after.rooms[2]!.polygon = [[4, 1], [10, 1], [10, 4], [4, 4]] // bed now overlaps the LDK
    const result = validateModifiedLayoutPlan({ before, after, affectedRoomIds: ['bed'] })
    expect(result.fatal.some(f => f.code === 'room_overlap')).toBe(true)
  })

  it('rejects when the edit severs a room from the reachable graph', () => {
    const before = planWithSlenderRoom()
    const after = structuredClone(before)
    after.connections = [{ from: 'ldk', to: 'slim', type: 'door' }] // bed now isolated
    const result = validateModifiedLayoutPlan({ before, after, affectedRoomIds: [] })
    const unreachable = result.fatal.find(f => f.code === 'room_unreachable' && f.roomId === 'bed')
    expect(unreachable).toBeDefined()
  })

  it('flags a quality issue on an affected room as fatal (no grandfathering in the edit neighbourhood)', () => {
    const before = planWithSlenderRoom()
    const after = structuredClone(before)
    // slim stays equally slender, but this time it IS the room the edit touched.
    const result = validateModifiedLayoutPlan({ before, after, affectedRoomIds: ['slim'] })
    const finding = result.fatal.find(f => f.code === 'room_aspect' && f.roomId === 'slim')
    expect(finding?.reason).toBe('affected_room')
  })
})
