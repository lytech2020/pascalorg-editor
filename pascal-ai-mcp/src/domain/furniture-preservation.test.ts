import { describe, expect, it } from 'bun:test'
import type { FurnitureRoom } from '../furniture-executor'
import type { LayoutPlan } from '../layout-plan'
import {
  planFurnitureRestoration,
  preservedFurnitureFromNodes,
  type PreservedFurniture,
} from './furniture-preservation'

const bedroom: FurnitureRoom = {
  id: 'bedroom-1', name: '主卧', type: 'bedroom', zoneId: 'zone-bed',
  polygon: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]],
}
const living: FurnitureRoom = {
  id: 'living-1', name: '客厅', type: 'living', zoneId: 'zone-living',
  polygon: [[4, 0], [10, 0], [10, 3.5], [4, 3.5]],
}

const item = (over: Partial<PreservedFurniture> & Pick<PreservedFurniture, 'name' | 'roomId'>): PreservedFurniture => ({
  sourceItemId: `src-${over.name}`,
  catalogItemId: 'double-bed',
  assetName: 'Double Bed',
  dimensions: [1.8, 0.5, 2.1],
  scale: [1, 1, 1],
  position: [2, 0, 2.4],
  rotationY: Math.PI,
  roomName: over.roomId === 'bedroom-1' ? '主卧' : '客厅',
  ...over,
})

describe('planFurnitureRestoration', () => {
  it('keeps an item whose room and spot both survive', () => {
    const { decisions } = planFurnitureRestoration({
      items: [item({ name: 'Double Bed', roomId: 'bedroom-1' })],
      rooms: [bedroom, living],
      keepClear: [],
    })
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.kind).toBe('keep')
  })

  it('drops an item whose room no longer exists', () => {
    const { decisions } = planFurnitureRestoration({
      items: [item({ name: 'Shelf', roomId: 'study-1' })],
      rooms: [bedroom],
      keepClear: [],
    })
    expect(decisions[0]).toMatchObject({ kind: 'drop', reasonCode: 'room_removed' })
  })

  it('relocates an item that would now sit outside its (shrunk) room', () => {
    const shrunk: FurnitureRoom = { ...bedroom, polygon: [[0, 0], [4, 0], [4, 2], [0, 2]] }
    const { decisions } = planFurnitureRestoration({
      items: [item({ name: 'Double Bed', roomId: 'bedroom-1' })],
      rooms: [shrunk],
      keepClear: [],
    })
    expect(decisions[0]!.kind).toBe('relocate')
  })

  it('relocates an item blocked by a door keep-clear zone', () => {
    const { decisions } = planFurnitureRestoration({
      items: [item({ name: 'Double Bed', roomId: 'bedroom-1' })],
      rooms: [bedroom],
      // A keep-out rectangle straddling the bed's footprint.
      keepClear: [{ minX: 1.5, maxX: 2.5, minZ: 2.0, maxZ: 3.0 }],
    })
    expect(decisions[0]!.kind).toBe('relocate')
  })

  it('keeps the first of two colliding items and relocates the second (deterministic order)', () => {
    const { decisions, keptFootprints } = planFurnitureRestoration({
      items: [
        item({ name: 'Bed A', roomId: 'bedroom-1' }),
        item({ name: 'Bed B', roomId: 'bedroom-1' }),
      ],
      rooms: [bedroom],
      keepClear: [],
    })
    expect(decisions.map(entry => entry.kind)).toEqual(['keep', 'relocate'])
    expect(keptFootprints).toHaveLength(1)
  })

  it('does not let an item in one room block an item in another', () => {
    const { decisions } = planFurnitureRestoration({
      items: [
        item({ name: 'Bed', roomId: 'bedroom-1' }),
        item({ name: 'Sofa', roomId: 'living-1', position: [7, 0, 2.4], dimensions: [2.0, 0.8, 0.9], rotationY: 0 }),
      ],
      rooms: [bedroom, living],
      keepClear: [],
    })
    expect(decisions.map(entry => entry.kind)).toEqual(['keep', 'keep'])
  })
})

describe('preservedFurnitureFromNodes (snapshot extraction)', () => {
  const beforePlan: LayoutPlan = {
    footprint: { width: 10, depth: 3.5 },
    entry: { roomId: 'bedroom-1' },
    rooms: [
      { id: 'bedroom-1', name: '主卧', type: 'bedroom', requiresExteriorWindow: true,
        polygon: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]] },
      { id: 'living-1', name: '客厅', type: 'living', requiresExteriorWindow: true,
        polygon: [[4, 0], [10, 0], [10, 3.5], [4, 3.5]] },
    ],
    connections: [{ from: 'bedroom-1', to: 'living-1', type: 'door' }],
  }
  const zones = [
    { id: 'zone-bed', name: '主卧', polygon: [[0, 0], [4, 0], [4, 3.5], [0, 3.5]] as Array<[number, number]> },
  ]
  const floorItem = (over: Record<string, unknown> = {}) => ({
    type: 'item',
    name: 'Double Bed',
    position: [2, 0, 2],
    rotation: [0, Math.PI, 0],
    scale: [1, 1, 1],
    asset: { id: 'double-bed', name: 'Double Bed', dimensions: [1.8, 0.5, 2.1] },
    ...over,
  })
  const extract = (nodes: Record<string, Record<string, unknown>>) =>
    preservedFurnitureFromNodes({ nodes, beforePlan, zones })

  it('captures a free-standing floor item with its real rotation and scaled size', () => {
    const items = extract({ 'item-1': floorItem({ scale: [1, 1, 2] }) })
    expect(items).toHaveLength(1)
    expect(items[0]!.rotationY).toBe(Math.PI)
    expect(items[0]!.scale).toEqual([1, 1, 2])
    // depth 2.1 × scale 2 = 4.2 — the item's REAL footprint.
    expect(items[0]!.dimensions).toEqual([1.8, 0.5, 4.2])
    expect(items[0]!.roomId).toBe('bedroom-1')
  })

  it('excludes every mounted item, including wall-side', () => {
    for (const attachTo of ['wall', 'wall-side', 'ceiling']) {
      const items = extract({ 'item-1': floorItem({
        asset: { id: 'picture', name: 'Picture', dimensions: [0.6, 0.8, 0.05], attachTo },
      }) })
      expect(items).toEqual([])
    }
  })

  it('excludes wall- and roof-hosted items whose coordinates are host-local', () => {
    expect(extract({ 'item-1': floorItem({ wallId: 'wall-3' }) })).toEqual([])
    expect(extract({ 'item-1': floorItem({ roofSegmentId: 'roof-1' }) })).toEqual([])
  })

  it('excludes an item nested on another item (parent-local coordinates)', () => {
    const items = extract({
      'item-table': floorItem({ name: 'Table', children: ['item-lamp'] }),
      'item-lamp': floorItem({ name: 'Lamp', position: [0, 0.75, 0] }),
    })
    expect(items.map(entry => entry.name)).toEqual(['Table'])
  })

  it('keeps the user-edited name alongside the catalogue asset name', () => {
    const items = extract({ 'item-1': floorItem({ name: '祖传宝贝' }) })
    expect(items[0]!.name).toBe('祖传宝贝')
    expect(items[0]!.assetName).toBe('Double Bed')
  })

  it('joins on the stable room id so a renamed room keeps its furniture', () => {
    const items = extract({ 'item-1': floorItem() })
    // The room is renamed in the same turn; the id is what survives.
    const renamed = [{ id: 'bedroom-1', name: '儿童房', type: 'bedroom' as const, zoneId: 'z', polygon: beforePlan.rooms[0]!.polygon }]
    const { decisions } = planFurnitureRestoration({ items, rooms: renamed, keepClear: [] })
    expect(decisions[0]!.kind).toBe('keep')
  })

  it('falls back to the live zone when the plan does not cover the point', () => {
    const driftPlan: LayoutPlan = { ...beforePlan, rooms: [
      { ...beforePlan.rooms[0]!, polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] },
      beforePlan.rooms[1]!,
    ] }
    const items = preservedFurnitureFromNodes({ nodes: { 'item-1': floorItem() }, beforePlan: driftPlan, zones })
    expect(items[0]!.roomId).toBe('bedroom-1')
  })
})
