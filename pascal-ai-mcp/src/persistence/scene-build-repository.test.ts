import { describe, expect, test } from 'bun:test'
import { AppDatabase } from './database'
import { ChatRequestRepository } from './session-repository'
import { SceneBuildRepository } from './scene-build-repository'
import { cleanupAbandonedScenes } from '../scene-build-cleanup'

function setup(): {
  database: AppDatabase
  requests: ChatRequestRepository
  builds: SceneBuildRepository
} {
  const database = new AppDatabase(':memory:')
  const requests = new ChatRequestRepository(database)
  requests.start({
    requestId: 'req-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    kind: 'chat',
    startedAt: '2026-07-21T00:00:00.000Z',
  })
  return { database, requests, builds: new SceneBuildRepository(database) }
}

function startBuild(builds: SceneBuildRepository): void {
  builds.start({
    buildId: 'build-1',
    requestId: 'req-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    startedAt: '2026-07-21T00:00:01.000Z',
  })
  builds.identifyScene('build-1', 'scene-1', '2026-07-21T00:00:02.000Z')
  builds.updateBoundary(
    'build-1',
    { version: 3, graphHash: 'hash-3' },
    '2026-07-21T00:00:03.000Z',
  )
}

describe('SceneBuildRepository (T2.4)', () => {
  test('recovers a build left active after its parent request became terminal', () => {
    const { database, requests, builds } = setup()
    try {
      startBuild(builds)
      requests.finish('req-1', 'failed', '2026-07-21T00:00:04.000Z', 'internal_error')
      expect(builds.abandonOrphaned('2026-07-21T00:00:05.000Z')).toBe(1)
      expect(builds.find('build-1')).toMatchObject({
        status: 'abandoned',
        sceneId: 'scene-1',
        errorCode: 'internal_error',
      })
      expect(builds.findByRequestId('req-1')).toMatchObject({ buildId: 'build-1' })
    } finally {
      database.close()
    }
  })

  test('an orphan sweep fences a worker that has lost its request lease', () => {
    const { database, requests, builds } = setup()
    try {
      startBuild(builds)
      requests.finish('req-1', 'failed', '2026-07-21T00:00:04.000Z', 'process_interrupted')
      expect(builds.abandonOrphaned('2026-07-21T00:00:05.000Z')).toBe(1)

      expect(() => builds.updateBoundary(
        'build-1',
        { version: 4, graphHash: 'hash-4' },
        '2026-07-21T00:00:06.000Z',
      )).toThrow('scene build build-1 is missing or in the wrong state')
      expect(() => builds.succeed(
        'build-1',
        { version: 4, graphHash: 'hash-4' },
        '2026-07-21T00:00:07.000Z',
      )).toThrow('scene build build-1 is missing or in the wrong state')

      expect(builds.find('build-1')).toMatchObject({
        status: 'abandoned',
        expectedVersion: 3,
        expectedGraphHash: 'hash-3',
        errorCode: 'process_interrupted',
      })
      expect(builds.cleanupCandidates()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  test('does not infer abandonment from a successful parent request', () => {
    const { database, requests, builds } = setup()
    try {
      startBuild(builds)
      requests.finish('req-1', 'succeeded', '2026-07-21T00:00:04.000Z')

      expect(builds.abandonOrphaned('2026-07-21T00:00:05.000Z')).toBe(0)
      expect(builds.find('build-1')).toMatchObject({ status: 'building' })
    } finally {
      database.close()
    }
  })

  test('deletes an unchanged abandoned scene once and then becomes idempotent', async () => {
    const { database, builds } = setup()
    try {
      startBuild(builds)
      builds.abandon('build-1', 'scene_build_failed', '2026-07-21T00:00:04.000Z')
      const calls: string[] = []
      const first = await cleanupAbandonedScenes(builds, async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`)
        return name === 'get_project_status'
          ? { structuredContent: { version: 3, graphHash: 'hash-3' } }
          : { structuredContent: { deleted: true } }
      })
      expect(first).toEqual({ cleaned: ['build-1'], skipped: [] })
      expect(calls).toEqual([
        'get_project_status:{"id":"scene-1"}',
        'delete_scene:{"id":"scene-1","expectedVersion":3}',
      ])
      expect(builds.find('build-1')).toMatchObject({
        status: 'cleaned', cleanupAttempts: 1, errorCode: 'deleted',
      })
      expect(await cleanupAbandonedScenes(builds, async () => {
        throw new Error('must not be called')
      })).toEqual({ cleaned: [], skipped: [] })
    } finally {
      database.close()
    }
  })

  test('refuses to delete when the scene changed after abandonment', async () => {
    const { database, builds } = setup()
    try {
      startBuild(builds)
      builds.abandon('build-1', 'scene_build_failed', '2026-07-21T00:00:04.000Z')
      let deleted = false
      const result = await cleanupAbandonedScenes(builds, async name => {
        if (name === 'delete_scene') deleted = true
        return { structuredContent: { version: 3, graphHash: 'user-edited-hash' } }
      })
      expect(result).toEqual({
        cleaned: [],
        skipped: [{ buildId: 'build-1', reason: 'scene_changed_after_abandonment' }],
      })
      expect(deleted).toBe(false)
      expect(builds.find('build-1')).toMatchObject({
        status: 'cleanup_failed', cleanupAttempts: 1,
        errorCode: 'scene_changed_after_abandonment',
      })
    } finally {
      database.close()
    }
  })

  test('distinguishes an invalid status boundary from a changed scene', async () => {
    const { database, builds } = setup()
    try {
      startBuild(builds)
      builds.abandon('build-1', 'scene_build_failed', '2026-07-21T00:00:04.000Z')
      let deleted = false
      const result = await cleanupAbandonedScenes(builds, async name => {
        if (name === 'delete_scene') deleted = true
        return { structuredContent: { version: '3', graphHash: 'hash-3' } }
      })

      expect(result).toEqual({
        cleaned: [],
        skipped: [{ buildId: 'build-1', reason: 'invalid_scene_boundary' }],
      })
      expect(deleted).toBe(false)
      expect(builds.find('build-1')).toMatchObject({
        status: 'cleanup_failed',
        cleanupAttempts: 1,
        errorCode: 'invalid_scene_boundary',
      })
    } finally {
      database.close()
    }
  })
})
