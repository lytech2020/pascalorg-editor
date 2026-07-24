import { describe, expect, test } from 'bun:test'
import type { LayoutIntent } from './layout-plan'
import { applyModifyOps, parseModifyOps, resolveRoomRef } from './modify-ops'
import { DEFAULT_NORM_PROFILE } from './norms/profile'

const 两居: LayoutIntent = {
  targetTotalAreaSqm: 75,
  rooms: [
    { id: 'living-1', name: '客厅', type: 'living', targetAreaSqm: 24 },
    { id: 'bedroom-1', name: '主卧', type: 'bedroom', targetAreaSqm: 15 },
    { id: 'bedroom-2', name: '次卧', type: 'bedroom', targetAreaSqm: 11 },
    { id: 'kitchen-1', name: '厨房', type: 'kitchen', targetAreaSqm: 7 },
    { id: 'bath-1', name: '卫生间', type: 'bathroom', targetAreaSqm: 4 },
  ],
  adjacency: [{ a: 'kitchen-1', b: 'living-1' }],
}

describe('parseModifyOps', () => {
  test('parses a mixed op list and tolerates fences', () => {
    const raw = '```json\n' + JSON.stringify({
      ops: [
        { op: 'add_room', room: { name: '书房', type: 'study', targetAreaSqm: 7 }, near: '客厅' },
        { op: 'remove_furniture', room: '主卧', item: '衣柜' },
      ],
      note: '按要求加书房',
    }) + '\n```'
    const { plan, errors } = parseModifyOps(raw)
    expect(errors).toEqual([])
    expect(plan?.ops).toHaveLength(2)
    expect(plan?.note).toBe('按要求加书房')
  })

  test('reports per-op shape defects and keeps the valid ops', () => {
    const { plan, errors } = parseModifyOps(JSON.stringify({
      ops: [
        { op: 'resize_room', room: '主卧' }, // missing targetAreaSqm
        { op: 'rename_room', room: '次卧', name: '儿童房' },
        { op: 'teleport_room', room: '客厅' }, // unknown op
      ],
    }))
    // A stable operationId is assigned to every kept op (R2.4).
    expect(plan?.ops).toEqual([{ op: 'rename_room', room: '次卧', name: '儿童房', operationId: 'op-0' }])
    expect(errors).toHaveLength(2)
  })

  test('parses clear_room_furniture and areaMode (R4 / R6)', () => {
    const { plan, errors } = parseModifyOps(JSON.stringify({
      ops: [
        { op: 'clear_room_furniture', room: '洋室1' },
        { op: 'resize_room', room: '主卧', targetAreaSqm: 16, areaMode: 'exact' },
        { op: 'add_room', room: { name: '书房', type: 'study', targetAreaSqm: 7 }, areaMode: 'at_least' },
      ],
    }))
    expect(errors).toEqual([])
    expect(plan?.ops[0]).toMatchObject({ op: 'clear_room_furniture', room: '洋室1' })
    expect(plan?.ops[1]).toMatchObject({ op: 'resize_room', targetAreaSqm: 16, areaMode: 'exact' })
    expect(plan?.ops[2]).toMatchObject({ op: 'add_room', areaMode: 'at_least' })
  })

  test('clear_room_furniture without a room is a shape defect', () => {
    const { plan, errors } = parseModifyOps(JSON.stringify({ ops: [{ op: 'clear_room_furniture' }] }))
    expect(plan).toBeNull()
    expect(errors).toHaveLength(1)
  })

  test('no JSON / empty ops → null plan', () => {
    expect(parseModifyOps('好的，我来改').plan).toBeNull()
    expect(parseModifyOps('{"ops": []}').plan).toBeNull()
  })
})

describe('resolveRoomRef', () => {
  test('id exact → name exact → unique type', () => {
    expect(resolveRoomRef('bedroom-2', 两居.rooms)).toEqual({ room: 两居.rooms[2]! })
    expect(resolveRoomRef('主卧', 两居.rooms)).toEqual({ room: 两居.rooms[1]! })
    // 「厨房」 is also the room's name; use 卫生间 via vocab (name matches too) —
    // use English to force the vocab path.
    expect(resolveRoomRef('bathroom', 两居.rooms)).toEqual({ room: 两居.rooms[4]! })
  })

  test('ambiguous type reference is an error, not a guess', () => {
    const result = resolveRoomRef('卧室', 两居.rooms)
    expect('error' in result && result.error).toContain('多个')
  })

  test('unknown reference is an error', () => {
    const result = resolveRoomRef('地下室', 两居.rooms)
    expect('error' in result && result.error).toContain('找不到')
  })
})

describe('applyModifyOps', () => {
  const profile = DEFAULT_NORM_PROFILE

  test('add_room appends with unique id and adjacency, carving from the existing footprint (§6.1)', () => {
    const { intent, structural, notes, errors } = applyModifyOps(两居, {
      ops: [{ op: 'add_room', room: { name: '书房', type: 'study', targetAreaSqm: 7 }, near: '客厅' }],
    }, profile)
    expect(errors).toEqual([])
    expect(structural).toBe(true)
    const study = intent.rooms.find(room => room.type === 'study')
    expect(study?.id).toBe('study-1')
    // §6.1: total floor area is unchanged — the new room is carved, not appended.
    expect(intent.targetTotalAreaSqm).toBe(75)
    expect(intent.adjacency).toContainEqual({ a: 'study-1', b: 'living-1' })
    expect(notes.join()).toContain('书房')
    // Source intent untouched.
    expect(两居.rooms).toHaveLength(5)
    expect(两居.targetTotalAreaSqm).toBe(75)
  })

  test('resolves 客厅 to a combined LDK host for add_room', () => {
    const source: LayoutIntent = {
      targetTotalAreaSqm: 50,
      rooms: [
        { id: 'ldk-1', name: 'LDK', type: 'living_kitchen', targetAreaSqm: 35 },
        { id: 'bedroom-1', name: '卧室', type: 'bedroom', targetAreaSqm: 15 },
      ],
    }
    const applied = applyModifyOps(source, {
      ops: [{ op: 'add_room', room: { name: '储物间', type: 'storage', targetAreaSqm: 2 }, near: '客厅' }],
    }, profile)
    expect(applied.errors).toEqual([])
    expect(applied.intent.adjacency).toContainEqual({ a: 'storage-1', b: 'ldk-1' })
  })

  test('rejects add_room when an explicit host cannot be resolved', () => {
    const applied = applyModifyOps(两居, {
      ops: [{
        op: 'add_room',
        room: { name: '衣帽间', type: 'storage', targetAreaSqm: 3 },
        near: '不存在的主卧',
      }],
    }, profile)
    expect(applied.errors).toHaveLength(1)
    expect(applied.errors[0]).toContain('不存在的主卧')
    expect(applied.intent.rooms.some(room => room.name === '衣帽间')).toBe(false)
  })

  test('binds structural room references before applying rename and resize operations', () => {
    const rename = { op: 'rename_room', room: '主卧', name: '卧室' } as const
    const resize = { op: 'resize_room', room: '主卧', targetAreaSqm: 10 } as const
    const renameFirst = applyModifyOps(两居, { ops: [rename, resize] }, profile)
    const resizeFirst = applyModifyOps(两居, { ops: [resize, rename] }, profile)
    expect(renameFirst.errors).toEqual([])
    expect(resizeFirst.errors).toEqual([])
    expect(renameFirst.intent.rooms).toEqual(resizeFirst.intent.rooms)
    expect(renameFirst.intent.rooms.find(room => room.id === 'bedroom-1')).toMatchObject({
      name: '卧室',
      targetAreaSqm: 10,
    })
  })

  test('remove_room drops the room, its adjacency, and shrinks the total (§8-2)', () => {
    const { intent, structural, errors } = applyModifyOps(两居, {
      ops: [{ op: 'remove_room', room: '厨房' }],
    }, profile)
    expect(errors).toEqual([])
    expect(structural).toBe(true)
    expect(intent.rooms.some(room => room.type === 'kitchen')).toBe(false)
    expect(intent.targetTotalAreaSqm).toBe(68)
    expect(intent.adjacency).toBeUndefined()
  })

  test('resize_room within band resizes and adjusts total', () => {
    const { intent, errors, structural } = applyModifyOps(两居, {
      ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 18 }],
    }, profile)
    expect(errors).toEqual([])
    expect(structural).toBe(true)
    expect(intent.rooms.find(room => room.id === 'bedroom-1')?.targetAreaSqm).toBe(18)
    expect(intent.targetTotalAreaSqm).toBe(78)
  })

  test('resize beyond the fatal band is rejected with the band quoted (case-13 class)', () => {
    const { errors, intent } = applyModifyOps(两居, {
      ops: [{ op: 'resize_room', room: '卫生间', targetAreaSqm: 30 }],
    }, profile)
    expect(errors.join()).toContain('超出该房型允许范围')
    // Rejected op leaves the intent unchanged.
    expect(intent.rooms.find(room => room.id === 'bath-1')?.targetAreaSqm).toBe(4)
  })

  test('rename_room is non-structural', () => {
    const { intent, structural, errors } = applyModifyOps(两居, {
      ops: [{ op: 'rename_room', room: '次卧', name: '儿童房' }],
    }, profile)
    expect(errors).toEqual([])
    expect(structural).toBe(false)
    expect(intent.rooms.find(room => room.id === 'bedroom-2')?.name).toBe('儿童房')
  })

  test('furniture ops pass through without touching the intent', () => {
    const { intent, structural, furnitureOps, errors } = applyModifyOps(两居, {
      ops: [
        { op: 'add_furniture', room: '主卧', item: '书桌' },
        { op: 'swap_furniture', room: '客厅', from: '沙发', to: '双人沙发' },
      ],
    }, profile)
    expect(errors).toEqual([])
    expect(structural).toBe(false)
    expect(furnitureOps).toHaveLength(2)
    expect(intent).toEqual({ targetTotalAreaSqm: 75, rooms: 两居.rooms, adjacency: 两居.adjacency })
  })

  test('furniture op with an unresolvable room is an error', () => {
    const { errors, furnitureOps } = applyModifyOps(两居, {
      ops: [{ op: 'add_furniture', room: '地下室', item: '书桌' }],
    }, profile)
    expect(errors.join()).toContain('找不到')
    expect(furnitureOps).toEqual([])
  })

  test('cannot remove the last room', () => {
    const single: LayoutIntent = {
      targetTotalAreaSqm: 20,
      rooms: [{ id: 'room-1', name: '单间', type: 'other' }],
    }
    const { errors } = applyModifyOps(single, {
      ops: [{ op: 'remove_room', room: '单间' }],
    }, profile)
    expect(errors.join()).toContain('最后一个房间')
  })

  test('multi-op request applies in order (remove + resize)', () => {
    const { intent, errors } = applyModifyOps(两居, {
      ops: [
        { op: 'remove_room', room: '次卧' },
        { op: 'resize_room', room: '主卧', targetAreaSqm: 18 },
      ],
    }, profile)
    expect(errors).toEqual([])
    expect(intent.rooms).toHaveLength(4)
    // 75 − 11 + (18 − 15)
    expect(intent.targetTotalAreaSqm).toBe(67)
  })
})

describe('applyModifyOps mixed-op order independence (M2)', () => {
  const profile = DEFAULT_NORM_PROFILE

  test('remove_room + furniture op on the removed room: same outcome either order', () => {
    const opsA = [
      { op: 'remove_furniture', room: '卫生间', item: '洗衣机' },
      { op: 'remove_room', room: '卫生间' },
    ] as const
    const opsB = [...opsA].reverse()
    for (const ops of [opsA, opsB]) {
      const applied = applyModifyOps(两居, { ops: [...ops] }, profile)
      expect(applied.errors).toEqual([])
      expect(applied.furnitureOps).toEqual([])
      expect(applied.intent.rooms.some(room => room.id === 'bath-1')).toBe(false)
      expect(applied.notes.some(note => note.includes('已随房间删除'))).toBe(false)
      // P2-D / R5.1: the dropped furniture op keeps an explicit skipped status,
      // not just a note — so every sub-operation has a recorded outcome.
      expect(applied.skippedFurnitureOps).toEqual([
        {
          op: { op: 'remove_furniture', room: '卫生间', item: '洗衣机' },
          roomName: '卫生间',
          status: 'skipped',
          reasonCode: 'room_removed',
        },
      ])
    }
  })

  test('furniture op referencing a room added later in the same plan resolves', () => {
    const applied = applyModifyOps(两居, {
      ops: [
        { op: 'add_furniture', room: '书房', item: '书桌' },
        { op: 'add_room', room: { name: '书房', type: 'study', targetAreaSqm: 8 } },
      ],
    }, profile)
    expect(applied.errors).toEqual([])
    expect(applied.furnitureOps).toEqual([{ op: 'add_furniture', room: '书房', item: '书桌' }])
  })

  test('furniture op referencing the pre-rename name follows the rename', () => {
    const applied = applyModifyOps(两居, {
      ops: [
        { op: 'rename_room', room: '次卧', name: '儿童房' },
        { op: 'add_furniture', room: '次卧', item: '衣柜' },
      ],
    }, profile)
    expect(applied.errors).toEqual([])
    expect(applied.furnitureOps).toEqual([{ op: 'add_furniture', room: '儿童房', item: '衣柜' }])
  })

  test('furniture op on a genuinely unknown room is still an error', () => {
    const applied = applyModifyOps(两居, {
      ops: [{ op: 'add_furniture', room: '地下室', item: '跑步机' }],
    }, profile)
    expect(applied.errors.some(error => error.includes('地下室'))).toBe(true)
    expect(applied.furnitureOps).toEqual([])
  })
})
