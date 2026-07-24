import { describe, expect, it } from 'bun:test'
import { DEFAULT_NORM_PROFILE } from '../norms/profile'
import { polygonArea, type LayoutPlan } from '../layout-plan'
import { applyLocalStructuralEdits } from './local-structural-edit'
import { validateModifiedLayoutPlan } from './local-structural-validation'

// The headline regression (docs spec §9): a ~70㎡ 2LDK with a couple of
// PRE-EXISTING, edit-unrelated quality problems — a 4:1 washroom and a 4:1
// study (both fatal-level slenderness at generation time). The user asks to
// "add a storage room in the living room". This must:
//   • succeed as a LOCAL carve from the LDK (no full re-partition),
//   • keep the footprint and every unrelated room's polygon exactly the same,
//   • NOT be blocked by the pre-existing washroom/study issues (grandfathered),
//   • connect the new storage into the scene.
function twoLdk70(): LayoutPlan {
  return {
    footprint: { width: 10, depth: 7 },
    entry: { roomId: 'ldk' },
    rooms: [
      { id: 'ldk', name: 'LDK', type: 'living_kitchen', requiresExteriorWindow: true,
        polygon: [[0, 0], [6, 0], [6, 7], [0, 7]] },
      { id: 'bed1', name: '主卧', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 0], [10, 0], [10, 3], [6, 3]] },
      { id: 'bed2', name: '次卧', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 3], [10, 3], [10, 5], [6, 5]] },
      // Pre-existing 4:1 slender rooms — fatal aspect at generation time.
      { id: 'wash', name: '洗面脱衣', type: 'bathroom', requiresExteriorWindow: false,
        polygon: [[6, 5], [10, 5], [10, 6], [6, 6]] },
      { id: 'study', name: '书房', type: 'study', requiresExteriorWindow: true,
        polygon: [[6, 6], [10, 6], [10, 7], [6, 7]] },
    ],
    connections: [
      { from: 'ldk', to: 'bed1', type: 'door' },
      { from: 'ldk', to: 'bed2', type: 'door' },
      { from: 'ldk', to: 'wash', type: 'door' },
      { from: 'ldk', to: 'study', type: 'door' },
      { from: 'bed1', to: 'bed2', type: 'door' },
      { from: 'bed2', to: 'wash', type: 'door' },
      { from: 'wash', to: 'study', type: 'door' },
    ],
  }
}

const profile = DEFAULT_NORM_PROFILE
const stable = (polygon: Array<[number, number]>) =>
  JSON.stringify(polygon.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]))
const bbox = (polygon: Array<[number, number]>) => {
  const xs = polygon.map(p => p[0]); const zs = polygon.map(p => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) }
}

describe('70㎡ 2LDK — add a storage room in the living room (§9 headline)', () => {
  const before = twoLdk70()
  const outcome = applyLocalStructuralEdits(before, [{
    op: { op: 'add_room', room: { name: '收纳', type: 'storage', targetAreaSqm: 3 }, near: 'ldk', operationId: 'op-0' },
  }], profile)

  it('applies as a local carve — no full re-partition fallback', () => {
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0]!.reasonCode).toBe('local_add_applied')
  })

  it('keeps the footprint and every unrelated room unchanged, carving from the LDK', () => {
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Total floor area conserved (footprint did not grow).
    const total = outcome.plan.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0)
    expect(total).toBeCloseTo(70, 1)
    // The unrelated rooms are byte-for-byte identical.
    for (const id of ['bed1', 'bed2', 'wash', 'study']) {
      expect(stable(outcome.plan.rooms.find(r => r.id === id)!.polygon))
        .toBe(stable(before.rooms.find(r => r.id === id)!.polygon))
    }
    // The storage sits inside the ORIGINAL LDK bounding box and the LDK shrank.
    const storage = outcome.plan.rooms.find(r => r.type === 'storage')!
    const b = bbox(storage.polygon)
    expect(b.minX).toBeGreaterThanOrEqual(-1e-6)
    expect(b.maxX).toBeLessThanOrEqual(6 + 1e-6)
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'ldk')!.polygon)).toBeCloseTo(39, 1)
    // The new room is connected.
    expect(outcome.plan.connections.some(c => c.from === storage.id || c.to === storage.id)).toBe(true)
  })

  it('does not let the pre-existing washroom/study issues block the modify (grandfathered)', () => {
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const validation = validateModifiedLayoutPlan({
      before,
      after: outcome.plan,
      affectedRoomIds: outcome.affectedRoomIds,
      profile,
    })
    expect(validation.fatal).toHaveLength(0)
    // The slender washroom and study are recorded as grandfathered warnings.
    for (const id of ['wash', 'study']) {
      const warn = validation.warnings.find(w => w.code === 'room_aspect' && w.roomId === id)
      expect(warn?.reason).toBe('existing_issue_not_worsened')
    }
  })
})
