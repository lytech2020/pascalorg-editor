import type { SceneBuildRecord, SceneBuildRepository } from './persistence/scene-build-repository'
import { toolPayload, type McpCaller } from './scene-executor'

export type SceneCleanupResult = {
  cleaned: string[]
  skipped: Array<{ buildId: string; reason: string }>
}

export async function cleanupAbandonedScenes(
  builds: SceneBuildRepository,
  callMcp: McpCaller,
): Promise<SceneCleanupResult> {
  const result: SceneCleanupResult = { cleaned: [], skipped: [] }
  for (const build of builds.cleanupCandidates()) {
    const at = new Date().toISOString()
    const reason = await cleanupOne(builds, callMcp, build, at)
    if (reason === null) result.cleaned.push(build.buildId)
    else result.skipped.push({ buildId: build.buildId, reason })
  }
  return result
}

async function cleanupOne(
  builds: SceneBuildRepository,
  callMcp: McpCaller,
  build: SceneBuildRecord,
  at: string,
): Promise<string | null> {
  if (!build.sceneId || build.expectedVersion === undefined || !build.expectedGraphHash) {
    builds.markCleanupFailed(build.buildId, 'missing_scene_boundary', at)
    return 'missing_scene_boundary'
  }

  let status: Record<string, unknown>
  try {
    status = toolPayload(await callMcp('get_project_status', { id: build.sceneId }))
  } catch (error) {
    if (isMissingSceneError(error)) {
      builds.markCleaned(build.buildId, 'scene_already_absent', at)
      return null
    }
    const reason = `status_failed:${safeErrorCode(error)}`
    builds.markCleanupFailed(build.buildId, reason, at)
    return reason
  }

  const actualBoundary = sceneBoundaryFromStatus(status)
  if (!actualBoundary) {
    builds.markCleanupFailed(build.buildId, 'invalid_scene_boundary', at)
    return 'invalid_scene_boundary'
  }

  if (
    actualBoundary.version !== build.expectedVersion ||
    actualBoundary.graphHash !== build.expectedGraphHash
  ) {
    builds.markCleanupFailed(build.buildId, 'scene_changed_after_abandonment', at)
    return 'scene_changed_after_abandonment'
  }

  try {
    const deleted = toolPayload(await callMcp('delete_scene', {
      id: build.sceneId,
      expectedVersion: build.expectedVersion,
    }))
    if (deleted.deleted !== true) {
      builds.markCleanupFailed(build.buildId, 'delete_not_confirmed', at)
      return 'delete_not_confirmed'
    }
    builds.markCleaned(build.buildId, 'deleted', at)
    return null
  } catch (error) {
    if (isMissingSceneError(error)) {
      builds.markCleaned(build.buildId, 'scene_already_absent', at)
      return null
    }
    const reason = /version_conflict/i.test(errorMessage(error))
      ? 'version_conflict'
      : `delete_failed:${safeErrorCode(error)}`
    builds.markCleanupFailed(build.buildId, reason, at)
    return reason
  }
}

function sceneBoundaryFromStatus(
  status: Record<string, unknown>,
): { version: number; graphHash: string } | undefined {
  const { version, graphHash } = status
  if (!(typeof version === 'number' && Number.isSafeInteger(version) && version > 0)) {
    return undefined
  }
  if (typeof graphHash !== 'string' || graphHash.length === 0) return undefined
  return { version, graphHash }
}

function isMissingSceneError(error: unknown): boolean {
  return /scene_not_found|project_not_found/i.test(errorMessage(error))
}

function safeErrorCode(error: unknown): string {
  return errorMessage(error).replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 80) || 'unknown'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
