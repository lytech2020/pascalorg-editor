import { describe, expect, it } from 'bun:test'
import { DEFAULT_NORM_PROFILE } from '../norms/profile'
import { polygonArea, type LayoutPlan } from '../layout-plan'
import { applyLocalStructuralEdits } from './local-structural-edit'
import type { StructuralModifyOp } from '../modify-ops'
import { validateModificationPostconditions } from './modification-postconditions'

// 10m × 6m footprint (60㎡): an LDK hub plus two bedrooms — a compact 2LDK.
//   LDK [0,0]-[6,6] 36㎡   bed1 [6,0]-[10,3] 12㎡   bed2 [6,3]-[10,6] 12㎡
function twoLdkPlan(): LayoutPlan {
  return {
    footprint: { width: 10, depth: 6 },
    entry: { roomId: 'ldk' },
    rooms: [
      { id: 'ldk', name: 'LDK', type: 'living_kitchen', requiresExteriorWindow: true,
        polygon: [[0, 0], [6, 0], [6, 6], [0, 6]] },
      { id: 'bed1', name: '卧室1', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 0], [10, 0], [10, 3], [6, 3]] },
      { id: 'bed2', name: '卧室2', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 3], [10, 3], [10, 6], [6, 6]] },
    ],
    connections: [
      { from: 'ldk', to: 'bed1', type: 'door' },
      { from: 'ldk', to: 'bed2', type: 'door' },
      { from: 'bed1', to: 'bed2', type: 'door' },
    ],
  }
}

const profile = DEFAULT_NORM_PROFILE
const withId = (op: StructuralModifyOp, id: string): StructuralModifyOp => ({ ...op, operationId: id })
const footprintArea = (plan: LayoutPlan) => plan.footprint.width * plan.footprint.depth
const stable = (polygon: Array<[number, number]>) =>
  JSON.stringify(polygon.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]))

describe('applyLocalStructuralEdits — add_room (carve)', () => {
  it('carves a storage room from the LDK without changing footprint or other rooms', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [{
      op: withId({ op: 'add_room', room: { name: '储物间', type: 'storage', targetAreaSqm: 3 } }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Footprint (bounding area) unchanged; rooms still tile it exactly.
    const roomArea = outcome.plan.rooms.reduce((s, r) => s + polygonArea(r.polygon), 0)
    expect(roomArea).toBeCloseTo(footprintArea(before), 1)
    // New storage room exists near the requested area.
    const storage = outcome.plan.rooms.find(r => r.type === 'storage')
    expect(storage).toBeDefined()
    expect(polygonArea(storage!.polygon)).toBeCloseTo(3, 1)
    // Both bedrooms are untouched, vertex for vertex.
    for (const id of ['bed1', 'bed2']) {
      expect(stable(outcome.plan.rooms.find(r => r.id === id)!.polygon))
        .toBe(stable(before.rooms.find(r => r.id === id)!.polygon))
    }
    // The LDK gave up the area (now smaller), and the new room is connected.
    const ldk = outcome.plan.rooms.find(r => r.id === 'ldk')!
    expect(polygonArea(ldk.polygon)).toBeCloseTo(33, 1)
    expect(outcome.plan.connections.some(c =>
      c.from === storage!.id || c.to === storage!.id)).toBe(true)
    expect(outcome.results[0]!.reasonCode).toBe('local_add_applied')
  })

  it('uses the profile default area when the request omits one', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({ op: 'add_room', room: { name: '储物间', type: 'storage' } }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const storage = outcome.plan.rooms.find(r => r.type === 'storage')!
    expect(polygonArea(storage.polygon)).toBeCloseTo(profile.defaultRoomAreas.storage, 1)
  })

  it('rejects when the host cannot spare the requested area', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({ op: 'add_room', room: { name: '大储物间', type: 'storage', targetAreaSqm: 40 } }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection.reasonCode).toBe('no_safe_carve_candidate')
  })

  it('honours an explicit host via near', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({ op: 'add_room', room: { name: '衣帽间', type: 'storage', targetAreaSqm: 3 }, near: 'bed1' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Carved from bed1: bed1 shrank, bed2 & LDK untouched.
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed1')!.polygon)).toBeCloseTo(9, 1)
    for (const id of ['ldk', 'bed2']) {
      expect(stable(outcome.plan.rooms.find(r => r.id === id)!.polygon))
        .toBe(stable(twoLdkPlan().rooms.find(r => r.id === id)!.polygon))
    }
  })

  it('rejects an unresolved explicit host instead of silently carving from another room', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({
        op: 'add_room',
        room: { name: '衣帽间', type: 'storage', targetAreaSqm: 3 },
        near: '不存在的主卧',
      }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection.reasonCode).toBe('host_room_not_found')
    expect(outcome.results).toEqual([
      expect.objectContaining({
        operationId: 'op-0',
        status: 'rejected',
        reasonCode: 'host_room_not_found',
      }),
    ])
  })
})

describe('applyLocalStructuralEdits — resize_room (boundary shift)', () => {
  it('grows a room by taking area from a clean neighbour', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [{
      op: withId({ op: 'resize_room', room: 'bed1', targetAreaSqm: 16, areaMode: 'exact' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed1')!.polygon)).toBeCloseTo(16, 1)
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed2')!.polygon)).toBeCloseTo(8, 1)
    // LDK — the unrelated room — is byte-identical.
    expect(stable(outcome.plan.rooms.find(r => r.id === 'ldk')!.polygon))
      .toBe(stable(before.rooms.find(r => r.id === 'ldk')!.polygon))
    expect(outcome.results[0]!.reasonCode).toBe('local_resize_boundary_shifted')
  })

  it('shrinks a room and gives the area to a neighbour', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({ op: 'resize_room', room: 'bed1', targetAreaSqm: 8, areaMode: 'exact' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed1')!.polygon)).toBeCloseTo(8, 1)
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed2')!.polygon)).toBeCloseTo(16, 1)
  })

  it('treats at_least as a no-op when the room already satisfies the bound', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [{
      op: withId({ op: 'resize_room', room: 'bed1', targetAreaSqm: 10, areaMode: 'at_least' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Nothing moved.
    for (const room of before.rooms) {
      expect(stable(outcome.plan.rooms.find(r => r.id === room.id)!.polygon)).toBe(stable(room.polygon))
    }
    expect(outcome.changed).toBe(false)
    expect(outcome.affectedRoomIds).toEqual([])
    expect(outcome.results[0]).toEqual(expect.objectContaining({
      status: 'no_change',
      reasonCode: 'local_resize_already_satisfied',
      affectedRoomIds: [],
    }))
  })

  it('uses the same exact-area tolerance as postcondition validation', () => {
    const before = twoLdkPlan()
    const op = withId({
      op: 'resize_room',
      room: 'bed1',
      targetAreaSqm: 13,
      areaMode: 'exact',
    }, 'op-0')
    const outcome = applyLocalStructuralEdits(before, [{ op }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changed).toBe(true)
    expect(polygonArea(outcome.plan.rooms.find(room => room.id === 'bed1')!.polygon))
      .toBeCloseTo(13, 1)
    expect(validateModificationPostconditions({
      before,
      after: outcome.plan,
      plan: { ops: [op] },
    })).toEqual([])
  })

  it('resolves a living-room alias to an LDK by stable room identity', () => {
    const before = twoLdkPlan()
    const op = withId({
      op: 'resize_room',
      room: '客厅',
      targetAreaSqm: 36,
      areaMode: 'exact',
    }, 'op-0')
    const outcome = applyLocalStructuralEdits(before, [{ op }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.changed).toBe(false)
    expect(outcome.results[0]).toEqual(expect.objectContaining({
      status: 'no_change',
      afterAreaSqm: 36,
    }))
    expect(validateModificationPostconditions({
      before,
      after: outcome.plan,
      plan: { ops: [op] },
    })).toEqual([])
  })

  it('rejects when the only donor would drop below its hard minimum', () => {
    const outcome = applyLocalStructuralEdits(twoLdkPlan(), [{
      op: withId({ op: 'resize_room', room: 'bed1', targetAreaSqm: 22, areaMode: 'exact' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection.reasonCode).toBe('insufficient_donor_area')
  })
})

describe('applyLocalStructuralEdits — remove_room (absorb)', () => {
  it('absorbs a removed room into the neighbour with the longest shared edge', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [{
      op: withId({ op: 'remove_room', room: 'bed2' }, 'op-0'),
    }], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.plan.rooms.find(r => r.id === 'bed2')).toBeUndefined()
    // bed1 shares a 4m edge with bed2 (vs LDK's 3m) → bed1 is the absorber.
    expect(polygonArea(outcome.plan.rooms.find(r => r.id === 'bed1')!.polygon)).toBeCloseTo(24, 1)
    // LDK is untouched; total area conserved.
    expect(stable(outcome.plan.rooms.find(r => r.id === 'ldk')!.polygon))
      .toBe(stable(before.rooms.find(r => r.id === 'ldk')!.polygon))
    expect(outcome.results[0]!.reasonCode).toBe('local_remove_absorbed')
  })
})

describe('applyLocalStructuralEdits — mixed / abort', () => {
  it('applies add + resize together, editing only the affected rooms', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [
      { op: withId({ op: 'resize_room', room: 'bed1', targetAreaSqm: 15, areaMode: 'exact' }, 'op-0') },
      { op: withId({ op: 'add_room', room: { name: '储物间', type: 'storage', targetAreaSqm: 3 } }, 'op-1') },
    ], profile)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map(r => r.status)).toEqual(['applied', 'applied'])
    expect(outcome.plan.rooms.find(r => r.type === 'storage')).toBeDefined()
  })

  it('leaves the plan untouched (zero-write) when any structural op cannot be done locally', () => {
    const before = twoLdkPlan()
    const outcome = applyLocalStructuralEdits(before, [
      { op: withId({ op: 'add_room', room: { name: '储物间', type: 'storage', targetAreaSqm: 3 } }, 'op-0') },
      { op: withId({ op: 'add_room', room: { name: '巨型间', type: 'storage', targetAreaSqm: 200 } }, 'op-1') },
    ], profile)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.rejection.operationId).toBe('op-1')
    // The plan is atomic: an earlier staged edit was never committed to the scene.
    expect(outcome.results.map(result => [result.status, result.reasonCode])).toEqual([
      ['skipped', 'transaction_aborted'],
      ['rejected', 'no_safe_carve_candidate'],
    ])
  })
})
