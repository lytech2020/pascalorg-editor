import { classifyRoomTypeByName } from '../lang/room-vocab'
import {
  inferOutdoorSemantic,
  roomTypeForUsage,
  semanticForRoomType,
  type SceneSpaceRecord,
  type SpaceCategory,
  type SpaceSemanticSource,
} from '../domain/space-semantics'
import type { RoomType } from '../layout-plan'
import type { SceneSpaceStore } from '../ports/scene-space-store'
import type { AppDatabase } from './database'

type LegacyZone = { id: string; name: string }

export class SceneSpaceRepository implements SceneSpaceStore {
  private readonly upsertStatement
  private readonly insertIfAbsentStatement
  private readonly bySceneStatement
  private readonly bySceneZoneStatement

  constructor(private readonly database: AppDatabase) {
    this.upsertStatement = database.connection.prepare(`
      INSERT INTO ai_scene_spaces (
        scene_id, zone_id, usage, category, source, confidence,
        template_id, plan_room_id, plan_version, scene_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scene_id, zone_id) DO UPDATE SET
        usage = excluded.usage,
        category = excluded.category,
        source = excluded.source,
        confidence = excluded.confidence,
        template_id = excluded.template_id,
        plan_room_id = excluded.plan_room_id,
        plan_version = excluded.plan_version,
        scene_version = excluded.scene_version,
        updated_at = excluded.updated_at
    `)
    this.insertIfAbsentStatement = database.connection.prepare(`
      INSERT OR IGNORE INTO ai_scene_spaces (
        scene_id, zone_id, usage, category, source, confidence,
        template_id, plan_room_id, plan_version, scene_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `)
    this.bySceneStatement = database.connection.prepare(`
      SELECT * FROM ai_scene_spaces WHERE scene_id = ? ORDER BY zone_id
    `)
    this.bySceneZoneStatement = database.connection.prepare(`
      SELECT * FROM ai_scene_spaces WHERE scene_id = ? AND zone_id = ?
    `)
  }

  upsert(record: SceneSpaceRecord): void {
    this.upsertStatement.run(
      record.sceneId,
      record.zoneId,
      record.usage,
      record.category,
      record.source,
      Math.max(0, Math.min(1, record.confidence)),
      record.templateId ?? null,
      record.planRoomId ?? null,
      record.planVersion ?? null,
      record.sceneVersion ?? null,
      record.createdAt,
      record.updatedAt,
    )
  }

  findByScene(sceneId: string): SceneSpaceRecord[] {
    return (this.bySceneStatement.all(sceneId) as Array<Record<string, unknown>>).map(fromRow)
  }

  find(sceneId: string, zoneId: string): SceneSpaceRecord | undefined {
    const row = this.bySceneZoneStatement.get(sceneId, zoneId) as Record<string, unknown> | null
    return row ? fromRow(row) : undefined
  }

  roomTypesByScene(sceneId: string): Record<string, RoomType> {
    return Object.fromEntries(this.findByScene(sceneId).flatMap(record => {
      const type = roomTypeForUsage(record.usage)
      return type ? [[record.zoneId, type]] : []
    }))
  }

  importLegacyOnce(
    sceneId: string,
    zones: LegacyZone[],
    cachedTypes: Record<string, RoomType> = {},
  ): number {
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      let inserted = 0
      const existing = new Set(this.findByScene(sceneId).map(record => record.zoneId))
      for (const zone of zones) {
        if (existing.has(zone.id)) continue
        const cached = cachedTypes[zone.id]
        const semantic = cached
          ? semanticForRoomType(cached)
          : inferOutdoorSemantic(zone.name) ?? semanticForRoomType(classifyRoomTypeByName(zone.name))
        const source: SpaceSemanticSource = cached ? 'legacy_session_cache' : 'legacy_name_inference'
        inserted += this.insertIfAbsentStatement.run(
          sceneId,
          zone.id,
          semantic.usage,
          semantic.category,
          source,
          cached ? 0.9 : 0.4,
          now,
          now,
        ).changes
      }
      return inserted
    })
  }
}

function fromRow(row: Record<string, unknown>): SceneSpaceRecord {
  return {
    sceneId: String(row.scene_id),
    zoneId: String(row.zone_id),
    usage: String(row.usage),
    category: row.category as SpaceCategory,
    source: row.source as SpaceSemanticSource,
    confidence: Number(row.confidence),
    ...(typeof row.template_id === 'string' ? { templateId: row.template_id } : {}),
    ...(typeof row.plan_room_id === 'string' ? { planRoomId: row.plan_room_id } : {}),
    ...(typeof row.plan_version === 'string' ? { planVersion: row.plan_version } : {}),
    ...(typeof row.scene_version === 'number' ? { sceneVersion: row.scene_version } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
