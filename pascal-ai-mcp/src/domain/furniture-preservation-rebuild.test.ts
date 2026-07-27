import { describe, expect, it } from 'bun:test'
import { DEFAULT_NORM_PROFILE } from '../norms/profile'
import type { FurnitureRoom } from '../furniture-executor'
import { polygonArea, type LayoutPlan } from '../layout-plan'
import { applyLocalStructuralEdits } from './local-structural-edit'
import { planFurnitureRestoration, type PreservedFurniture } from './furniture-preservation'

// The reported regression, end to end at the decision level: in a furnished
// 2LDK the user asks to "add a storage room in the living room". Before the
// fix the rebuild deleted all ~12 items and re-scanned every one of them, so
// furniture in the bedrooms visibly jumped. The contract now is:
//   • furniture in rooms the edit never touched → restored at EXACT old coords
//   • furniture in the host room, outside the carved area → also kept
//   • only furniture standing where the new room now is → relocated
function furnishedTwoLdk(): LayoutPlan {
  return {
    footprint: { width: 10, depth: 7 },
    entry: { roomId: 'ldk' },
    rooms: [
      { id: 'ldk', name: 'LDK', type: 'living_kitchen', requiresExteriorWindow: true,
        polygon: [[0, 0], [6, 0], [6, 7], [0, 7]] },
      { id: 'bed1', name: '主卧', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 0], [10, 0], [10, 3.5], [6, 3.5]] },
      { id: 'bed2', name: '次卧', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[6, 3.5], [10, 3.5], [10, 7], [6, 7]] },
    ],
    connections: [
      { from: 'ldk', to: 'bed1', type: 'door' },
      { from: 'ldk', to: 'bed2', type: 'door' },
    ],
  }
}

const profile = DEFAULT_NORM_PROFILE

const asFurnitureRooms = (plan: LayoutPlan): FurnitureRoom[] => plan.rooms.map(room => ({
  id: room.id, name: room.name, type: room.type, polygon: room.polygon, zoneId: `zone-${room.id}`,
}))

const centroid = (polygon: Array<[number, number]>): [number, number] => {
  const xs = polygon.map(p => p[0]); const zs = polygon.map(p => p[1])
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]
}

describe('adding a room must not move the rest of the flat’s furniture', () => {
  const before = furnishedTwoLdk()
  const edit = applyLocalStructuralEdits(before, [{
    op: {
      op: 'add_room',
      room: { name: '收纳', type: 'storage', targetAreaSqm: 3 },
      near: 'ldk',
      operationId: 'op-0',
    },
  }], profile)

  it('carves the storage room locally', () => {
    expect(edit.ok).toBe(true)
  })

  it('keeps untouched-room furniture in place and only moves what stands in the new room', () => {
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    const storage = edit.plan.rooms.find(room => room.type === 'storage')!
    const [sx, sz] = centroid(storage.polygon)
    const ldkAfter = edit.plan.rooms.find(room => room.id === 'ldk')!

    // A spot deep in the LDK that the carve did not take (mirrored away from
    // the storage corner), so it must survive untouched.
    const ldkKeepSpot: [number, number] = [
      sx > 3 ? 1.5 : 4.5,
      sz > 3.5 ? 1.5 : 5.5,
    ]

    const items: PreservedFurniture[] = [
      // Bedrooms — completely unrelated to the edit.
      mk('双人床', 'bed1', [8, 0, 1.6], [1.8, 0.5, 2.1], 0),
      mk('衣柜', 'bed1', [8, 0, 3.0], [1.2, 2.2, 0.6], 0),
      mk('单人床', 'bed2', [8, 0, 5.2], [1.0, 0.5, 1.9], 0),
      // Host room, away from the carve.
      mk('沙发', 'ldk', [ldkKeepSpot[0], 0, ldkKeepSpot[1]], [2.0, 0.8, 0.9], 0),
      // Standing exactly where the new storage room now is.
      mk('边几', 'ldk', [sx, 0, sz], [0.5, 0.5, 0.5], 0),
    ]

    const { decisions } = planFurnitureRestoration({
      items,
      rooms: asFurnitureRooms(edit.plan),
      keepClear: [],
    })
    const byName = new Map(decisions.map(entry => [entry.item.name, entry.kind]))

    // Nothing in the bedrooms moves — the headline guarantee.
    expect(byName.get('双人床')).toBe('keep')
    expect(byName.get('衣柜')).toBe('keep')
    expect(byName.get('单人床')).toBe('keep')
    // The sofa stays too: the LDK only lost its corner.
    expect(byName.get('沙发')).toBe('keep')
    // Only the piece standing inside the new room has to move.
    expect(byName.get('边几')).toBe('relocate')
    // Four of five items keep their exact coordinates.
    expect(decisions.filter(entry => entry.kind === 'keep')).toHaveLength(4)

    // Sanity: the carve really did shrink the LDK and conserve total area.
    expect(polygonArea(ldkAfter.polygon)).toBeCloseTo(42 - polygonArea(storage.polygon), 1)
  })
})

function mk(
  name: string,
  roomId: string,
  position: [number, number, number],
  dimensions: [number, number, number],
  rotationY: number,
): PreservedFurniture {
  return {
    sourceItemId: `src-${name}`,
    catalogItemId: `cat-${name}`,
    name,
    assetName: name,
    roomId,
    roomName: roomId,
    position,
    dimensions,
    scale: [1, 1, 1],
    rotationY,
  }
}
