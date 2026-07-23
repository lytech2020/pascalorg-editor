import { LAYOUT_PLAN_SEMANTICS_VERSION, semanticForRoomType } from '../domain/space-semantics'
import { classifyRoomTypeByName } from '../lang/room-vocab'
import type { LayoutPlanRoom, RoomType } from '../layout-plan'
import type { SceneSpaceStore } from '../ports/scene-space-store'

export type SceneZone = { id: string; name: string }

export class SceneSpaceService {
  constructor(private readonly spaces: SceneSpaceStore) {}

  recordBuiltRoom(
    sceneId: string,
    created: { planRoom: LayoutPlanRoom; zoneId: string; sceneVersion?: number },
  ): void {
    const semantic = semanticForRoomType(created.planRoom.type)
    const now = new Date().toISOString()
    this.spaces.upsert({
      sceneId,
      zoneId: created.zoneId,
      usage: semantic.usage,
      category: semantic.category,
      source: 'layout_plan',
      confidence: 1,
      planRoomId: created.planRoom.id,
      planVersion: LAYOUT_PLAN_SEMANTICS_VERSION,
      ...(created.sceneVersion !== undefined ? { sceneVersion: created.sceneVersion } : {}),
      createdAt: now,
      updatedAt: now,
    })
  }

  resolveRoomTypes(
    sceneId: string | undefined,
    zones: SceneZone[],
    cachedTypes: Record<string, RoomType> | undefined,
  ): Record<string, RoomType> {
    const fallback = {
      ...Object.fromEntries(zones.map(zone => [zone.id, classifyRoomTypeByName(zone.name)])),
      ...(cachedTypes ?? {}),
    }
    if (!sceneId) return fallback
    this.spaces.importLegacyOnce(sceneId, zones, cachedTypes)
    return { ...fallback, ...this.spaces.roomTypesByScene(sceneId) }
  }
}
