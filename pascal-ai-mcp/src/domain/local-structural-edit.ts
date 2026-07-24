// ---------------------------------------------------------------------------
// Local structural edit engine (docs/MODIFY_REDESIGN.md §8, generalised).
//
// A DETERMINISTIC, pure geometry engine that applies add_room / remove_room /
// resize_room to an existing LayoutPlan by editing ONLY the target room and its
// necessary neighbours — every unrelated room keeps its exact polygon, and the
// footprint / total floor area stay constant. This is the "局部结构计划引擎":
// it runs entirely in memory and returns a rejection (never a partial plan)
// when the edit cannot be done safely, so the caller can keep zero scene
// writes and decide whether to escalate to a full re-partition.
//
// No dependency on MCP, SQLite, the model, or the agent. Rectangles are the
// common case the structure phase produces; the engine works on axis-aligned
// rooms and refuses (falls back) rather than guessing when a room's shape is
// too irregular to edit locally.
// ---------------------------------------------------------------------------

import { polygonAspectRatio } from '../layout-metrics'
import { absorbRoomsInPlan } from '../layout-partitioner'
import {
  defaultRequiresWindow,
  isMiniCloset,
  longestExteriorEdge,
  longestSharedEdge,
  MINI_CLOSET_MIN_OPENING_M,
  polygonArea,
  polygonBounds,
  roundCm,
  type LayoutPlan,
  type LayoutPlanRoom,
  type RoomType,
} from '../layout-plan'
import { classifyRoomTypeByName } from '../lang/room-vocab'
import type { NormProfile } from '../norms/profile'
import { TYPE_TO_KIND, areaBoundFor } from './policy/room-policy'
import { resolveRoomRef, type StructuralModifyOp } from '../modify-ops'
import { areaSatisfiesTarget } from './modification-postconditions'

// Reason codes for every structural operation outcome (docs spec §8). Stable
// identifiers — never Chinese prose — so audit/telemetry and the validation
// diff compare on codes and numbers, not localized strings.
export const LOCAL_EDIT_REASON_CODES = [
  'local_add_applied',
  'local_remove_absorbed',
  'local_resize_boundary_shifted',
  'local_resize_already_satisfied',
  'host_room_not_found',
  'no_safe_carve_candidate',
  'no_safe_absorption_target',
  'insufficient_donor_area',
  'connectivity_would_break',
  'geometry_would_be_invalid',
  'overall_rebuild_required',
  'transaction_aborted',
] as const

export type LocalEditReasonCode = typeof LOCAL_EDIT_REASON_CODES[number]

export type LocalOperationResult = {
  operationId: string
  op: StructuralModifyOp['op']
  status: 'applied' | 'no_change' | 'rejected' | 'skipped'
  reasonCode: LocalEditReasonCode
  affectedRoomIds: string[]
  beforeAreaSqm?: number
  afterAreaSqm?: number
}

export type LocalEditSuccess = {
  ok: true
  plan: LayoutPlan
  results: LocalOperationResult[]
  affectedRoomIds: string[]
  notes: string[]
  changed: boolean
}

export type LocalEditFailure = {
  ok: false
  results: LocalOperationResult[]
  // The op that could not be applied locally; drives the mode-specific reply.
  rejection: LocalOperationResult
}

export type LocalEditOutcome = LocalEditSuccess | LocalEditFailure

const AREA_EPS = 1e-4

// --- rectangle helpers -------------------------------------------------------

type Rect = { minX: number; minZ: number; maxX: number; maxZ: number }

// The room is a plain rectangle iff its bounding box has the same area as the
// polygon. L-shaped / notched rooms return null — the carve and resize routines
// only operate on clean rectangles and fall back otherwise.
function asRectangle(polygon: ReadonlyArray<[number, number]>): Rect | null {
  const b = polygonBounds(polygon as Array<[number, number]>)
  const bboxArea = (b.maxX - b.minX) * (b.maxZ - b.minZ)
  if (bboxArea <= AREA_EPS) return null
  if (Math.abs(bboxArea - polygonArea(polygon as Array<[number, number]>)) > AREA_EPS) return null
  return { minX: b.minX, minZ: b.minZ, maxX: b.maxX, maxZ: b.maxZ }
}

function rectPolygon(r: Rect): Array<[number, number]> {
  return [
    [r.minX, r.minZ],
    [r.maxX, r.minZ],
    [r.maxX, r.maxZ],
    [r.minX, r.maxZ],
  ]
}

function rectArea(r: Rect): number {
  return (r.maxX - r.minX) * (r.maxZ - r.minZ)
}

// Remove an axis-aligned bite anchored at one corner of `host`, returning the
// remainder as a simplified (collinear runs merged) CCW polygon. When the bite
// spans a full side the remainder is a rectangle; otherwise it is an L.
function subtractCornerBite(
  host: Rect,
  corner: 'sw' | 'se' | 'nw' | 'ne',
  w: number,
  h: number,
): Array<[number, number]> {
  const { minX, minZ, maxX, maxZ } = host
  // Vertices walked CCW; simplifyPolygon drops the collinear points that appear
  // when the bite is a full-width or full-depth strip.
  let loop: Array<[number, number]>
  if (corner === 'sw') {
    loop = [
      [minX + w, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ + h], [minX + w, minZ + h],
    ]
  } else if (corner === 'se') {
    loop = [
      [minX, minZ], [maxX - w, minZ], [maxX - w, minZ + h], [maxX, minZ + h], [maxX, maxZ], [minX, maxZ],
    ]
  } else if (corner === 'nw') {
    loop = [
      [minX, minZ], [maxX, minZ], [maxX, maxZ], [minX + w, maxZ], [minX + w, maxZ - h], [minX, maxZ - h],
    ]
  } else {
    loop = [
      [minX, minZ], [maxX, minZ], [maxX, maxZ - h], [maxX - w, maxZ - h], [maxX - w, maxZ], [minX, maxZ],
    ]
  }
  return simplifyPolygon(loop.map(([x, z]) => [roundCm(x), roundCm(z)] as [number, number]))
}

function biteRect(host: Rect, corner: 'sw' | 'se' | 'nw' | 'ne', w: number, h: number): Rect {
  const { minX, minZ, maxX, maxZ } = host
  if (corner === 'sw') return { minX, minZ, maxX: minX + w, maxZ: minZ + h }
  if (corner === 'se') return { minX: maxX - w, minZ, maxX, maxZ: minZ + h }
  if (corner === 'nw') return { minX, minZ: maxZ - h, maxX: minX + w, maxZ }
  return { minX: maxX - w, minZ: maxZ - h, maxX, maxZ }
}

// Merge collinear runs and drop zero-length vertices — keeps polygons minimal
// so shared-edge and rectangle tests stay exact.
function simplifyPolygon(loop: Array<[number, number]>): Array<[number, number]> {
  const deduped: Array<[number, number]> = []
  for (const point of loop) {
    const last = deduped[deduped.length - 1]
    if (!last || Math.abs(last[0] - point[0]) > 1e-9 || Math.abs(last[1] - point[1]) > 1e-9) {
      deduped.push(point)
    }
  }
  const out: Array<[number, number]> = []
  for (let i = 0; i < deduped.length; i++) {
    const prev = deduped[(i - 1 + deduped.length) % deduped.length]!
    const curr = deduped[i]!
    const next = deduped[(i + 1) % deduped.length]!
    const collinear = (Math.abs(prev[0] - curr[0]) < 1e-9 && Math.abs(curr[0] - next[0]) < 1e-9)
      || (Math.abs(prev[1] - curr[1]) < 1e-9 && Math.abs(curr[1] - next[1]) < 1e-9)
    if (!collinear) out.push(curr)
  }
  return out
}

// --- shared connectivity guard ----------------------------------------------

function minOpeningFor(a: LayoutPlanRoom, b: LayoutPlanRoom, minDoorEdge: number): number {
  return isMiniCloset(a) || isMiniCloset(b) ? MINI_CLOSET_MIN_OPENING_M : minDoorEdge
}

// Every connection touching a changed room must still have a usable shared
// wall in the edited plan — otherwise the edit silently severed a door.
function connectionsPreserved(
  plan: LayoutPlan,
  changedRoomIds: ReadonlySet<string>,
  minDoorEdge: number,
): boolean {
  const byId = new Map(plan.rooms.map(room => [room.id, room]))
  for (const conn of plan.connections) {
    if (!changedRoomIds.has(conn.from) && !changedRoomIds.has(conn.to)) continue
    const a = byId.get(conn.from)
    const b = byId.get(conn.to)
    if (!a || !b) return false
    if (longestSharedEdge(a.polygon, b.polygon).length < minOpeningFor(a, b, minDoorEdge) - 1e-6) {
      return false
    }
  }
  return true
}

function bedroomCountOf(plan: LayoutPlan): number {
  return plan.rooms.filter(room => room.type === 'bedroom').length
}

function fatalMinFor(plan: LayoutPlan, room: { type: RoomType; name: string }, profile: NormProfile): number {
  const totalAreaSqm = plan.rooms.reduce((sum, r) => sum + polygonArea(r.polygon), 0)
  const bound = areaBoundFor(
    profile,
    { totalAreaSqm, bedroomCount: bedroomCountOf(plan) },
    room.type,
    room.name,
    plan.rooms.some(r => r.type === 'kitchen'),
  )
  return bound?.fatalMin ?? 0
}

// --- add_room (carve from host) ---------------------------------------------

// Host preference when the request gives no `near`: living-like hubs first
// (that is where a storage/study is normally carved from), then the largest
// non-circulation room. Circulation rooms are never carved (they ARE the path).
const HOST_TYPE_PRIORITY: RoomType[] = ['living', 'living_kitchen', 'dining']

function chooseHost(
  plan: LayoutPlan,
  op: Extract<StructuralModifyOp, { op: 'add_room' }>,
): LayoutPlanRoom | null {
  const carveable = plan.rooms.filter(room => TYPE_TO_KIND[room.type] !== 'circulation')
  if (op.near) {
    const exact = carveable.filter(room => room.id === op.near || room.name === op.near)
    if (exact.length === 1) return exact[0]!
    if (exact.length > 1) return null
    const type = classifyRoomTypeByName(op.near)
    const compatible = carveable.filter(room =>
      room.type === type
      || (type === 'living' && room.type === 'living_kitchen')
      || (type === 'kitchen' && room.type === 'living_kitchen'))
    return compatible.length === 1 ? compatible[0]! : null
  }
  for (const type of HOST_TYPE_PRIORITY) {
    const match = carveable
      .filter(room => room.type === type)
      .sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0]
    if (match) return match
  }
  return carveable.sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0] ?? null
}

const CORNERS: Array<'sw' | 'se' | 'nw' | 'ne'> = ['sw', 'se', 'nw', 'ne']

function carveAddRoom(
  plan: LayoutPlan,
  op: Extract<StructuralModifyOp, { op: 'add_room' }>,
  profile: NormProfile,
): { plan: LayoutPlan; affectedRoomIds: string[]; note: string } | { reject: LocalEditReasonCode } {
  const host = chooseHost(plan, op)
  if (!host) return { reject: 'host_room_not_found' }
  const hostRect = asRectangle(host.polygon)
  if (!hostRect) return { reject: 'no_safe_carve_candidate' }

  const area = op.room.targetAreaSqm ?? profile.defaultRoomAreas[op.room.type]
  const hostArea = rectArea(hostRect)
  const remainderArea = hostArea - area
  const hostFatalMin = fatalMinFor(plan, host, profile)
  if (remainderArea < hostFatalMin - AREA_EPS || remainderArea <= 0) {
    return { reject: 'no_safe_carve_candidate' }
  }

  const isService = op.room.type === 'storage' || op.room.type === 'bathroom'
  const minSide = isService ? profile.partition.minRoomWidthSmallM : profile.partition.minRoomWidthDefaultM
  const minDoor = profile.partition.minDoorEdgeM
  const maxAspect = profile.partition.maxRoomAspect
  const needsWindow = defaultRequiresWindow(op.room.type)
  const hostW = hostRect.maxX - hostRect.minX
  const hostD = hostRect.maxZ - hostRect.minZ

  // Candidate carve dimensions: aim for a near-square footprint, then fall back
  // to a wall-hugging strip when the room does not fit as a square. Only shapes
  // that keep both sides ≥ minSide, keep the new room's aspect legal (storage is
  // exempt — a shallow closet is its normal form) and leave the host's bbox
  // intact are considered.
  const shapeCandidates: Array<{ w: number; h: number }> = []
  const pushShape = (w: number, h: number) => {
    if (w < minSide - 1e-6 || h < minSide - 1e-6) return
    if (w > hostW + 1e-6 || h > hostD + 1e-6) return
    if (!isService && Math.max(w, h) / Math.min(w, h) > maxAspect + 1e-6) return
    shapeCandidates.push({ w: roundCm(w), h: roundCm(h) })
  }
  const square = Math.sqrt(area)
  pushShape(square, area / square)
  // Wall strips: fix one side to a bounded width so the other spans along a wall.
  for (const side of [minSide, square, Math.min(hostW, hostD)]) {
    pushShape(side, area / side)
    pushShape(area / side, side)
  }

  for (const { w, h } of shapeCandidates) {
    for (const corner of CORNERS) {
      const newRect = biteRect(hostRect, corner, w, h)
      const newPolygon = rectPolygon({
        minX: roundCm(newRect.minX),
        minZ: roundCm(newRect.minZ),
        maxX: roundCm(newRect.maxX),
        maxZ: roundCm(newRect.maxZ),
      })
      // Window rooms must sit on an exterior wall, or they are unlit and the
      // validator would (correctly) reject them as a new fatal.
      if (needsWindow && longestExteriorEdge(newPolygon, plan.footprint) < minDoor - 1e-6) continue
      const remainderPolygon = subtractCornerBite(hostRect, corner, w, h)
      if (remainderPolygon.length < 4) continue
      const newRoom: LayoutPlanRoom = {
        id: uniqueRoomId(op.room.type, plan.rooms),
        name: op.room.name,
        type: op.room.type,
        polygon: newPolygon,
        requiresExteriorWindow: needsWindow,
      }
      // The new room must have a usable door to the host it was carved from.
      if (longestSharedEdge(newRoom.polygon, remainderPolygon).length
        < minOpeningFor(newRoom, { ...host, polygon: remainderPolygon }, minDoor) - 1e-6) continue
      const remainderHost: LayoutPlanRoom = { ...host, polygon: remainderPolygon }
      const rooms = plan.rooms.map(room => room.id === host.id ? remainderHost : room).concat(newRoom)
      const connections = [...plan.connections, { from: newRoom.id, to: host.id, type: 'door' as const }]
      const candidate: LayoutPlan = { ...plan, rooms, connections }
      if (!connectionsPreserved(candidate, new Set([host.id, newRoom.id]), minDoor)) continue
      return {
        plan: candidate,
        affectedRoomIds: [host.id, newRoom.id],
        note: `从「${host.name}」角部切出「${op.room.name}」（${roundCm(polygonArea(newPolygon))}㎡），其余房间位置不变`,
      }
    }
  }
  return { reject: 'no_safe_carve_candidate' }
}

function uniqueRoomId(type: RoomType, rooms: ReadonlyArray<{ id: string }>): string {
  const ids = new Set(rooms.map(room => room.id))
  let n = 1
  let id = `${type}-${n}`
  while (ids.has(id)) id = `${type}-${++n}`
  return id
}

// --- resize_room (shared boundary shift) ------------------------------------

type CleanNeighbor = {
  room: LayoutPlanRoom
  axis: 'x' | 'z'
  // Divider coordinate on `axis`, and the shared span length on the other axis.
  divider: number
  sharedLen: number
  // True when `room` sits on the high side of the divider (its min == divider);
  // false when on the low side (its max == divider).
  targetIsLow: boolean
}

// Neighbours that form a clean two-cell split with the target: both rectangles,
// sharing a full wall, with matching extents on the perpendicular axis. Only
// these can trade area by sliding one wall while both stay rectangular.
function cleanNeighbors(plan: LayoutPlan, target: LayoutPlanRoom): CleanNeighbor[] {
  const t = asRectangle(target.polygon)
  if (!t) return []
  const out: CleanNeighbor[] = []
  for (const room of plan.rooms) {
    if (room.id === target.id) continue
    const d = asRectangle(room.polygon)
    if (!d) continue
    // Vertical divider (constant x): matching z-extents.
    if (Math.abs(t.minZ - d.minZ) < 1e-6 && Math.abs(t.maxZ - d.maxZ) < 1e-6) {
      if (Math.abs(t.maxX - d.minX) < 1e-6) {
        out.push({ room, axis: 'x', divider: t.maxX, sharedLen: t.maxZ - t.minZ, targetIsLow: true })
      } else if (Math.abs(d.maxX - t.minX) < 1e-6) {
        out.push({ room, axis: 'x', divider: t.minX, sharedLen: t.maxZ - t.minZ, targetIsLow: false })
      }
    }
    // Horizontal divider (constant z): matching x-extents.
    if (Math.abs(t.minX - d.minX) < 1e-6 && Math.abs(t.maxX - d.maxX) < 1e-6) {
      if (Math.abs(t.maxZ - d.minZ) < 1e-6) {
        out.push({ room, axis: 'z', divider: t.maxZ, sharedLen: t.maxX - t.minX, targetIsLow: true })
      } else if (Math.abs(d.maxZ - t.minZ) < 1e-6) {
        out.push({ room, axis: 'z', divider: t.minZ, sharedLen: t.maxX - t.minX, targetIsLow: false })
      }
    }
  }
  return out
}

function resizeRoom(
  plan: LayoutPlan,
  op: Extract<StructuralModifyOp, { op: 'resize_room' }>,
  profile: NormProfile,
): { plan: LayoutPlan; affectedRoomIds: string[]; note: string; changed: boolean } | { reject: LocalEditReasonCode } {
  const target = resolvePlanRoom(plan, op.room)
  if (!target) return { reject: 'geometry_would_be_invalid' }
  const t = asRectangle(target.polygon)
  if (!t) return { reject: 'geometry_would_be_invalid' }
  const currentArea = polygonArea(target.polygon)
  const mode = op.areaMode ?? 'exact'
  const delta = op.targetAreaSqm - currentArea
  // Already satisfies the goal — nothing to move (at_least met, or exact within
  // the same tolerance the postcondition check uses).
  const satisfied = areaSatisfiesTarget(currentArea, op.targetAreaSqm, mode)
  if (satisfied) {
    return {
      plan,
      affectedRoomIds: [target.id],
      note: `「${target.name}」面积 ${roundCm(currentArea)}㎡ 已满足目标 ${op.targetAreaSqm}㎡`,
      changed: false,
    }
  }

  const minDoor = profile.partition.minDoorEdgeM
  const minSideDefault = profile.partition.minRoomWidthDefaultM
  const candidates = cleanNeighbors(plan, target)
    // Largest shared wall first ⇒ smallest boundary displacement; stable id
    // tiebreak keeps the choice deterministic.
    .sort((a, b) => b.sharedLen - a.sharedLen || (a.room.id < b.room.id ? -1 : 1))

  for (const neighbor of candidates) {
    const d = asRectangle(neighbor.room.polygon)!
    const shift = delta / neighbor.sharedLen // >0 grows target, shrinks neighbor
    const neighborMinSide = neighbor.axis === 'x'
      ? (d.maxX - d.minX) - shift
      : (d.maxZ - d.minZ) - shift
    const targetMinSide = neighbor.axis === 'x'
      ? (t.maxX - t.minX) + shift
      : (t.maxZ - t.minZ) + shift
    if (neighborMinSide < minSideDefault - 1e-6 || targetMinSide < minSideDefault - 1e-6) continue
    const neighborNewArea = polygonArea(neighbor.room.polygon) - delta
    const neighborFatalMin = fatalMinFor(plan, neighbor.room, profile)
    if (neighborNewArea < neighborFatalMin - AREA_EPS) {
      // This donor cannot spare the area; try the next, else report the reason.
      continue
    }
    const newTargetRect = shiftDivider(t, neighbor, shift, true)
    const newNeighborRect = shiftDivider(d, neighbor, shift, false)
    const newTarget: LayoutPlanRoom = { ...target, polygon: roundedRectPolygon(newTargetRect) }
    const newNeighbor: LayoutPlanRoom = { ...neighbor.room, polygon: roundedRectPolygon(newNeighborRect) }
    const rooms = plan.rooms.map(room =>
      room.id === target.id ? newTarget : room.id === neighbor.room.id ? newNeighbor : room)
    const candidate: LayoutPlan = { ...plan, rooms }
    if (!connectionsPreserved(candidate, new Set([target.id, neighbor.room.id]), minDoor)) continue
    return {
      plan: candidate,
      affectedRoomIds: [target.id, neighbor.room.id],
      note: `「${target.name}」与「${neighbor.room.name}」的隔墙移动 ${roundCm(Math.abs(shift))}m，`
        + `${target.name} → ${roundCm(polygonArea(newTarget.polygon))}㎡`,
      changed: true,
    }
  }
  // A clean donor existed but none could spare enough area vs. its hard min.
  return { reject: candidates.length > 0 ? 'insufficient_donor_area' : 'geometry_would_be_invalid' }
}

function shiftDivider(rect: Rect, neighbor: CleanNeighbor, shift: number, isTarget: boolean): Rect {
  const r = { ...rect }
  if (neighbor.axis === 'x') {
    if (isTarget) {
      if (neighbor.targetIsLow) r.maxX += shift
      else r.minX -= shift
    } else {
      if (neighbor.targetIsLow) r.minX += shift
      else r.maxX -= shift
    }
  } else {
    if (isTarget) {
      if (neighbor.targetIsLow) r.maxZ += shift
      else r.minZ -= shift
    } else {
      if (neighbor.targetIsLow) r.minZ += shift
      else r.maxZ -= shift
    }
  }
  return r
}

function roundedRectPolygon(r: Rect): Array<[number, number]> {
  return rectPolygon({ minX: roundCm(r.minX), minZ: roundCm(r.minZ), maxX: roundCm(r.maxX), maxZ: roundCm(r.maxZ) })
}

function resolvePlanRoom(plan: LayoutPlan, ref: string): LayoutPlanRoom | null {
  const resolved = resolveRoomRef(ref, plan.rooms)
  return 'room' in resolved ? resolved.room : null
}

// --- remove_room (absorb into neighbour) ------------------------------------

function removeRoom(
  plan: LayoutPlan,
  roomIds: readonly string[],
  profile: NormProfile,
): { plan: LayoutPlan; affectedRoomIds: string[]; note: string } | { reject: LocalEditReasonCode } {
  if (roomIds.length === 0) return { reject: 'geometry_would_be_invalid' }
  if (plan.rooms.length - roomIds.length < 1) return { reject: 'geometry_would_be_invalid' }
  const absorbed = absorbRoomsInPlan(plan, roomIds, profile.partition.maxRoomAspect)
  if (!absorbed) return { reject: 'no_safe_absorption_target' }
  const absorberIds = absorbed.absorbedInto.map(room => room.id)
  const removedNames = roomIds
    .map(id => plan.rooms.find(room => room.id === id)?.name ?? id)
    .join('、')
  return {
    plan: absorbed.plan,
    affectedRoomIds: [...new Set([...roomIds, ...absorberIds])],
    note: `删除「${removedNames}」并入「${absorbed.absorbedInto.map(room => room.name).join('、')}」，其余房间位置不变`,
  }
}

// --- orchestration -----------------------------------------------------------

export type StructuralOpBinding = {
  op: StructuralModifyOp
  // Pre-resolved plan room ids for remove_room (the caller resolves generic
  // bathroom refs etc. with removalRoomIdsForRef before handing them over).
  removalIds?: string[]
}

// Apply a sequence of structural ops to a plan copy, one after another, editing
// only the target room and its necessary neighbours. Any op that cannot be done
// locally aborts the WHOLE plan with zero writes (the caller keeps the scene
// untouched and decides whether to escalate). rename_room is metadata-only and
// is handled by the caller, not here.
export function applyLocalStructuralEdits(
  before: LayoutPlan,
  bindings: readonly StructuralOpBinding[],
  profile: NormProfile,
): LocalEditOutcome {
  let plan = structuredClone(before)
  const results: LocalOperationResult[] = []
  const affected = new Set<string>()
  const notes: string[] = []
  let changed = false

  for (const binding of bindings) {
    const op = binding.op
    const operationId = op.operationId ?? `op-${results.length}`
    const beforeAreaOf = (ref: string) => {
      const room = resolvePlanRoom(plan, ref)
      return room ? roundCm(polygonArea(room.polygon)) : undefined
    }

    if (op.op === 'add_room') {
      const outcome = carveAddRoom(plan, op, profile)
      if ('reject' in outcome) {
        return failure(results, {
          operationId, op: op.op, status: 'rejected', reasonCode: outcome.reject, affectedRoomIds: [],
        })
      }
      const newId = outcome.affectedRoomIds[1]!
      results.push({
        operationId, op: op.op, status: 'applied', reasonCode: 'local_add_applied',
        affectedRoomIds: outcome.affectedRoomIds,
        afterAreaSqm: roundCm(polygonArea(plan.rooms.find(r => r.id === newId)?.polygon
          ?? outcome.plan.rooms.find(r => r.id === newId)!.polygon)),
      })
      plan = outcome.plan
      changed = true
      outcome.affectedRoomIds.forEach(id => affected.add(id))
      notes.push(outcome.note)
    } else if (op.op === 'resize_room') {
      const beforeArea = beforeAreaOf(op.room)
      const outcome = resizeRoom(plan, op, profile)
      if ('reject' in outcome) {
        return failure(results, {
          operationId, op: op.op, status: 'rejected', reasonCode: outcome.reject, affectedRoomIds: [],
          beforeAreaSqm: beforeArea,
        })
      }
      results.push({
        operationId,
        op: op.op,
        status: outcome.changed ? 'applied' : 'no_change',
        reasonCode: outcome.changed ? 'local_resize_boundary_shifted' : 'local_resize_already_satisfied',
        affectedRoomIds: outcome.changed ? outcome.affectedRoomIds : [],
        beforeAreaSqm: beforeArea,
        afterAreaSqm: beforeAreaOfPlan(outcome.plan, op.room),
      })
      plan = outcome.plan
      if (outcome.changed) {
        changed = true
        outcome.affectedRoomIds.forEach(id => affected.add(id))
      }
      notes.push(outcome.note)
    } else if (op.op === 'remove_room') {
      const removalIds = binding.removalIds ?? removalByRef(plan, op.room)
      const beforeArea = removalIds.reduce((sum, id) => {
        const room = plan.rooms.find(r => r.id === id)
        return room ? sum + polygonArea(room.polygon) : sum
      }, 0)
      const outcome = removeRoom(plan, removalIds, profile)
      if ('reject' in outcome) {
        return failure(results, {
          operationId, op: op.op, status: 'rejected', reasonCode: outcome.reject, affectedRoomIds: [],
          beforeAreaSqm: roundCm(beforeArea),
        })
      }
      results.push({
        operationId, op: op.op, status: 'applied', reasonCode: 'local_remove_absorbed',
        affectedRoomIds: outcome.affectedRoomIds, beforeAreaSqm: roundCm(beforeArea),
      })
      plan = outcome.plan
      changed = true
      outcome.affectedRoomIds.forEach(id => affected.add(id))
      notes.push(outcome.note)
    }
    // rename_room is intentionally not applied here.
  }

  return { ok: true, plan, results, affectedRoomIds: [...affected], notes, changed }
}

function beforeAreaOfPlan(plan: LayoutPlan, ref: string): number | undefined {
  const room = resolvePlanRoom(plan, ref)
  return room ? roundCm(polygonArea(room.polygon)) : undefined
}

function removalByRef(plan: LayoutPlan, ref: string): string[] {
  const byId = plan.rooms.find(room => room.id === ref)
  if (byId) return [byId.id]
  const byName = plan.rooms.filter(room => room.name === ref)
  return byName.map(room => room.id)
}

function failure(results: LocalOperationResult[], rejection: LocalOperationResult): LocalEditFailure {
  return {
    ok: false,
    results: [
      ...results.map(result => ({
        ...result,
        status: 'skipped' as const,
        reasonCode: 'transaction_aborted' as const,
      })),
      rejection,
    ],
    rejection,
  }
}
