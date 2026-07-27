// ---------------------------------------------------------------------------
// Furniture preservation across a structural rebuild.
//
// A local structural edit ("add a storage room in the living room") only
// changes one room and its necessary neighbours — but the scene is still built
// by clearing the level and re-executing the plan. Without this module every
// item in the flat would be deleted and re-scanned into a fresh position, so
// furniture in rooms the user never touched visibly jumps around.
//
// This is the decision policy for that: given the furniture captured BEFORE the
// clear and the rooms as they exist AFTER it, decide per item whether it can go
// back exactly where it was, needs a new spot in the same room, or is gone with
// its room. Pure — no MCP, no catalogue, no model. The executor
// (restoreFurnitureAfterRebuild) just carries the decisions out.
//
// Acceptance of a "keep" placement goes through the executor's own
// `placementFits`, so a spot we preserve is always a spot the placement scan
// would itself have accepted.
// ---------------------------------------------------------------------------

import {
  footprintAt,
  placementFits,
  type Footprint2D,
  type FurnitureRoom,
} from '../furniture-executor'
import { pointInPolygon, type LayoutPlan } from '../layout-plan'

// Stable outcome codes for the restoration audit — same discipline as the
// local-edit reason codes: reports and tests compare on these, never on the
// localized prose that accompanies them.
export const FURNITURE_RESTORE_REASON_CODES = [
  'room_removed',
  'no_valid_placement',
  // The spot was valid and available — the WRITE itself was rejected. Distinct
  // from no_valid_placement so audits do not blame the geometry for a
  // server-side refusal.
  'restore_write_failed',
  'catalog_unavailable',
] as const

export type FurnitureRestoreReasonCode = typeof FURNITURE_RESTORE_REASON_CODES[number]

// One floor item captured from the pre-rebuild scene.
export type PreservedFurniture = {
  // Pre-rebuild node id — reporting/diagnostics only; the rebuilt item is new.
  sourceItemId: string
  catalogItemId: string
  // The item node's own name, which the user may have edited. Restored via a
  // follow-up patch, because place_item has no name parameter.
  name: string
  // The catalogue asset's name — the value place_item will give the new node.
  // Comparing the two is how we detect a user rename worth restoring.
  assetName: string
  // Footprint dimensions WITH the node's scale already applied: the collision
  // math must use the item's real size, not the catalogue's unscaled spec.
  dimensions: [number, number, number]
  // The node's scale, re-applied after placement (place_item always creates a
  // node at scale 1).
  scale: [number, number, number]
  position: [number, number, number]
  rotationY: number
  // Stable plan-room id — the join key across the rebuild. Deliberately NOT
  // the room name: a plan that renames a room in the same turn would otherwise
  // orphan every item in it (rooms are matched against the POST-edit plan).
  roomId: string
  // Display only.
  roomName: string
}

export type RestorationDecision =
  // Original coordinates are still legal — put it back exactly as it was.
  | { kind: 'keep'; item: PreservedFurniture; room: FurnitureRoom }
  // Room survives but the old spot is no longer legal (new wall, shrunk room,
  // door clearance, collision) — the executor searches for a new spot.
  | { kind: 'relocate'; item: PreservedFurniture; room: FurnitureRoom; reason: string }
  // The room itself is gone; the item goes with it (explicitly reported).
  | { kind: 'drop'; item: PreservedFurniture; reasonCode: 'room_removed'; reason: string }

export type RestorationPlan = {
  decisions: RestorationDecision[]
  // Footprints of EVERY kept item. The executor seeds its occupancy with these
  // before placing anything, so a relocation can never be sent to a spot that a
  // later keep is going to occupy (the two passes must not disagree).
  keptFootprints: Footprint2D[]
  keptCollisionFootprints: Footprint2D[]
}

// Decide what happens to each captured item. Items are processed in the order
// given and each `keep` reserves its footprint, so the outcome is deterministic
// and two kept items can never be approved onto the same space.
export function planFurnitureRestoration(options: {
  items: readonly PreservedFurniture[]
  rooms: readonly FurnitureRoom[]
  keepClear: readonly Footprint2D[]
}): RestorationPlan {
  const { items, rooms, keepClear } = options
  const decisions: RestorationDecision[] = []
  const keptFootprints: Footprint2D[] = []
  const keptCollisionFootprints: Footprint2D[] = []

  for (const item of items) {
    const room = rooms.find(candidate => candidate.id === item.roomId)
    if (!room) {
      decisions.push({
        kind: 'drop',
        item,
        reasonCode: 'room_removed',
        reason: `所在房间「${item.roomName}」已随本次修改删除`,
      })
      continue
    }
    const fits = placementFits({
      position: item.position,
      rotationY: item.rotationY,
      itemDims: item.dimensions,
      polygon: room.polygon,
      occupied: keptFootprints,
      collisionOccupied: keptCollisionFootprints,
      keepClear,
    })
    if (!fits) {
      decisions.push({
        kind: 'relocate',
        item,
        room,
        reason: '原位置在修改后不再可用（越界、与其他家具或门净空冲突）',
      })
      continue
    }
    decisions.push({ kind: 'keep', item, room })
    keptFootprints.push(footprintAt(
      item.position[0], item.position[2], item.dimensions[0], item.dimensions[2], item.rotationY,
    ))
    keptCollisionFootprints.push(footprintAt(
      item.position[0], item.position[2], item.dimensions[0], item.dimensions[2], 0,
    ))
  }
  return { decisions, keptFootprints, keptCollisionFootprints }
}

// Relocations compete for the leftover space, so the bulky pieces must claim it
// first — the same "hardest first" rule the generation executor packs rooms
// with. Without it a plant can take the only long wall and the bed becomes
// unplaceable. Ties break on stable identity so the order is deterministic.
export function relocationOrder(
  decisions: readonly RestorationDecision[],
): Array<Extract<RestorationDecision, { kind: 'relocate' }>> {
  return decisions
    .filter((decision): decision is Extract<RestorationDecision, { kind: 'relocate' }> =>
      decision.kind === 'relocate')
    .sort((left, right) => {
      const areaOf = (entry: typeof left) => entry.item.dimensions[0] * entry.item.dimensions[2]
      return areaOf(right) - areaOf(left)
        || (left.item.sourceItemId < right.item.sourceItemId ? -1 : 1)
    })
}

// --- snapshot extraction -----------------------------------------------------
//
// Turning raw scene nodes into PreservedFurniture is the riskiest part of the
// restore: misreading a coordinate frame flings an item across the flat, and
// misreading the room join key loses it entirely. Kept pure and exported so
// those rules are locked down by tests instead of living inline in the agent.

type ZoneLike = { id: string; name: string; polygon: Array<[number, number]> }

// Which PRE-edit plan room does a floor point belong to? Resolved against the
// plan, whose room ids are the stable join key across the rebuild. Falls back
// to the live zones — if the scene drifted from the plan, an item sitting in a
// zone the plan does not cover would otherwise be silently dropped. The
// fallback maps back through the zone NAME, which is safe because both sides
// are pre-edit names.
export function homeRoomForPoint(
  x: number,
  z: number,
  beforePlan: LayoutPlan,
  zones: readonly ZoneLike[],
): { id: string; name: string } | null {
  const planRoom = beforePlan.rooms.find(room => pointInPolygon(x, z, room.polygon))
  if (planRoom) return { id: planRoom.id, name: planRoom.name }
  const zone = zones.find(candidate => pointInPolygon(x, z, candidate.polygon))
  if (!zone) return null
  const named = beforePlan.rooms.find(room => room.name === zone.name)
  return named ? { id: named.id, name: named.name } : null
}

const numberTriple = (
  candidate: unknown,
  fallback: [number, number, number],
): [number, number, number] =>
  Array.isArray(candidate) && candidate.length === 3 && candidate.every(n => typeof n === 'number')
    ? candidate as [number, number, number]
    : fallback

// Capture every FREE-STANDING floor item, with the exact state needed to put it
// back unchanged. Everything mounted (`attachTo` wall / wall-side / ceiling) or
// hosted by a wall, roof face or another item is excluded: those store position
// in their host's LOCAL frame, so treating the numbers as floor coordinates
// would move the item somewhere else entirely.
export function preservedFurnitureFromNodes(options: {
  nodes: Record<string, Record<string, unknown>>
  beforePlan: LayoutPlan
  zones: readonly ZoneLike[]
}): PreservedFurniture[] {
  const { nodes, beforePlan, zones } = options
  const nestedItemIds = new Set<string>(
    Object.values(nodes).flatMap(node =>
      node.type === 'item' && Array.isArray((node as { children?: unknown }).children)
        ? (node as { children: unknown[] }).children.filter((id): id is string => typeof id === 'string')
        : []),
  )
  return Object.entries(nodes).flatMap(([nodeId, node]) => {
    if (node.type !== 'item') return []
    const value = node as {
      name?: unknown
      position?: unknown
      rotation?: unknown
      scale?: unknown
      wallId?: unknown
      roofSegmentId?: unknown
      asset?: { id?: unknown; name?: unknown; dimensions?: unknown; attachTo?: unknown }
    }
    const assetId = typeof value.asset?.id === 'string' ? value.asset.id : null
    const position = value.position
    if (!assetId || !Array.isArray(position) || position.length !== 3) return []
    if (position.some(coordinate => typeof coordinate !== 'number')) return []
    if (value.asset?.attachTo !== undefined && value.asset.attachTo !== null) return []
    if (typeof value.wallId === 'string' || typeof value.roofSegmentId === 'string') return []
    if (nestedItemIds.has(nodeId)) return []
    const assetName = typeof value.asset?.name === 'string' ? value.asset.name : assetId
    const name = typeof value.name === 'string' && value.name ? value.name : assetName
    const scale = numberTriple(value.scale, [1, 1, 1])
    const spec = numberTriple(value.asset?.dimensions, [1, 1, 1])
    const home = homeRoomForPoint(position[0] as number, position[2] as number, beforePlan, zones)
    if (!home) return []
    return [{
      sourceItemId: nodeId,
      catalogItemId: assetId,
      name,
      assetName,
      // Collision/placement math must use the item's REAL size.
      dimensions: [spec[0] * scale[0], spec[1] * scale[1], spec[2] * scale[2]] as [number, number, number],
      scale,
      position: position as [number, number, number],
      rotationY: numberTriple(value.rotation, [0, 0, 0])[1],
      roomId: home.id,
      roomName: home.name,
    }]
  })
}
