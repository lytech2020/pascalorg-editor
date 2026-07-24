import { describe, expect, test } from 'bun:test'
import type { FurnitureRoom } from './furniture-executor'
import {
  executeFurnitureModifyOps,
  isChecklistItem,
  previewRoomFurnitureClear,
  replayManualItems,
  skippedFurnitureResults,
} from './furniture-modify'

// 4×3.5 bedroom, door centered on the south wall (same fixture family as
// furniture-executor.test.ts).
const bedroom: FurnitureRoom = {
  id: 'bedroom-1',
  name: '主卧',
  type: 'bedroom',
  polygon: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]],
  zoneId: 'zone-bed',
}

const walls = [
  {
    id: 'w-south',
    start: [0, 0] as [number, number],
    end: [4, 0] as [number, number],
    openings: [{ type: 'door', position: [2, 1.05, 0] as [number, number, number], width: 0.9 }],
  },
  { id: 'w-east', start: [4, 0] as [number, number], end: [4, 3.5] as [number, number], openings: [] },
  { id: 'w-north', start: [4, 3.5] as [number, number], end: [0, 3.5] as [number, number], openings: [] },
  { id: 'w-west', start: [0, 3.5] as [number, number], end: [0, 0] as [number, number], openings: [] },
]

const CATALOG: Record<string, Array<{ id: string; name: string; dimensions: [number, number, number]; tags?: string[] }>> = {
  书桌: [{ id: 'desk', name: 'Writing Desk', dimensions: [1.2, 0.75, 0.6] }],
  床: [
    { id: 'double-bed', name: 'Double Bed', dimensions: [1.8, 0.5, 2.1] },
    { id: 'single-bed-compact', name: 'Compact Single Bed', dimensions: [1.0, 0.5, 1.9], tags: ['compact'] },
  ],
  衣柜: [{ id: 'wardrobe', name: 'Wardrobe Closet', dimensions: [1.2, 2.2, 0.6] }],
  巨型沙发: [{ id: 'mega-sofa', name: 'Mega Sofa', dimensions: [5.5, 0.9, 1.2] }],
  餐桌: [{ id: 'dining-table', name: 'Dining Table', dimensions: [1.4, 0.75, 0.9] }],
  'dining table': [{ id: 'dining-table', name: 'Dining Table', dimensions: [1.4, 0.75, 0.9] }],
}

// Existing scene: a double bed against the north wall, a wardrobe on the west.
const existingBed = {
  id: 'item-bed',
  name: 'Double Bed',
  position: [2, 0, 2.4] as [number, number, number],
  rotation: [0, Math.PI, 0] as [number, number, number],
  asset: { id: 'double-bed', name: 'Double Bed', dimensions: [1.8, 0.5, 2.1] as [number, number, number] },
}
const existingWardrobe = {
  id: 'item-wardrobe',
  name: 'Wardrobe Closet',
  position: [0.33, 0, 1.0] as [number, number, number],
  rotation: [0, Math.PI / 2, 0] as [number, number, number],
  asset: { id: 'wardrobe', name: 'Wardrobe Closet', dimensions: [1.2, 2.2, 0.6] as [number, number, number] },
}

function makeMockMcp(options: { items?: unknown[]; catalog?: typeof CATALOG } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const catalog = options.catalog ?? CATALOG
  let counter = 0
  const deleted: string[] = []
  const callMcp = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
    switch (name) {
      case 'get_walls':
        return wrap({ walls })
      case 'get_level_summary':
        return wrap({ items: options.items ?? [existingBed, existingWardrobe] })
      case 'search_assets': {
        const results = catalog[args.query as string] ?? []
        return wrap({ results, total: results.length })
      }
      case 'place_item':
        counter++
        return wrap({ itemId: `new-item-${counter}` })
      case 'delete_node':
        deleted.push(args.id as string)
        return wrap({ ok: true })
      default:
        throw new Error(`unexpected tool ${name}`)
    }
  }
  return { callMcp, calls, deleted }
}

describe('executeFurnitureModifyOps', () => {
  test('turns planner skips into explicit operation results', () => {
    expect(skippedFurnitureResults([{
      op: {
        op: 'remove_furniture',
        room: '卫生间',
        item: '洗衣机',
        operationId: 'op-1',
      },
      roomName: '卫生间',
      status: 'skipped',
      reasonCode: 'room_removed',
    }])).toEqual([{
      op: {
        op: 'remove_furniture',
        room: '卫生间',
        item: '洗衣机',
        operationId: 'op-1',
      },
      ok: true,
      status: 'skipped',
      reasonCode: 'skipped_dependency',
      detail: '「卫生间」已随房间删除，家具操作（remove_furniture）未执行',
    }])
  })

  test('remove_furniture deletes the matched item by catalog id', async () => {
    const { callMcp, deleted } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'remove_furniture', room: '主卧', item: '衣柜' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-wardrobe'])
  })

  test('add_furniture places via the wall scan and reports the pick', async () => {
    const { callMcp, calls } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '书桌' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    const place = calls.find(call => call.name === 'place_item')
    expect(place?.args.catalogItemId).toBe('desk')
    expect(place?.args.targetNodeId).toBe('zone-bed')
  })

  test('swap_furniture removes the old item and places the new one', async () => {
    const { callMcp, deleted, calls } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'swap_furniture', room: '主卧', from: '床', to: '书桌' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-bed'])
    expect(calls.some(call => call.name === 'place_item' && call.args.catalogItemId === 'desk')).toBe(true)
  })

  test('swap keeps the old item when the replacement cannot fit anywhere', async () => {
    const { callMcp, deleted } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'swap_furniture', room: '主卧', from: '床', to: '巨型沙发' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.detail).toContain('保持不变')
    expect(deleted).toEqual([]) // 先算后删：放不下就不删
  })

  test('missing item / unknown room fail with reasons, not throws', async () => {
    const { callMcp, deleted } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [
        { op: 'remove_furniture', room: '主卧', item: '书桌' }, // 房里没有书桌
        { op: 'add_furniture', room: '地下室', item: '书桌' }, // 没这个房间
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results.map(r => r.ok)).toEqual([false, false])
    expect(report.results[0]!.detail).toContain('没有找到')
    expect(report.results[1]!.detail).toContain('找不到房间')
    expect(deleted).toEqual([])
    // R1: a zero-write furniture failure must report no side effect.
    expect(report.writeEffect).toBe('no_write')
  })

  // R1: an add whose catalog term matches nothing never dispatches place_item,
  // so the turn is a safe zero-write failure (P1-2 field repro "加一个桌子").
  test('add with no catalog match is a zero-write failure', async () => {
    const { callMcp, calls } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '不存在的家具' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.reasonCode).toBe('catalog_no_match')
    expect(calls.some(call => call.name === 'place_item')).toBe(false)
    expect(report.writeEffect).toBe('no_write')
  })

  // Section-8 #5: catalog has an asset but it cannot fit anywhere — zero writes,
  // reason no_safe_position (a 5.5m sofa cannot be placed in a 4m room).
  test('add with a catalog hit but no legal position is a zero-write failure', async () => {
    const { callMcp, calls } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '巨型沙发' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.reasonCode).toBe('no_safe_position')
    expect(calls.some(call => call.name === 'place_item')).toBe(false)
    expect(report.writeEffect).toBe('no_write')
  })

  // R3.2 field repro "在客厅加一个桌子": a vague 桌子 must clarify (which table?)
  // with zero writes — never silently become 书桌/餐桌/茶几.
  test('a vague 桌子 clarifies instead of guessing a table type', async () => {
    const { callMcp, calls } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '桌子' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.reasonCode).toBe('needs_clarification')
    expect(report.results[0]!.detail).toContain('餐桌')
    expect(calls.some(call => call.name === 'search_assets')).toBe(false)
    expect(report.writeEffect).toBe('no_write')
  })

  // R3.3: a specific 餐桌 places via the room-centre strategy and succeeds even
  // though it is not against a wall.
  test('餐桌 places via room-centre placement', async () => {
    const { callMcp, calls } = makeMockMcp({ items: [] })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '餐桌' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    const place = calls.find(call => call.name === 'place_item')
    expect(place?.args.catalogItemId).toBe('dining-table')
    expect(report.writeEffect).toBe('write_confirmed')
  })

  // R4: a fridge (fixed kitchen equipment) placed in the room, plus a bed and a
  // wardrobe (movable). A clear deletes only the movable pair and retains the
  // fixed equipment; one delete_node per item, reported as a batch.
  const fridge = {
    id: 'item-fridge',
    name: 'Refrigerator',
    position: [3.6, 0, 0.4] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    asset: { id: 'fridge', name: 'Refrigerator', dimensions: [0.7, 1.8, 0.7] as [number, number, number] },
  }

  test('clear_room_furniture deletes movable items and retains fixed equipment', async () => {
    const { callMcp, deleted } = makeMockMcp({ items: [existingBed, existingWardrobe, fridge] })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'clear_room_furniture', room: '主卧' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    // Bed + wardrobe deleted; fridge kept.
    expect(deleted.sort()).toEqual(['item-bed', 'item-wardrobe'])
    expect(report.results[0]!.removedItemIds?.sort()).toEqual(['item-bed', 'item-wardrobe'])
    expect(report.results[0]!.detail).toContain('2 件')
    expect(report.writeEffect).toBe('write_confirmed')
  })

  test('clear on an empty room reports nothing to clear, zero writes', async () => {
    const { callMcp, deleted } = makeMockMcp({ items: [fridge] }) // only fixed equipment
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'clear_room_furniture', room: '主卧' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual([])
    expect(report.writeEffect).toBe('no_write')
  })

  test('clear reports an honest partial when a delete fails, no rollback claim', async () => {
    // delete_node fails for the wardrobe only.
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ items: [existingBed, existingWardrobe] })
        case 'delete_node':
          if (args.id === 'item-wardrobe') return wrap({ error: 'node locked' })
          return wrap({ ok: true })
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'clear_room_furniture', room: '主卧' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.reasonCode).toBe('mutation_failed')
    expect(report.results[0]!.detail).toContain('未自动回滚')
    // One confirmed delete (bed) + one rejected (wardrobe) — confirmed side
    // effect, so the state is write_confirmed (a rejected write left no effect).
    expect(report.writeEffect).toBe('write_confirmed')
  })

  // R5.1/R5.4: a mixed plan records an independent per-op status so the reply
  // can list what was done and what was not — a later failure never masks an
  // earlier success as if the whole turn failed.
  test('mixed ops report independent per-op done/undone status', async () => {
    const { callMcp } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [
        { op: 'add_furniture', room: '主卧', item: '书桌', operationId: 'op-0' }, // succeeds
        { op: 'remove_furniture', room: '主卧', item: '沙发', operationId: 'op-1' }, // not present → fails
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results.map(r => ({ id: r.op.operationId, ok: r.ok }))).toEqual([
      { id: 'op-0', ok: true },
      { id: 'op-1', ok: false },
    ])
    expect(report.results[1]!.reasonCode).toBe('item_not_found')
  })

  // P1-2: once a write's result is unknown, ALL subsequent ops stop — reported
  // as not_executed, never silently passed or executed against an unknown state.
  test('halts remaining ops after a write result becomes unknown', async () => {
    let deleteCalls = 0
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ items: [existingBed, existingWardrobe] })
        case 'search_assets': return wrap({ results: CATALOG['床'], total: CATALOG['床'].length })
        case 'delete_node':
          deleteCalls++
          throw new Error('transport failure (result unknown)')
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [
        { op: 'remove_furniture', room: '主卧', item: '床', operationId: 'op-0' },
        { op: 'remove_furniture', room: '主卧', item: '衣柜', operationId: 'op-1' },
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    // Only one delete dispatched; the second op is not executed.
    expect(deleteCalls).toBe(1)
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[1]!.reasonCode).toBe('not_executed')
    expect(report.writeEffect).toBe('write_attempted')
  })

  // P1-4: a catalog_unavailable placeholder IS a committed write — recorded as
  // write_confirmed, reported as a failure, and the executor does NOT keep
  // trying more candidates (which would create more placeholders).
  test('catalog_unavailable placeholder counts as a write and stops', async () => {
    let placeCalls = 0
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ items: [] })
        case 'search_assets': return wrap({ results: CATALOG['床'], total: CATALOG['床'].length })
        case 'place_item':
          placeCalls++
          return wrap({ itemId: `placeholder-${placeCalls}`, status: 'catalog_unavailable' })
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '床' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(placeCalls).toBe(1) // did not spin creating more placeholders
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.reasonCode).toBe('catalog_unavailable')
    expect(report.results[0]!.addedItemId).toBe('placeholder-1')
    expect(report.writeEffect).toBe('write_confirmed') // a placeholder was written
  })

  // P1-3: the write-effect state is reported in real time — write_attempted at
  // dispatch, then write_confirmed once the response arrives.
  test('onWriteEffect fires live: write_attempted then write_confirmed', async () => {
    const states: string[] = []
    const { callMcp } = makeMockMcp({ items: [] })
    await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '书桌' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
      onWriteEffect: state => states.push(state),
    })
    expect(states[0]).toBe('write_attempted')
    expect(states.at(-1)).toBe('write_confirmed')
  })

  // P1-5: a confirmed clear deletes ONLY the bound target ids — not a fresh
  // sweep. An item added during the confirmation wait is left untouched.
  test('clearTargets restricts deletion to the confirmed id set', async () => {
    const stray = { ...existingWardrobe, id: 'item-stray', name: 'New Sofa', position: [3.5, 0, 1.5] as [number, number, number] }
    const { callMcp, deleted } = makeMockMcp({ items: [existingBed, existingWardrobe, stray] })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'clear_room_furniture', room: '主卧' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
      // Only the bed was confirmed; the wardrobe and the stray sofa are spared.
      clearTargets: { 'bedroom-1': ['item-bed'] },
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-bed'])
  })

  // P1-B: a failed get_level_summary read must NOT look like an empty scene.
  // A clear fails with scene_read_failed and deletes nothing (no false success);
  // a remove fails with scene_read_failed (not a misleading item_not_found).
  test('a failed furniture read fails every op with zero writes, not false success', async () => {
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ error: 'level summary unavailable' })
        case 'search_assets': return wrap({ results: [], total: 0 })
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [
        { op: 'clear_room_furniture', room: '主卧' },
        { op: 'remove_furniture', room: '主卧', item: '床' },
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results.map(r => r.reasonCode)).toEqual(['scene_read_failed', 'scene_read_failed'])
    expect(report.results.every(r => !r.ok)).toBe(true)
    expect(report.writeEffect).toBe('no_write')
  })

  test('previewRoomFurnitureClear signals readFailed on a failed read', async () => {
    const callMcp = async (name: string) => {
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      if (name === 'get_level_summary') return wrap({ error: 'unavailable' })
      return wrap({})
    }
    const preview = await previewRoomFurnitureClear({
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(preview.readFailed).toBe(true)
    expect(preview.perRoom).toEqual([])
  })

  test('previewRoomFurnitureClear lists the movable target ids and count', async () => {
    const { callMcp } = makeMockMcp({ items: [existingBed, existingWardrobe, fridge] })
    const preview = await previewRoomFurnitureClear({
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(preview.perRoom).toHaveLength(1)
    expect(preview.perRoom[0]!.itemIds.sort()).toEqual(['item-bed', 'item-wardrobe'])
  })

  // R1.5: place_item whose response is lost after the server committed must NOT
  // be replayed — a second call would create a duplicate item. The result is
  // recorded as unknown, not confirmed, and not retried.
  test('place_item lost response is not replayed (write_attempted)', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    let placeCalls = 0
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ items: [] })
        case 'search_assets': return wrap({ results: CATALOG['书桌'], total: 1 })
        case 'place_item':
          placeCalls++
          throw new Error('socket hang up (response lost after commit)')
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'add_furniture', room: '主卧', item: '书桌' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(placeCalls).toBe(1)
    expect(report.results[0]!.ok).toBe(false)
    expect(report.writeEffect).toBe('write_attempted')
  })

  // R1.5: delete_node whose response is lost is likewise not replayed.
  test('delete_node lost response is not replayed (write_attempted)', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    let deleteCalls = 0
    const callMcp = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args })
      const wrap = (payload: Record<string, unknown>) => ({ structuredContent: payload })
      switch (name) {
        case 'get_walls': return wrap({ walls })
        case 'get_level_summary': return wrap({ items: [existingWardrobe] })
        case 'search_assets': return wrap({ results: CATALOG['衣柜'], total: 1 })
        case 'delete_node':
          deleteCalls++
          throw new Error('connection reset (response lost after commit)')
        default: throw new Error(`unexpected tool ${name}`)
      }
    }
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'remove_furniture', room: '主卧', item: '衣柜' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(deleteCalls).toBe(1)
    expect(report.results[0]!.ok).toBe(false)
    expect(report.writeEffect).toBe('write_attempted')
  })

  // R2.2: the executor no longer substring-matches a room ref. A bare partial
  // name that is not an exact name (nor a bound id) resolves to nothing — never
  // the first array element — so a mis-referenced op is a zero-write failure.
  test('a non-exact room ref does not substring-match to the first room', async () => {
    const otherBedroom: FurnitureRoom = {
      id: 'bedroom-2', name: '次卧', type: 'bedroom',
      polygon: [[4, 0], [8, 0], [8, 3.5], [4, 3.5]], zoneId: 'zone-bed-2',
    }
    const { callMcp, deleted } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      // '卧' is a substring of both 主卧 and 次卧 but an exact name of neither.
      ops: [{ op: 'remove_furniture', room: '卧', item: '衣柜' }],
      rooms: [bedroom, otherBedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(false)
    expect(report.results[0]!.detail).toContain('找不到房间')
    expect(deleted).toEqual([])
    expect(report.writeEffect).toBe('no_write')
  })

  // R3.5 / P2-6: with several matches and no reliable creation-order field, the
  // wording must NOT claim "the last-placed one" — it states the match count and
  // that placement order is unknown, and offers to be more specific.
  test('multiple matches: honest count wording, no false "last placed" claim', async () => {
    const secondBed = { ...existingBed, id: 'item-bed-2', position: [0.33, 0, 2.4] as [number, number, number] }
    // Two beds in the room — place them apart so both resolve to the bedroom.
    const { callMcp, deleted } = makeMockMcp({ items: [existingBed, secondBed] })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'remove_furniture', room: '主卧', item: '床' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-bed-2'])
    expect(report.results[0]!.detail).toContain('共匹配到 2 件')
    expect(report.results[0]!.detail).not.toContain('最后放置')
  })

  test('freed space is reusable within the same run (remove then add)', async () => {
    const { callMcp } = makeMockMcp()
    const report = await executeFurnitureModifyOps({
      ops: [
        { op: 'remove_furniture', room: '主卧', item: '床' },
        { op: 'add_furniture', room: '主卧', item: '床' }, // double bed fits again only if the old footprint is gone
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results.map(r => r.ok)).toEqual([true, true])
  })

  // The real MCP catalog is English-only (id/name/tags), while the op
  // translator is told to emit terms in the user's language — the checklist
  // vocabulary must bridge the two. This mock mirrors that reality: Chinese
  // queries return nothing.
  const ENGLISH_CATALOG: typeof CATALOG = {
    bed: [
      { id: 'double-bed', name: 'Double Bed', dimensions: [1.8, 0.5, 2.1] },
      { id: 'single-bed-compact', name: 'Compact Single Bed', dimensions: [1.0, 0.5, 1.9], tags: ['compact'] },
    ],
    desk: [{ id: 'desk', name: 'Writing Desk', dimensions: [1.2, 0.75, 0.6] }],
  }

  test('CJK term resolves through checklist vocabulary against an English-only catalog (eval case-18 regression)', async () => {
    const { callMcp, deleted, calls } = makeMockMcp({ catalog: ENGLISH_CATALOG })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'swap_furniture', room: '主卧', from: '床', to: '单人床' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-bed'])
    // 「床」/「单人床」 themselves hit the catalog empty; the vocabulary
    // fallback re-queries with the English search term.
    expect(calls.filter(call => call.name === 'search_assets').map(call => call.args.query)).toContain('bed')
  })

  test('a broad "bed" search must not touch bedroom-tagged non-beds (case-18 衣柜误删 regression)', async () => {
    // The real catalog matches search terms against tags too: querying "bed"
    // returns the closet (tagged "bedroom") and the bedside table. Without
    // the vocabulary-matcher filter, swap deleted the closet (last placed
    // asset-id match) and placed the bedside table as the "单人床" (smallest
    // footprint wins).
    const TAG_MATCHED_CATALOG: typeof CATALOG = {
      bed: [
        { id: 'double-bed', name: 'Double Bed', dimensions: [1.8, 0.5, 2.1] },
        { id: 'single-bed-compact', name: 'Compact Single Bed', dimensions: [1.0, 0.5, 1.9], tags: ['compact'] },
        { id: 'bedside-table', name: 'Bedside Table', dimensions: [0.4, 0.5, 0.4] },
        { id: 'closet-large', name: 'Large Closet', dimensions: [1.2, 2.2, 0.6], tags: ['bedroom'] },
      ],
    }
    const closet = {
      id: 'item-closet',
      name: 'Large Closet',
      position: [3.4, 0, 1.5] as [number, number, number],
      rotation: [0, -Math.PI / 2, 0] as [number, number, number],
      asset: { id: 'closet-large', name: 'Large Closet', dimensions: [1.2, 2.2, 0.6] as [number, number, number] },
    }
    const { callMcp, deleted, calls } = makeMockMcp({
      catalog: TAG_MATCHED_CATALOG,
      items: [existingBed, closet],
    })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'swap_furniture', room: '主卧', from: '床', to: '单人床' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    // The BED is what gets swapped — the closet stays.
    expect(deleted).toEqual(['item-bed'])
    // And the replacement is a real bed, not the smaller bedside table.
    const placed = calls.find(call => call.name === 'place_item')
    expect(placed?.args.catalogItemId).toBe('single-bed-compact')
  })

  test('CJK remove matches the placed English-named item via the trilingual matcher', async () => {
    // Catalog knows the term but returns ids that do NOT match the placed
    // item (e.g. user-placed variant) — the matcher regex still finds it.
    const { callMcp, deleted } = makeMockMcp({
      catalog: { ...ENGLISH_CATALOG, bed: [{ id: 'other-bed', name: 'Other Bed', dimensions: [1.8, 0.5, 2.1] }] },
    })
    const report = await executeFurnitureModifyOps({
      ops: [{ op: 'remove_furniture', room: '主卧', item: '床' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.results[0]!.ok).toBe(true)
    expect(deleted).toEqual(['item-bed'])
  })
})

describe('manual-item replay (MODIFY_REDESIGN §6)', () => {
  test('isChecklistItem separates checklist furniture from manual decor', () => {
    expect(isChecklistItem('Double Bed')).toBe(true)
    expect(isChecklistItem('Wardrobe Closet')).toBe(true)
    expect(isChecklistItem('Potted Plant 03')).toBe(false)
    expect(isChecklistItem('Bookshelf')).toBe(false)
  })

  test('replays a manual item into the surviving room, reports the vanished room', async () => {
    const { callMcp, calls } = makeMockMcp({ items: [] })
    const report = await replayManualItems({
      items: [
        { catalogItemId: 'plant-03', name: 'Potted Plant 03', dimensions: [0.4, 1.1, 0.4], roomName: '主卧' },
        { catalogItemId: 'bookshelf', name: 'Bookshelf', dimensions: [0.8, 1.8, 0.3], roomName: '书房' }, // 房间已删除
      ],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.replaced).toEqual(['Potted Plant 03'])
    expect(report.lost).toHaveLength(1)
    expect(report.lost[0]!.reason).toContain('已不存在')
    const place = calls.find(call => call.name === 'place_item')
    expect(place?.args.catalogItemId).toBe('plant-03')
    expect(place?.args.targetNodeId).toBe('zone-bed')
  })

  test('a manual item that no longer fits lands in lost, not silently dropped', async () => {
    const { callMcp } = makeMockMcp({ items: [existingBed, existingWardrobe] })
    const report = await replayManualItems({
      items: [{ catalogItemId: 'grand-piano', name: 'Grand Piano', dimensions: [3.9, 1.0, 3.4], roomName: '主卧' }],
      rooms: [bedroom],
      levelId: 'level-1',
      callMcp,
    })
    expect(report.replaced).toEqual([])
    expect(report.lost[0]!.reason).toContain('没有可放置的位置')
  })
})
