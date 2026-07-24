import { describe, expect, test } from 'bun:test'
import type { LayoutPlan } from '../layout-plan'
import {
  normalizeSemanticRemovalPlan,
  preservationPolicyFor,
  removalRoomIdsForRef,
  validateExecutedPlan,
  validatePreservedPlan,
  withPreservationPolicy,
} from './modification-preservation'

const before: LayoutPlan = {
  footprint: { width: 6, depth: 4, polygon: [[0, 0], [6, 0], [6, 4], [0, 4]] },
  entry: { roomId: 'entry' },
  rooms: [
    { id: 'entry', name: '玄关', type: 'other', polygon: [[0, 0], [2, 0], [2, 4], [0, 4]], requiresExteriorWindow: false },
    { id: 'living', name: '客厅', type: 'living', polygon: [[2, 0], [6, 0], [6, 4], [2, 4]], requiresExteriorWindow: true },
  ],
  connections: [{ from: 'entry', to: 'living', type: 'door' }],
}

describe('modification preservation policy', () => {
  test('turns explicit keep-other-rooms language into a strict policy', () => {
    const plan = { ops: [{ op: 'remove_room' as const, room: '玄关' }] }
    expect(preservationPolicyFor('只删除玄关，其他房间不要动', plan)).toEqual({
      mode: 'strict_local',
      allowedRoomRefs: ['玄关'],
      preserveFootprint: true,
    })
    expect(withPreservationPolicy('删除玄关', plan).preservation?.mode).toBe('allow_rebuild')
  })

  test('best-effort preservation language permits a safe rebuild', () => {
    const remove = { ops: [{ op: 'remove_room' as const, room: '次卧' }] }
    expect(preservationPolicyFor('删掉次卧，其他房间尽量保持不变', remove)).toEqual({
      mode: 'best_effort',
      allowedRoomRefs: ['次卧'],
      preserveFootprint: false,
    })

    const add = {
      ops: [{
        op: 'add_room' as const,
        room: { name: '书房', type: 'study' as const, targetAreaSqm: 7 },
      }],
    }
    expect(preservationPolicyFor('只新增书房，其他房间尽可能保持不变', add).mode)
      .toBe('strict_local')
    expect(preservationPolicyFor('新增书房时尽可能保持现有布局', add).mode)
      .toBe('best_effort')
  })

  test('absolute preservation language remains strict', () => {
    const plan = { ops: [{ op: 'remove_room' as const, room: '卫生间' }] }
    expect(preservationPolicyFor('把卫生间删掉，其他房间都不要动', plan).mode)
      .toBe('strict_local')
    expect(preservationPolicyFor('删除玄关，其他房间保持不变', plan).mode)
      .toBe('strict_local')
  })

  test('strict local rejects footprint and unrelated room changes', () => {
    const after: LayoutPlan = {
      ...before,
      footprint: { width: 7, depth: 4, polygon: [[0, 0], [7, 0], [7, 4], [0, 4]] },
      rooms: before.rooms.map(room => room.id === 'living'
        ? { ...room, polygon: [[3, 0], [7, 0], [7, 4], [3, 4]] }
        : room),
    }
    const findings = validatePreservedPlan(before, after, withPreservationPolicy(
      '只改玄关，其他房间不要动',
      { ops: [{ op: 'resize_room', room: '玄关', targetAreaSqm: 6 }] },
    ))
    expect(findings.map(finding => finding.code)).toContain('footprint_changed')
    expect(findings).toContainEqual({ code: 'unrelated_room_changed', roomId: 'living' })
  })

  test('best effort permits necessary footprint change but rejects meaningful unrelated changes', () => {
    const plan = withPreservationPolicy(
      '扩大玄关时尽量保持现有布局',
      { ops: [{ op: 'resize_room', room: '玄关', targetAreaSqm: 6 }] },
    )
    const rebuilt: LayoutPlan = {
      ...before,
      footprint: { width: 7, depth: 4, polygon: [[0, 0], [7, 0], [7, 4], [0, 4]] },
      rooms: before.rooms.map(room => room.id === 'living'
        ? { ...room, polygon: [[3, 0], [7, 0], [7, 4], [3, 4]] }
        : room),
    }
    expect(validatePreservedPlan(before, rebuilt, plan).map(finding => finding.code))
      .toEqual(['unrelated_room_changed'])
  })

  test('generic bathroom deletion survives a model narrowing it to toilet', () => {
    expect(normalizeSemanticRemovalPlan(
      '把卫生间删掉，其他房间都不要动',
      { ops: [{ op: 'remove_room', room: 'トイレ' }] },
    )).toEqual({ ops: [{ op: 'remove_room', room: '卫生间' }] })
    expect(normalizeSemanticRemovalPlan(
      '只删除トイレ',
      { ops: [{ op: 'remove_room', room: 'トイレ' }] },
    )).toEqual({ ops: [{ op: 'remove_room', room: 'トイレ' }] })
  })

  test('strict local resize allows exactly one adjacent room to exchange the same area', () => {
    const resizeBefore: LayoutPlan = {
      footprint: before.footprint,
      entry: { roomId: 'bedroom' },
      rooms: [
        {
          id: 'bedroom',
          name: '主卧',
          type: 'bedroom',
          polygon: [[0, 0], [3, 0], [3, 4], [0, 4]],
          requiresExteriorWindow: true,
        },
        {
          id: 'living',
          name: '客厅',
          type: 'living',
          polygon: [[3, 0], [6, 0], [6, 4], [3, 4]],
          requiresExteriorWindow: true,
        },
      ],
      connections: [{ from: 'bedroom', to: 'living', type: 'door' }],
    }
    const resizeAfter: LayoutPlan = {
      ...resizeBefore,
      rooms: [
        { ...resizeBefore.rooms[0]!, polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] },
        { ...resizeBefore.rooms[1]!, polygon: [[4, 0], [6, 0], [6, 4], [4, 4]] },
      ],
    }
    expect(validatePreservedPlan(resizeBefore, resizeAfter, withPreservationPolicy(
      '只把主卧扩大到16平方米，其他房间不要动',
      { ops: [{ op: 'resize_room', room: '主卧', targetAreaSqm: 16 }] },
    ))).toEqual([])
  })

  test('strict local treats a split Japanese bathroom as one semantic removal group', () => {
    const splitBefore: LayoutPlan = {
      footprint: { width: 4, depth: 3 },
      entry: { roomId: 'entry' },
      rooms: [
        { id: 'entry', name: '玄関', type: 'entry', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]], requiresExteriorWindow: false },
        { id: 'wc', name: 'トイレ', type: 'bathroom', polygon: [[3, 0], [4, 0], [4, 1], [3, 1]], requiresExteriorWindow: false },
        { id: 'bath', name: '浴室', type: 'bathroom', polygon: [[3, 1], [4, 1], [4, 2], [3, 2]], requiresExteriorWindow: false },
        { id: 'wash', name: '洗面室', type: 'bathroom', polygon: [[3, 2], [4, 2], [4, 3], [3, 3]], requiresExteriorWindow: false },
      ],
      connections: [],
    }
    const splitAfter: LayoutPlan = {
      ...splitBefore,
      rooms: [{
        ...splitBefore.rooms[0]!,
        polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
      }],
    }
    expect(validatePreservedPlan(splitBefore, splitAfter, withPreservationPolicy(
      '把卫生间删掉，其他房间都不要动',
      { ops: [{ op: 'remove_room', room: '卫生间' }] },
    ))).toEqual([])
  })

  test('generic removal resolves one Japanese service group but never every same-type room', () => {
    const splitPlan: LayoutPlan = {
      ...before,
      rooms: [
        ...before.rooms,
        { id: 'wc', name: 'トイレ', type: 'bathroom', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], requiresExteriorWindow: false },
        { id: 'bath', name: '浴室', type: 'bathroom', polygon: [[1, 0], [2, 0], [2, 1], [1, 1]], requiresExteriorWindow: false },
        { id: 'wash', name: '洗面室', type: 'bathroom', polygon: [[2, 0], [3, 0], [3, 1], [2, 1]], requiresExteriorWindow: false },
      ],
    }
    expect(removalRoomIdsForRef(splitPlan, '卫生间')).toEqual(['wc', 'bath', 'wash'])

    const multiBathroom: LayoutPlan = {
      ...before,
      rooms: [
        ...before.rooms,
        { id: 'primary-bath', name: '主卫', type: 'bathroom', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]], requiresExteriorWindow: false },
        { id: 'guest-bath', name: '客卫', type: 'bathroom', polygon: [[1, 0], [2, 0], [2, 1], [1, 1]], requiresExteriorWindow: false },
        { id: 'public-bath', name: '公卫', type: 'bathroom', polygon: [[2, 0], [3, 0], [3, 1], [2, 1]], requiresExteriorWindow: false },
      ],
    }
    expect(removalRoomIdsForRef(multiBathroom, '卫生间')).toEqual([])
    expect(removalRoomIdsForRef(multiBathroom, '客卫')).toEqual(['guest-bath'])
  })

  test('executed-plan verification rejects extra and duplicate real zones', () => {
    const actual = before.rooms.map(room => ({ name: room.name, polygon: room.polygon }))
    expect(validateExecutedPlan(before, actual)).toEqual([])
    expect(validateExecutedPlan(before, [
      ...actual,
      { name: '幽灵房间', polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    ])).toEqual([{ code: 'executed_plan_mismatch' }])
  })
})
