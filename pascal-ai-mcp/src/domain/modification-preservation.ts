import type { LayoutIntent, LayoutPlan, LayoutPlanRoom } from '../layout-plan'
import { polygonArea } from '../layout-plan'
import { classifyRoomTypeByName } from '../lang/room-vocab'
import type {
  ModificationPreservationPolicy,
  ModifyPlan,
} from '../modify-ops'

export const PRESERVATION_FAILURE_CODES = [
  'strict_local_no_safe_plan',
  'footprint_changed',
  'unrelated_room_changed',
  'executed_plan_mismatch',
] as const

export type PreservationFailureCode = typeof PRESERVATION_FAILURE_CODES[number]

export type PreservationFinding = {
  code: PreservationFailureCode
  roomId?: string
}

const STRICT_LOCAL_PATTERN =
  /(?:只|仅|單獨|单独).*(?:改|删|删除|移除|扩大|缩小|新增)|(?:其他|其余|別的|别的).*(?:不要动|不动|保持不变|不能变)|\bonly\b|\bwithout\s+chang(?:e|ing)\b|\bkeep\b.*\bunchanged\b|だけ|以外.*(?:変えない|変更しない)/iu

const BEST_EFFORT_PRESERVATION_PATTERN =
  /尽量|儘量|尽可能|儘可能|できるだけ|可能な限り|なるべく|as much as possible|where possible|if possible|preferably/iu

const ABSOLUTE_PRESERVATION_PATTERN =
  /(?:只|仅|僅|單獨|单独).*(?:改|删|刪|删除|移除|扩大|缩小|新增)|(?:其他|其余|別的|别的).*(?:不要动|不動|不能变|不許|不许|不得|必须.*保持不变|都.*保持不变|一律.*保持不变|完全.*保持不变)|\bonly\b|\bwithout\s+chang(?:e|ing)\b|\bmust\s+remain\b|だけ|以外.*(?:変えない|変更しない)/iu

export function preservationPolicyFor(
  request: string,
  plan: ModifyPlan,
): ModificationPreservationPolicy {
  const allowedRoomRefs = plan.ops.flatMap(operationRoomRefs)
  const hasBestEffort = BEST_EFFORT_PRESERVATION_PATTERN.test(request)
  const strictLocal = ABSOLUTE_PRESERVATION_PATTERN.test(request)
    || (STRICT_LOCAL_PATTERN.test(request) && !hasBestEffort)
  const mode = strictLocal
    ? 'strict_local'
    : hasBestEffort ? 'best_effort' : 'allow_rebuild'
  return {
    mode,
    allowedRoomRefs: [...new Set(allowedRoomRefs)].sort(),
    preserveFootprint: mode === 'strict_local',
  }
}

export function withPreservationPolicy(request: string, plan: ModifyPlan): ModifyPlan {
  return plan.preservation
    ? structuredClone(plan)
    : { ...structuredClone(plan), preservation: preservationPolicyFor(request, plan) }
}

export function normalizeSemanticRemovalPlan(request: string, plan: ModifyPlan): ModifyPlan {
  const normalized = request.normalize('NFKC')
  const removesGenericBathroom =
    /(?:(?:删|删除|移除|去掉|取消|remove).*(?:卫生间|衛生間|洗手间|洗手間|卫浴|衛浴|bath\s*room|bathroom|水回り)|(?:卫生间|衛生間|洗手间|洗手間|卫浴|衛浴|bath\s*room|bathroom|水回り).*(?:删|删除|移除|去掉|取消|remove))/iu
      .test(normalized)
  if (!removesGenericBathroom) return structuredClone(plan)
  return {
    ...structuredClone(plan),
    ops: plan.ops.map(operation =>
      operation.op === 'remove_room'
      && classifyRoomTypeByName(operation.room) === 'bathroom'
        ? { ...operation, room: '卫生间' }
        : operation),
  }
}

export function validatePreservedPlan(
  before: LayoutPlan,
  after: LayoutPlan,
  plan: ModifyPlan,
): PreservationFinding[] {
  const policy = plan.preservation
  if (!policy || policy.mode === 'allow_rebuild') return []
  const findings: PreservationFinding[] = []
  if (policy.preserveFootprint && stableFootprint(before) !== stableFootprint(after)) {
    findings.push({ code: 'footprint_changed' })
  }

  const targetIds = targetRoomIds(before, plan)
  const removedIds = new Set(plan.ops.flatMap(op => op.op === 'remove_room'
    ? roomIdsForRef(before, op.room)
    : []))
  const addedIds = new Set(after.rooms
    .filter(room => !before.rooms.some(previous => previous.id === room.id))
    .map(room => room.id))
  const changedExisting = before.rooms.filter(previous => {
    const current = after.rooms.find(room => room.id === previous.id)
    return current && (
      policy.mode === 'best_effort'
        ? !polygonsEquivalentWithin(previous.polygon, current.polygon, 0.05)
        : stablePolygon(previous.polygon) !== stablePolygon(current.polygon)
    )
  })

  const structural = plan.ops.filter(op =>
    op.op === 'add_room' || op.op === 'remove_room' || op.op === 'resize_room')
  const mayChangeOneAbsorber = structural.length === 1
    && (
      structural[0]?.op === 'add_room'
      || structural[0]?.op === 'remove_room'
      || structural[0]?.op === 'resize_room'
    )
  const unrelatedChanges = changedExisting.filter(room =>
    !targetIds.has(room.id) && !removedIds.has(room.id))
  const allowedAbsorber = mayChangeOneAbsorber && unrelatedChanges.length === 1
    && absorberChangeIsLocal(before, after, structural[0]!, unrelatedChanges[0]!)
  if (unrelatedChanges.length > 0 && !allowedAbsorber) {
    for (const room of unrelatedChanges) {
      findings.push({ code: 'unrelated_room_changed', roomId: room.id })
    }
  }
  if (addedIds.size > plan.ops.filter(op => op.op === 'add_room').length) {
    for (const roomId of addedIds) findings.push({ code: 'unrelated_room_changed', roomId })
  }
  return findings
}

function absorberChangeIsLocal(
  before: LayoutPlan,
  after: LayoutPlan,
  operation: ModifyPlan['ops'][number],
  changedRoom: LayoutPlanRoom,
): boolean {
  const current = after.rooms.find(room => room.id === changedRoom.id)
  if (!current) return false
  if (operation.op === 'remove_room') {
    const removed = roomIdsForRef(before, operation.room)
      .map(id => before.rooms.find(room => room.id === id))
      .filter((room): room is LayoutPlanRoom => room !== undefined)
    if (removed.length === 0) return false
    const localGroup = connectedRemovalGroup(changedRoom, removed)
    const areaDelta = polygonArea(current.polygon) - polygonArea(changedRoom.polygon)
    const removedArea = removed.reduce((sum, room) => sum + polygonArea(room.polygon), 0)
    return localGroup && Math.abs(areaDelta - removedArea) <= 0.1
  }
  if (operation.op === 'add_room') {
    const added = after.rooms.find(room => room.name === operation.room.name)
    if (!added) return false
    const touches = polygonsShareEdge(added.polygon, current.polygon)
    const areaDelta = polygonArea(changedRoom.polygon) - polygonArea(current.polygon)
    return touches && Math.abs(areaDelta - polygonArea(added.polygon)) <= 0.1
  }
  if (operation.op === 'resize_room') {
    const targetBefore = before.rooms.find(room =>
      room.id === operation.room || room.name === operation.room)
    const targetAfter = targetBefore
      ? after.rooms.find(room => room.id === targetBefore.id)
      : undefined
    if (!targetBefore || !targetAfter) return false
    const targetDelta = polygonArea(targetAfter.polygon) - polygonArea(targetBefore.polygon)
    const absorberDelta = polygonArea(current.polygon) - polygonArea(changedRoom.polygon)
    const remainedAdjacent = polygonsShareEdge(targetBefore.polygon, changedRoom.polygon)
      && polygonsShareEdge(targetAfter.polygon, current.polygon)
    return remainedAdjacent
      && targetDelta * absorberDelta < 0
      && Math.abs(targetDelta + absorberDelta) <= 0.1
  }
  return false
}

function polygonsShareEdge(
  left: Array<[number, number]>,
  right: Array<[number, number]>,
): boolean {
  const edges = (polygon: Array<[number, number]>) => polygon.map((point, index) => ({
    a: point,
    b: polygon[(index + 1) % polygon.length]!,
  }))
  return edges(left).some(first => edges(right).some(second => {
    const vertical = first.a[0] === first.b[0]
      && second.a[0] === second.b[0]
      && Math.abs(first.a[0] - second.a[0]) < 0.01
      && Math.min(Math.max(first.a[1], first.b[1]), Math.max(second.a[1], second.b[1]))
        - Math.max(Math.min(first.a[1], first.b[1]), Math.min(second.a[1], second.b[1])) >= 0.9
    const horizontal = first.a[1] === first.b[1]
      && second.a[1] === second.b[1]
      && Math.abs(first.a[1] - second.a[1]) < 0.01
      && Math.min(Math.max(first.a[0], first.b[0]), Math.max(second.a[0], second.b[0]))
        - Math.max(Math.min(first.a[0], first.b[0]), Math.min(second.a[0], second.b[0])) >= 0.9
    return vertical || horizontal
  }))
}

export function validateExecutedPlan(
  expected: LayoutPlan,
  actualRooms: Array<{ name: string; polygon: Array<[number, number]> }>,
): PreservationFinding[] {
  const findings: PreservationFinding[] = []
  const matchedActualIndexes = new Set<number>()
  for (const room of expected.rooms) {
    const actualIndex = actualRooms.findIndex((candidate, index) =>
      !matchedActualIndexes.has(index)
      && candidate.name === room.name
      && stablePolygon(candidate.polygon) === stablePolygon(room.polygon))
    if (actualIndex < 0) {
      findings.push({ code: 'executed_plan_mismatch', roomId: room.id })
    } else {
      matchedActualIndexes.add(actualIndex)
    }
  }
  if (matchedActualIndexes.size !== actualRooms.length) {
    findings.push({ code: 'executed_plan_mismatch' })
  }
  return findings
}

function operationRoomRefs(op: ModifyPlan['ops'][number]): string[] {
  if (op.op === 'add_room') return [op.room.name, ...(op.near ? [op.near] : [])]
  if (op.op === 'swap_furniture') return [op.room]
  return [op.room]
}

function targetRoomIds(plan: LayoutPlan, modifyPlan: ModifyPlan): Set<string> {
  const ids = new Set<string>()
  for (const op of modifyPlan.ops) {
    if (op.op === 'add_room') continue
    for (const id of roomIdsForRef(plan, op.room)) ids.add(id)
  }
  return ids
}

export function removalRoomIdsForRef(plan: LayoutPlan, ref: string): string[] {
  return removalIdsForRooms(plan.rooms, ref)
}

export function removalIntentRoomIdsForRef(intent: LayoutIntent, ref: string): string[] {
  return removalIdsForRooms(intent.rooms, ref)
}

function removalIdsForRooms(
  rooms: ReadonlyArray<{ id: string; name: string; type: LayoutPlanRoom['type'] }>,
  ref: string,
): string[] {
  const exactId = rooms.find(room => room.id === ref)
  if (exactId) return [exactId.id]
  const type = classifyRoomTypeByName(ref)
  const exactNames = rooms.filter(room => room.name === ref)
  if (type !== 'bathroom' || !isGenericBathroomRef(ref)) {
    if (exactNames.length > 0) return exactNames.map(room => room.id)
  }
  if (type === 'other') return []
  const candidates = rooms.filter(room => room.type === type)
  if (candidates.length === 1) return [candidates[0]!.id]
  if (type !== 'bathroom') return []
  const components = candidates.map(room => bathroomComponent(room.name))
  if (components.some(component => component === null)) return []
  if (new Set(components).size !== components.length) return []
  return candidates.map(room => room.id)
}

function isGenericBathroomRef(ref: string): boolean {
  return /^(?:卫生间|衛生間|洗手间|洗手間|卫浴|衛浴|bath\s*room|bathroom|水回り)$/iu
    .test(ref.normalize('NFKC').trim())
}

function roomIdsForRef(plan: LayoutPlan, ref: string): string[] {
  return removalRoomIdsForRef(plan, ref)
}

function bathroomComponent(name: string): 'toilet' | 'bath' | 'wash' | null {
  const normalized = name.normalize('NFKC')
  if (/トイレ|便所|\bwc\b/i.test(normalized)) return 'toilet'
  if (/風呂|浴室|バスルーム/i.test(normalized)) return 'bath'
  if (/洗面|脱衣/i.test(normalized)) return 'wash'
  return null
}

function connectedRemovalGroup(
  absorber: LayoutPlanRoom,
  removed: LayoutPlanRoom[],
): boolean {
  const reachable = new Set<string>()
  let frontier: LayoutPlanRoom[] = [absorber]
  while (frontier.length > 0) {
    const next: LayoutPlanRoom[] = []
    for (const source of frontier) {
      for (const candidate of removed) {
        if (reachable.has(candidate.id)) continue
        if (!polygonsShareEdge(source.polygon, candidate.polygon)) continue
        reachable.add(candidate.id)
        next.push(candidate)
      }
    }
    frontier = next
  }
  return reachable.size === removed.length
}

function stablePolygon(polygon: Array<[number, number]> | undefined): string {
  if (!polygon) return ''
  return JSON.stringify(polygon.map(([x, z]) => [
    Math.round(x * 100) / 100,
    Math.round(z * 100) / 100,
  ]))
}

function polygonsEquivalentWithin(
  left: Array<[number, number]>,
  right: Array<[number, number]>,
  tolerance: number,
): boolean {
  if (left.length !== right.length) return false
  return left.every(([x, z], index) => {
    const candidate = right[index]
    return candidate !== undefined
      && Math.abs(x - candidate[0]) <= tolerance
      && Math.abs(z - candidate[1]) <= tolerance
  })
}

function stableFootprint(plan: LayoutPlan): string {
  return JSON.stringify({
    width: Math.round(plan.footprint.width * 100) / 100,
    depth: Math.round(plan.footprint.depth * 100) / 100,
    polygon: stablePolygon(plan.footprint.polygon),
  })
}

export function roomArea(room: LayoutPlanRoom): number {
  return polygonArea(room.polygon)
}
