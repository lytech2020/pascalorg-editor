import { describe, expect, test } from 'bun:test'
import type { LayoutPlan } from '../layout-plan'
import { validateModificationPostconditions } from './modification-postconditions'

const before: LayoutPlan = {
  footprint: { width: 6, depth: 4 },
  entry: { roomId: 'bed' },
  rooms: [
    { id: 'bed', name: '主卧', type: 'bedroom', polygon: [[0, 0], [3, 0], [3, 4], [0, 4]], requiresExteriorWindow: true },
    { id: 'living', name: '客厅', type: 'living', polygon: [[3, 0], [6, 0], [6, 4], [3, 4]], requiresExteriorWindow: true },
  ],
  connections: [{ from: 'bed', to: 'living', type: 'door' }],
}

describe('modification postconditions', () => {
  test('rejects an add-room plan that produced zero study rooms', () => {
    expect(validateModificationPostconditions({
      before,
      after: before,
      plan: { ops: [{ op: 'add_room', room: { name: '书房', type: 'study', targetAreaSqm: 7 } }] },
    })).toEqual([{ code: 'room_not_added', operationIndex: 0 }])
  })

  test('rejects a resize that only reaches 14.91 square metres', () => {
    const after: LayoutPlan = {
      ...before,
      rooms: before.rooms.map(room => room.id === 'bed'
        ? { ...room, polygon: [[0, 0], [3.7275, 0], [3.7275, 4], [0, 4]] }
        : room),
    }
    expect(validateModificationPostconditions({
      before,
      after,
      plan: { ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 16 }] },
    })).toEqual([{ code: 'room_area_target_not_met', operationIndex: 0 }])
  })

  // R6.2 / P2-7: an `exact` resize to 16㎡ that lands at 25㎡ must FAIL — the
  // one-sided lower-bound check used to let a gross overshoot pass.
  test('exact resize rejects a gross overshoot', () => {
    const after: LayoutPlan = {
      ...before,
      rooms: before.rooms.map(room => room.id === 'bed'
        ? { ...room, polygon: [[0, 0], [6.25, 0], [6.25, 4], [0, 4]] } // 25㎡
        : room),
    }
    expect(validateModificationPostconditions({
      before,
      after,
      plan: { ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 16, areaMode: 'exact' }] },
    })).toEqual([{ code: 'room_area_target_not_met', operationIndex: 0 }])
  })

  // The same overshoot is acceptable under `at_least` (a lower bound only).
  test('at_least resize accepts an overshoot above the floor', () => {
    const after: LayoutPlan = {
      ...before,
      rooms: before.rooms.map(room => room.id === 'bed'
        ? { ...room, polygon: [[0, 0], [6.25, 0], [6.25, 4], [0, 4]] } // 25㎡ ≥ 16㎡
        : room),
    }
    expect(validateModificationPostconditions({
      before,
      after,
      plan: { ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 16, areaMode: 'at_least' }] },
    })).toEqual([])
  })

  test('requires an added room to have the requested connection', () => {
    const study = {
      id: 'study',
      name: '书房',
      type: 'study' as const,
      polygon: [[3, 0], [4.5, 0], [4.5, 4], [3, 4]] as Array<[number, number]>,
      requiresExteriorWindow: true,
    }
    const after: LayoutPlan = {
      ...before,
      rooms: [...before.rooms, study],
      connections: before.connections,
    }
    expect(validateModificationPostconditions({
      before,
      after,
      plan: {
        ops: [{
          op: 'add_room',
          room: { name: '书房', type: 'study', targetAreaSqm: 6 },
          near: '客厅',
        }],
      },
    })).toEqual([{ code: 'room_connection_missing', operationIndex: 0 }])
  })

  test('a generic bathroom removal requires every split bathroom component to be gone', () => {
    const splitBefore: LayoutPlan = {
      ...before,
      rooms: [
        ...before.rooms,
        { id: 'wc', name: 'トイレ', type: 'bathroom', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], requiresExteriorWindow: false },
        { id: 'bath', name: '浴室', type: 'bathroom', polygon: [[1, 0], [2, 0], [2, 1], [1, 1]], requiresExteriorWindow: false },
      ],
    }
    const plan = { ops: [{ op: 'remove_room' as const, room: '卫生间' }] }
    expect(validateModificationPostconditions({
      before: splitBefore,
      after: before,
      plan,
    })).toEqual([])
    expect(validateModificationPostconditions({
      before: splitBefore,
      after: { ...before, rooms: [...before.rooms, splitBefore.rooms.at(-1)!] },
      plan,
    })).toEqual([{ code: 'room_not_removed', operationIndex: 0 }])
  })

  test('remove-room rejects deleting an unrelated room along with the intended target', () => {
    expect(validateModificationPostconditions({
      before,
      after: { ...before, rooms: [] },
      plan: { ops: [{ op: 'remove_room', room: '主卧' }] },
    })).toEqual([{ code: 'unexpected_room_removed', operationIndex: 0 }])
  })

  // R2.4 / P2-5: matching furniture results by stable operationId — not by
  // array position — keeps a skipped result and a succeeding result paired
  // with their original operations.
  test('furniture findings key by operationId so a dropped op does not mispair', () => {
    const plan = {
      ops: [
        // Dropped before execution (room 主卧 removed in the same plan): present
        // in the plan, absent from the furniture report.
        { op: 'remove_furniture' as const, room: '主卧', item: '床', operationId: 'op-0' },
        // Executed and succeeded.
        { op: 'add_furniture' as const, room: '客厅', item: '茶几', operationId: 'op-1' },
      ],
    }
    const furnitureReport = {
      results: [
        {
          op: { op: 'remove_furniture' as const, room: '主卧', item: '床', operationId: 'op-0' },
          ok: true,
          status: 'skipped' as const,
          reasonCode: 'skipped_dependency' as const,
          detail: '主卧已随房间删除，家具操作未执行',
        },
        {
          op: { op: 'add_furniture' as const, room: '客厅', item: '茶几', operationId: 'op-1' },
          ok: true,
          detail: '已在客厅放置茶几',
        },
      ],
      executionIssues: [],
      writeEffect: 'write_confirmed' as const,
    }
    // Position-based matching could pair the two results with the wrong ops.
    // Id-based matching recognizes both explicit outcomes.
    expect(validateModificationPostconditions({ before, after: before, plan, furnitureReport }))
      .toEqual([])
  })

  test('an unregistered missing furniture result is a stopping finding', () => {
    const plan = {
      ops: [
        { op: 'remove_furniture' as const, room: '主卧', item: '床', operationId: 'op-0' },
      ],
    }
    const furnitureReport = {
      results: [],
      executionIssues: [],
      writeEffect: 'no_write' as const,
    }
    expect(validateModificationPostconditions({ before, after: before, plan, furnitureReport }))
      .toEqual([{ code: 'furniture_result_missing', operationIndex: 0 }])
  })
})
