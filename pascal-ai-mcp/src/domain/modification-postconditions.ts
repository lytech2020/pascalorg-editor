import type { LayoutPlan } from '../layout-plan'
import { polygonArea } from '../layout-plan'
import type { FurnitureModifyReport } from '../furniture-modify'
import { resolveRoomRef, type ModifyPlan } from '../modify-ops'
import { removalRoomIdsForRef } from './modification-preservation'

export const MODIFICATION_POSTCONDITION_CODES = [
  'room_not_added',
  'room_connection_missing',
  'room_not_removed',
  'unexpected_room_removed',
  'room_area_target_not_met',
  'room_not_renamed',
  'rename_changed_geometry',
  'furniture_target_not_met',
  'furniture_result_missing',
] as const

export type ModificationPostconditionCode = typeof MODIFICATION_POSTCONDITION_CODES[number]

// Furniture postcondition codes describe a furniture op that did not achieve
// its goal. They are surfaced to the user as per-op failed details (and audited
// via runValidationStage) — but they are NOT scene-integrity failures, so they
// must never throw the destructive ModificationVerificationError the way a
// structural finding (room not added/removed/renamed) does. A furniture op that
// failed with zero writes is a safe, recoverable outcome. (R1.4 / P1-2)
export const FURNITURE_POSTCONDITION_CODES = new Set<ModificationPostconditionCode>([
  'furniture_target_not_met',
])

export function isStructuralPostconditionCode(code: ModificationPostconditionCode): boolean {
  return !FURNITURE_POSTCONDITION_CODES.has(code)
}

export type ModificationPostconditionFinding = {
  code: ModificationPostconditionCode
  operationIndex: number
}

// R6.2: does a built area satisfy the target under its mode? `at_least` is a
// one-sided lower bound (target − 0.05). `exact` is two-sided — the same lower
// bound PLUS a tight upper bound, so "调整到 16㎡" that lands at 25㎡ (or even
// 19.2㎡) fails instead of silently passing (P2-7). The upper tolerance is
// max(0.5, 10%): enough to absorb the partitioner's grid/corridor overhead, not
// enough to call a materially larger room "exact".
export function areaSatisfiesTarget(actual: number, target: number, mode: 'exact' | 'at_least'): boolean {
  if (actual < target - 0.05) return false
  if (mode === 'at_least') return true
  return actual <= target + Math.max(0.5, target * 0.1)
}

export function validateModificationPostconditions(options: {
  before?: LayoutPlan
  after?: LayoutPlan
  plan: ModifyPlan
  furnitureReport?: FurnitureModifyReport | null
}): ModificationPostconditionFinding[] {
  const { before, after, plan, furnitureReport } = options
  const findings: ModificationPostconditionFinding[] = []
  const finalRenameIndexByRoomId = new Map<string, number>()
  if (before) {
    for (const [operationIndex, op] of plan.ops.entries()) {
      if (op.op !== 'rename_room') continue
      const resolved = resolveRoomRef(op.room, before.rooms)
      if ('room' in resolved) finalRenameIndexByRoomId.set(resolved.room.id, operationIndex)
    }
  }
  // R2.4 / P2-5: furniture results are matched to their op by stable
  // operationId, never by array position. Deliberately skipped operations also
  // have explicit results; a missing result is therefore an execution/accounting
  // failure rather than an implicit skip.
  let furnitureFallbackIndex = 0
  for (const [operationIndex, op] of plan.ops.entries()) {
    if (op.op === 'add_room') {
      if (!before || !after) {
        findings.push({ code: 'room_not_added', operationIndex })
        continue
      }
      const beforeCount = before.rooms.filter(room => room.type === op.room.type).length
      const candidates = after.rooms.filter(room => room.type === op.room.type)
      const addedRoom = candidates.length > beforeCount
        ? candidates.find(room => room.name === op.room.name
          && (op.room.targetAreaSqm === undefined
            || areaSatisfiesTarget(polygonArea(room.polygon), op.room.targetAreaSqm, op.areaMode ?? 'at_least')))
        : undefined
      const added = addedRoom !== undefined
      if (!added) findings.push({ code: 'room_not_added', operationIndex })
      else {
        const beforeNear = op.near
          ? resolveRoomRef(op.near, before.rooms)
          : undefined
        const afterNear = op.near && (!beforeNear || !('room' in beforeNear))
          ? resolveRoomRef(op.near, after.rooms)
          : undefined
        const nearRoomId = beforeNear && 'room' in beforeNear
          ? beforeNear.room.id
          : afterNear && 'room' in afterNear ? afterNear.room.id : undefined
        const connected = after.connections.some(connection => {
          const other = connection.from === addedRoom.id
            ? connection.to
            : connection.to === addedRoom.id ? connection.from : undefined
          return other !== undefined && (!op.near || other === nearRoomId)
        })
        if (!connected) findings.push({ code: 'room_connection_missing', operationIndex })
      }
    } else if (op.op === 'remove_room') {
      if (!before || !after) {
        findings.push({ code: 'room_not_removed', operationIndex })
        continue
      }
      const targetIds = new Set(removalRoomIdsForRef(before, op.room))
      const targets = before.rooms.filter(room => targetIds.has(room.id))
      if (
        targets.length === 0
        || targets.some(target => after.rooms.some(room => room.id === target.id || room.name === target.name))
      ) {
        findings.push({ code: 'room_not_removed', operationIndex })
      }
      const unexpectedRemoved = before.rooms.some(room =>
        !targetIds.has(room.id) && !after.rooms.some(candidate => candidate.id === room.id))
      if (unexpectedRemoved) {
        findings.push({ code: 'unexpected_room_removed', operationIndex })
      }
    } else if (op.op === 'resize_room') {
      if (!before || !after) {
        findings.push({ code: 'room_area_target_not_met', operationIndex })
        continue
      }
      const resolved = resolveRoomRef(op.room, before.rooms)
      const target = 'room' in resolved ? resolved.room : undefined
      const current = target && after.rooms.find(room => room.id === target.id)
      // resize defaults to `exact` — "调整到 N㎡" is the common phrasing, and it
      // must be judged two-sided (R6.2 / P2-7).
      if (!current || !areaSatisfiesTarget(polygonArea(current.polygon), op.targetAreaSqm, op.areaMode ?? 'exact')) {
        findings.push({ code: 'room_area_target_not_met', operationIndex })
      }
    } else if (op.op === 'rename_room') {
      if (!before || !after) {
        findings.push({ code: 'room_not_renamed', operationIndex })
        continue
      }
      const resolved = resolveRoomRef(op.room, before.rooms)
      const target = 'room' in resolved ? resolved.room : undefined
      if (target && finalRenameIndexByRoomId.get(target.id) !== operationIndex) continue
      const current = target && after.rooms.find(room => room.id === target.id)
      if (!current || current.name !== op.name) {
        findings.push({ code: 'room_not_renamed', operationIndex })
      } else if (stablePolygon(current.polygon) !== stablePolygon(target.polygon)) {
        findings.push({ code: 'rename_changed_geometry', operationIndex })
      }
    } else {
      const result = op.operationId !== undefined
        ? furnitureReport?.results.find(entry => entry.op.operationId === op.operationId)
        : furnitureReport?.results[furnitureFallbackIndex++]
      if (!result) {
        findings.push({ code: 'furniture_result_missing', operationIndex })
      } else if (!result.ok) {
        findings.push({ code: 'furniture_target_not_met', operationIndex })
      }
    }
  }
  return findings
}

function stablePolygon(polygon: Array<[number, number]>): string {
  return JSON.stringify(polygon.map(([x, z]) => [
    Math.round(x * 100) / 100,
    Math.round(z * 100) / 100,
  ]))
}
