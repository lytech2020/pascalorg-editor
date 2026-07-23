import { describe, expect, test } from 'bun:test'
import type { SceneSpaceRecord } from '../domain/space-semantics'
import type { RoomType } from '../layout-plan'
import type { SceneSpaceStore } from '../ports/scene-space-store'
import { SceneSpaceService } from './scene-space-service'

describe('scene space application service', () => {
  test('prefers the persisted scene projection over a renamed zone and stale session cache', () => {
    const store = new MemorySceneSpaceStore()
    store.types = { 'zone-1': 'bedroom' }
    const service = new SceneSpaceService(store)
    expect(service.resolveRoomTypes(
      'scene-1',
      [{ id: 'zone-1', name: 'Renamed as kitchen' }],
      { 'zone-1': 'bathroom' },
    )).toEqual({ 'zone-1': 'bedroom' })
    expect(store.imports).toBe(1)
  })

  test('records a built room with stable plan provenance', () => {
    const store = new MemorySceneSpaceStore()
    const service = new SceneSpaceService(store)
    service.recordBuiltRoom('scene-1', {
      planRoom: {
        id: 'bed-1', name: '主卧', type: 'bedroom', polygon: [[0, 0], [3, 0], [3, 3], [0, 3]],
        requiresExteriorWindow: true,
      },
      zoneId: 'zone-1',
      sceneVersion: 7,
    })
    expect(store.records[0]).toMatchObject({
      sceneId: 'scene-1', zoneId: 'zone-1', usage: 'bedroom', category: 'indoor_room',
      source: 'layout_plan', confidence: 1, planRoomId: 'bed-1', planVersion: 'layout-plan-v1',
      sceneVersion: 7,
    })
  })
})

class MemorySceneSpaceStore implements SceneSpaceStore {
  records: SceneSpaceRecord[] = []
  types: Record<string, RoomType> = {}
  imports = 0

  upsert(record: SceneSpaceRecord): void {
    this.records.push(record)
  }

  findByScene(): SceneSpaceRecord[] {
    return this.records
  }

  roomTypesByScene(): Record<string, RoomType> {
    return this.types
  }

  importLegacyOnce(): number {
    this.imports += 1
    return 0
  }
}
