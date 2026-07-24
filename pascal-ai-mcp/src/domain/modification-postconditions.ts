import type { LayoutPlan } from '../layout-plan'
import { polygonArea } from '../layout-plan'
import type { FurnitureModifyReport } from '../furniture-modify'
import type { ModifyPlan } from '../modify-ops'
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
] as const

export type ModificationPostconditionCode = typeof MODIFICATION_POSTCONDITION_CODES[number]

export type ModificationPostconditionFinding = {
  code: ModificationPostconditionCode
  operationIndex: number
}

export function validateModificationPostconditions(options: {
  before?: LayoutPlan
  after?: LayoutPlan
  plan: ModifyPlan
  furnitureReport?: FurnitureModifyReport | null
}): ModificationPostconditionFinding[] {
  const { before, after, plan, furnitureReport } = options
  const findings: ModificationPostconditionFinding[] = []
  let furnitureIndex = 0
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
            || polygonArea(room.polygon) >= op.room.targetAreaSqm - 0.05))
        : undefined
      const added = addedRoom !== undefined
      if (!added) findings.push({ code: 'room_not_added', operationIndex })
      else {
        const nearRoom = op.near
          ? after.rooms.find(room => room.id === op.near || room.name === op.near)
          : undefined
        const connected = after.connections.some(connection => {
          const other = connection.from === addedRoom.id
            ? connection.to
            : connection.to === addedRoom.id ? connection.from : undefined
          return other !== undefined && (!op.near || other === nearRoom?.id)
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
      const target = before.rooms.find(room => room.id === op.room || room.name === op.room)
      const current = target && after.rooms.find(room => room.id === target.id)
      if (!current || polygonArea(current.polygon) < op.targetAreaSqm - 0.05) {
        findings.push({ code: 'room_area_target_not_met', operationIndex })
      }
    } else if (op.op === 'rename_room') {
      if (!before || !after) {
        findings.push({ code: 'room_not_renamed', operationIndex })
        continue
      }
      const target = before.rooms.find(room => room.id === op.room || room.name === op.room)
      const current = target && after.rooms.find(room => room.id === target.id)
      if (!current || current.name !== op.name) {
        findings.push({ code: 'room_not_renamed', operationIndex })
      } else if (stablePolygon(current.polygon) !== stablePolygon(target.polygon)) {
        findings.push({ code: 'rename_changed_geometry', operationIndex })
      }
    } else {
      const result = furnitureReport?.results[furnitureIndex++]
      if (!result?.ok) findings.push({ code: 'furniture_target_not_met', operationIndex })
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
