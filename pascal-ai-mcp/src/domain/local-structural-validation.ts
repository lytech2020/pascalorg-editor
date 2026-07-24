// ---------------------------------------------------------------------------
// Modify-specific plan validation (docs spec §5): "生成严格、修改增量化".
//
// The generation validator (validateLayoutPlan) is deliberately strict: every
// room must sit in its comfort band, every aspect ratio must be sane, etc.
// Applying that same bar to a LOCAL edit of an existing scene is wrong — it
// would reject a perfectly safe change just because some UNRELATED room in the
// original layout was already a little slender or a little large.
//
// This validator instead compares BEFORE vs AFTER on stable finding CODES and
// comparable NUMBERS (never localized strings):
//   • Integrity problems (overlap, out-of-footprint, holes, invalid geometry,
//     severed connections, newly-isolated rooms) are ALWAYS fatal — a modify
//     may never introduce them.
//   • Quality problems (aspect, area band, circulation share) are fatal only
//     when they are NEW, land on a room the edit touched, or measurably WORSEN
//     an existing problem. A pre-existing quality issue on an untouched room
//     that the edit did not worsen is grandfathered to a warning.
//
// It does NOT relax validateLayoutPlan; generation keeps its strict semantics.
// ---------------------------------------------------------------------------

import {
  ASPECT_RATIO_HARD,
  CIRCULATION_RATIO_HARD,
  polygonAspectRatio,
} from '../layout-metrics'
import {
  analyzePolygonGrid,
  footprintArea as footprintAreaOf,
  isAxisAligned,
  isMiniCloset,
  longestSharedEdge,
  MINI_CLOSET_MIN_OPENING_M,
  polygonArea,
  polygonIntersectionArea,
  polygonSelfIntersects,
  type LayoutPlan,
  type LayoutPlanRoom,
  type RoomType,
} from '../layout-plan'
import { DEFAULT_NORM_PROFILE, type NormProfile } from '../norms/profile'
import { TYPE_TO_KIND, areaBoundFor } from './policy/room-policy'

export const MODIFY_VALIDATION_CODES = [
  'polygon_invalid',
  'room_overlap',
  'room_outside_footprint',
  'footprint_not_covered',
  'invalid_reference',
  'shared_wall_too_short',
  'room_unreachable',
  'room_aspect',
  'room_area_out_of_band',
  'circulation_share_high',
] as const

export type ModifyValidationCode = typeof MODIFY_VALIDATION_CODES[number]

// Why a finding landed where it did — stable codes reused from the local-edit
// audit vocabulary so the whole modify pipeline speaks one language.
export type ModifyFindingReason =
  | 'integrity_violation'      // never grandfathered
  | 'affected_room'            // in the edit's necessary neighbourhood → strict
  | 'new_issue'                // absent in `before`
  | 'existing_issue_worsened'  // present in both, measurably worse
  | 'existing_issue_not_worsened' // present in both, unchanged → grandfathered

export type ModifyValidationFinding = {
  code: ModifyValidationCode
  roomId?: string
  reason: ModifyFindingReason
  beforeValue?: number
  afterValue?: number
}

export type ModifyValidationResult = {
  // Block the write.
  fatal: ModifyValidationFinding[]
  // Grandfathered pre-existing issues (recorded, do not block).
  warnings: ModifyValidationFinding[]
}

const OVERLAP_AREA_TOLERANCE_SQM = 0.02
const COVERAGE_MIN_RATIO = 0.98
const EDGE_EPSILON = 0.02
const MIN_DOOR_EDGE_M = 0.9
const ASPECT_WORSEN_TOLERANCE = 0.05
const AREA_WORSEN_TOLERANCE = 0.1
const CIRCULATION_WORSEN_TOLERANCE = 0.01

// Raw (unclassified) findings computed for a single plan — the diff engine
// below decides fatal vs grandfathered by comparing the two plans' raw sets.
type RawFinding = { code: ModifyValidationCode; roomId?: string; value?: number }

export function validateModifiedLayoutPlan(options: {
  before: LayoutPlan
  after: LayoutPlan
  affectedRoomIds: readonly string[]
  profile?: NormProfile
}): ModifyValidationResult {
  const profile = options.profile ?? DEFAULT_NORM_PROFILE
  const { before, after } = options
  const affected = new Set(options.affectedRoomIds)
  const fatal: ModifyValidationFinding[] = []
  const warnings: ModifyValidationFinding[] = []

  // --- integrity of the AFTER plan: never grandfathered -----------------------
  for (const raw of integrityFindings(after)) {
    fatal.push({ ...raw, reason: 'integrity_violation', afterValue: raw.value })
  }

  // --- reachability: a modify may not sever an existing path or strand a room -
  const reachBefore = reachableRooms(before)
  const reachAfter = reachableRooms(after)
  const beforeIds = new Set(before.rooms.map(room => room.id))
  for (const room of after.rooms) {
    if (reachAfter.has(room.id)) continue
    const isNew = !beforeIds.has(room.id)
    const wasReachable = reachBefore.has(room.id)
    if (isNew || wasReachable) {
      fatal.push({ code: 'room_unreachable', roomId: room.id, reason: isNew ? 'new_issue' : 'existing_issue_worsened' })
    } else {
      warnings.push({ code: 'room_unreachable', roomId: room.id, reason: 'existing_issue_not_worsened' })
    }
  }

  // --- connections: every door needs a usable shared wall ---------------------
  const roomById = new Map(after.rooms.map(room => [room.id, room]))
  const beforeConnKeys = new Set(before.connections.map(connKey))
  for (const conn of after.connections) {
    const a = roomById.get(conn.from)
    const b = roomById.get(conn.to)
    if (!a || !b) continue // invalid_reference already caught by integrityFindings
    const minEdge = isMiniCloset(a) || isMiniCloset(b) ? MINI_CLOSET_MIN_OPENING_M : MIN_DOOR_EDGE_M
    if (longestSharedEdge(a.polygon, b.polygon).length >= minEdge - 1e-6) continue
    const touchesEdit = affected.has(conn.from) || affected.has(conn.to)
    const isNew = !beforeConnKeys.has(connKey(conn))
    if (touchesEdit || isNew) {
      fatal.push({ code: 'shared_wall_too_short', roomId: `${conn.from}|${conn.to}`, reason: isNew ? 'new_issue' : 'affected_room' })
    } else {
      warnings.push({ code: 'shared_wall_too_short', roomId: `${conn.from}|${conn.to}`, reason: 'existing_issue_not_worsened' })
    }
  }

  // --- quality: aspect / area band / circulation — grandfather when unchanged -
  const beforeQuality = indexQuality(qualityFindings(before, profile))
  for (const raw of qualityFindings(after, profile)) {
    const key = qualityKey(raw)
    const prior = beforeQuality.get(key)
    const isAffected = raw.roomId !== undefined && affected.has(raw.roomId)
    const isGlobal = raw.roomId === undefined
    const worsenTolerance = worsenToleranceFor(raw.code)
    if (isAffected) {
      fatal.push({ code: raw.code, roomId: raw.roomId, reason: 'affected_room', afterValue: raw.value })
    } else if (prior === undefined) {
      // Global findings (circulation share) with no prior of the same code are new.
      fatal.push({ code: raw.code, roomId: raw.roomId, reason: 'new_issue', afterValue: raw.value })
    } else if ((raw.value ?? 0) > (prior.value ?? 0) + worsenTolerance) {
      fatal.push({
        code: raw.code, roomId: raw.roomId, reason: 'existing_issue_worsened',
        beforeValue: prior.value, afterValue: raw.value,
      })
    } else {
      warnings.push({
        code: raw.code, roomId: raw.roomId, reason: 'existing_issue_not_worsened',
        beforeValue: prior.value, afterValue: raw.value,
      })
    }
    void isGlobal
  }

  return { fatal, warnings }
}

// --- integrity ---------------------------------------------------------------

function integrityFindings(plan: LayoutPlan): RawFinding[] {
  const findings: RawFinding[] = []
  const ids = new Set<string>()
  for (const room of plan.rooms) {
    if (ids.has(room.id)) findings.push({ code: 'invalid_reference', roomId: room.id })
    ids.add(room.id)
    if (room.polygon.length < 4 || !isAxisAligned(room.polygon) || polygonSelfIntersects(room.polygon)) {
      findings.push({ code: 'polygon_invalid', roomId: room.id })
    }
  }
  if (!ids.has(plan.entry.roomId)) findings.push({ code: 'invalid_reference', roomId: plan.entry.roomId })
  for (const conn of plan.connections) {
    if (!ids.has(conn.from) || !ids.has(conn.to) || conn.from === conn.to) {
      findings.push({ code: 'invalid_reference', roomId: `${conn.from}|${conn.to}` })
    }
  }
  if (findings.length > 0) return findings // geometry below assumes a sane schema

  // out of footprint (bbox + polygon-aware)
  for (const room of plan.rooms) {
    const outsideBox = room.polygon.some(([x, z]) =>
      x < -EDGE_EPSILON || z < -EDGE_EPSILON
      || x > plan.footprint.width + EDGE_EPSILON || z > plan.footprint.depth + EDGE_EPSILON)
    let outside = outsideBox
    if (!outside && plan.footprint.polygon) {
      const outsideArea = polygonArea(room.polygon) - polygonIntersectionArea(room.polygon, plan.footprint.polygon)
      outside = outsideArea > OVERLAP_AREA_TOLERANCE_SQM
    }
    if (outside) findings.push({ code: 'room_outside_footprint', roomId: room.id })
  }

  const grid = analyzePolygonGrid(plan.rooms.map(room => ({ id: room.id, polygon: room.polygon })), plan.footprint)
  for (const [key, area] of grid.overlapPairs) {
    if (area < OVERLAP_AREA_TOLERANCE_SQM) continue
    findings.push({ code: 'room_overlap', roomId: key, value: area })
  }
  const footArea = footprintAreaOf(plan.footprint)
  if (grid.unionArea < footArea * COVERAGE_MIN_RATIO) {
    findings.push({ code: 'footprint_not_covered', value: footArea - grid.unionArea })
  }
  return findings
}

// --- reachability ------------------------------------------------------------

function reachableRooms(plan: LayoutPlan): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const room of plan.rooms) adjacency.set(room.id, new Set())
  for (const conn of plan.connections) {
    adjacency.get(conn.from)?.add(conn.to)
    adjacency.get(conn.to)?.add(conn.from)
  }
  const start = plan.rooms.some(room => room.id === plan.entry.roomId)
    ? plan.entry.roomId
    : plan.rooms[0]?.id
  if (start === undefined) return new Set()
  const visited = new Set([start])
  const queue = [start]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) continue
      visited.add(neighbor)
      queue.push(neighbor)
    }
  }
  return visited
}

// --- quality -----------------------------------------------------------------

function qualityFindings(plan: LayoutPlan, profile: NormProfile): RawFinding[] {
  const findings: RawFinding[] = []
  const totalRoomArea = plan.rooms.reduce((sum, room) => sum + polygonArea(room.polygon), 0)
  const bedroomCount = plan.rooms.filter(room => room.type === 'bedroom').length
  const hasStandaloneKitchen = plan.rooms.some(room => room.type === 'kitchen')
  const context = { totalAreaSqm: totalRoomArea, bedroomCount }

  for (const room of plan.rooms) {
    // aspect (storage is exempt — a shallow closet is its normal form)
    if (TYPE_TO_KIND[room.type] !== 'circulation' && room.type !== 'storage') {
      const ratio = polygonAspectRatio(room.polygon)
      if (ratio > ASPECT_RATIO_HARD) findings.push({ code: 'room_aspect', roomId: room.id, value: ratio })
    }
    // area band (fatal-level deviation from the comfort band)
    const bound = areaBoundFor(profile, context, room.type, room.name, hasStandaloneKitchen)
    if (bound) {
      const area = polygonArea(room.polygon)
      const deviation = area < bound.fatalMin ? bound.fatalMin - area
        : area > bound.fatalMax ? area - bound.fatalMax : 0
      if (deviation > 0) findings.push({ code: 'room_area_out_of_band', roomId: room.id, value: deviation })
    }
  }

  const circulationArea = plan.rooms
    .filter(room => TYPE_TO_KIND[room.type] === 'circulation')
    .reduce((sum, room) => sum + polygonArea(room.polygon), 0)
  const ratio = totalRoomArea > 0 ? circulationArea / totalRoomArea : 0
  if (ratio > CIRCULATION_RATIO_HARD) findings.push({ code: 'circulation_share_high', value: ratio })
  return findings
}

function worsenToleranceFor(code: ModifyValidationCode): number {
  if (code === 'room_aspect') return ASPECT_WORSEN_TOLERANCE
  if (code === 'circulation_share_high') return CIRCULATION_WORSEN_TOLERANCE
  return AREA_WORSEN_TOLERANCE
}

function indexQuality(findings: RawFinding[]): Map<string, RawFinding> {
  const map = new Map<string, RawFinding>()
  for (const finding of findings) map.set(qualityKey(finding), finding)
  return map
}

function qualityKey(finding: RawFinding): string {
  return `${finding.code}:${finding.roomId ?? ''}`
}

function connKey(conn: { from: string; to: string }): string {
  return conn.from < conn.to ? `${conn.from}|${conn.to}` : `${conn.to}|${conn.from}`
}

// Convenience: does the modify pass? (no fatal findings)
export function modifiedPlanIsValid(result: ModifyValidationResult): boolean {
  return result.fatal.length === 0
}

// Kept for callers that want the primary blocking reason for the reply.
export function primaryModifyRejection(result: ModifyValidationResult): ModifyValidationFinding | null {
  return result.fatal[0] ?? null
}

export type { RoomType, LayoutPlanRoom }
