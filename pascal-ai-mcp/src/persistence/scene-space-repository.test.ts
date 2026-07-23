import { describe, expect, test } from 'bun:test'
import { AppDatabase } from './database'
import { SceneSpaceRepository } from './scene-space-repository'

describe('SceneSpaceRepository', () => {
  test('keeps open usage strings and survives room renames by keying on zone id', () => {
    const database = new AppDatabase(':memory:')
    try {
      const spaces = new SceneSpaceRepository(database)
      spaces.upsert({
        sceneId: 'scene-1',
        zoneId: 'zone-1',
        usage: 'music_rehearsal',
        category: 'indoor_room',
        source: 'manual',
        confidence: 0.8,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      })
      spaces.importLegacyOnce('scene-1', [{ id: 'zone-1', name: 'Renamed Bedroom' }])
      expect(spaces.find('scene-1', 'zone-1')).toMatchObject({
        usage: 'music_rehearsal',
        source: 'manual',
      })
    } finally {
      database.close()
    }
  })

  test('imports legacy names once, preserves cached types, and does not call a garden a room', () => {
    const database = new AppDatabase(':memory:')
    try {
      const spaces = new SceneSpaceRepository(database)
      expect(spaces.importLegacyOnce('scene-1', [
        { id: 'bed', name: 'Anything' },
        { id: 'garden', name: 'Back garden' },
      ], { bed: 'bedroom' })).toBe(2)
      expect(spaces.find('scene-1', 'bed')).toMatchObject({
        usage: 'bedroom',
        category: 'indoor_room',
        source: 'legacy_session_cache',
        confidence: 0.9,
      })
      expect(spaces.find('scene-1', 'garden')).toMatchObject({
        usage: 'garden',
        category: 'outdoor',
        source: 'legacy_name_inference',
        confidence: 0.4,
      })
      expect(spaces.importLegacyOnce('scene-1', [
        { id: 'bed', name: 'Kitchen after rename' },
        { id: 'garden', name: 'Bedroom after rename' },
      ])).toBe(0)
      expect(spaces.roomTypesByScene('scene-1')).toEqual({ bed: 'bedroom' })
    } finally {
      database.close()
    }
  })

  test('retains scene semantics when a session is deleted', () => {
    const database = new AppDatabase(':memory:')
    try {
      const spaces = new SceneSpaceRepository(database)
      database.connection.query(`
        INSERT INTO ai_sessions (
          session_id, version, phase, state_json, created_at, updated_at
        ) VALUES (?, 1, 'completed', '{}', ?, ?)
      `).run('session-1', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
      spaces.upsert({
        sceneId: 'scene-1', zoneId: 'zone-1', usage: 'bedroom', category: 'indoor_room',
        source: 'layout_plan', confidence: 1, planRoomId: 'bed-1', planVersion: 'layout-plan-v1',
        createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
      })
      database.connection.query('DELETE FROM ai_sessions WHERE session_id = ?').run('session-1')
      expect(spaces.findByScene('scene-1')).toHaveLength(1)
    } finally {
      database.close()
    }
  })
})
