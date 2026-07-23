import type { RoomType } from '../layout-plan'
import type { SceneSpaceRecord } from '../domain/space-semantics'

export interface SceneSpaceStore {
  upsert(record: SceneSpaceRecord): void
  findByScene(sceneId: string): SceneSpaceRecord[]
  roomTypesByScene(sceneId: string): Record<string, RoomType>
  importLegacyOnce(
    sceneId: string,
    zones: Array<{ id: string; name: string }>,
    cachedTypes?: Record<string, RoomType>,
  ): number
}
