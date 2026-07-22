import type { AiAuditWriter, AuditIdentity } from '../persistence/audit-repository'

// This list is the AI-side scene-change classifier. Any new write-capable
// MCP tool must be added here before the agent is allowed to call it.
const MUTATING_TOOL_NAMES = new Set([
  'add_door',
  'add_window',
  'apply_patch',
  'create_house_from_brief',
  'create_level',
  'create_room',
  'create_story_shell',
  'delete_node',
  'furnish_room',
  'place_item',
  'save_scene',
  'set_zone',
  'undo',
])

const MAX_TRACKED_IDENTITIES = 1_024

const SCENE_ID_ARGUMENT_TOOLS = new Set([
  'get_project_status',
  'load_scene',
  'save_scene',
])

export type AuditedToolIdentity = AuditIdentity & {
  sceneId?: string
}

export class AiOperationAuditor {
  private readonly sceneVersions = new Map<string, number>()
  private readonly sessionScenes = new Map<string, string>()

  constructor(private readonly writer: AiAuditWriter) {}

  async callTool(
    identity: AuditedToolIdentity,
    toolName: string,
    args: Record<string, unknown>,
    invoke: () => Promise<unknown>,
  ): Promise<unknown> {
    const mutating = MUTATING_TOOL_NAMES.has(toolName)
    const auditToolName = safeIdentifier(toolName) ?? 'invalid_tool_name'
    const sceneIdBefore = identity.sceneId
      ?? this.sessionScenes.get(identity.sessionId)
      ?? sceneIdFromArgs(toolName, args)
    const beforeVersion = sceneIdBefore ? this.sceneVersions.get(sceneIdBefore) : undefined
    const auditId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const started = performance.now()
    this.writer.startToolCall({
      ...identity,
      ...(sceneIdBefore ? { sceneId: sceneIdBefore } : {}),
      auditId,
      toolName: auditToolName,
      mutating,
      argsSummary: summarizeToolArgs(args),
      startedAt,
    })
    try {
      const result = await invoke()
      const payload = responsePayload(result)
      const sceneIdAfter = sceneIdBefore ?? sceneIdFromPayload(payload)
      const afterVersion = finiteInteger(payload.version)
      if (sceneIdAfter && afterVersion !== undefined) {
        rememberBounded(this.sceneVersions, sceneIdAfter, afterVersion)
      }
      if (sceneIdAfter) rememberBounded(this.sessionScenes, identity.sessionId, sceneIdAfter)
      this.finish(auditId, 'succeeded', started, undefined, sceneIdAfter)
      if (mutating) {
        this.recordSceneChange(
          identity,
          auditId,
          auditToolName,
          sceneIdAfter,
          beforeVersion,
          afterVersion,
          args,
        )
      }
      return result
    } catch (error) {
      const cancelled = isCancellation(error)
      this.finish(
        auditId,
        cancelled ? 'cancelled' : 'failed',
        started,
        auditErrorCode(error),
        sceneIdBefore,
      )
      throw error
    }
  }

  versionFor(sceneId: string | undefined): number | undefined {
    return sceneId ? this.sceneVersions.get(sceneId) : undefined
  }

  sceneFor(sessionId: string): string | undefined {
    return this.sessionScenes.get(sessionId)
  }

  recordValidation(
    identity: AuditedToolIdentity,
    validator: string,
    status: 'passed' | 'failed' | 'unavailable',
    issueCount: number,
    summary: Record<string, unknown>,
    repairRound?: number,
  ): void {
    const sceneId = identity.sceneId ?? this.sessionScenes.get(identity.sessionId)
    try {
      this.writer.recordValidation({
        ...identity,
        ...(sceneId ? { sceneId } : {}),
        validationId: crypto.randomUUID(),
        validator,
        status,
        ...(sceneId && this.sceneVersions.get(sceneId) !== undefined
          ? { validatedVersion: this.sceneVersions.get(sceneId) }
          : {}),
        ...(repairRound !== undefined ? { repairRound } : {}),
        issueCount,
        summary: sanitizeValidationSummary(summary),
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error(
        `[req ${identity.requestId}] validation audit ${validator} failed: ${safeErrorName(error)}`,
      )
    }
  }

  private finish(
    auditId: string,
    status: 'succeeded' | 'failed' | 'cancelled',
    started: number,
    errorCode?: string,
    sceneId?: string,
  ): void {
    try {
      if (!this.writer.finishToolCall(
        auditId,
        status,
        new Date().toISOString(),
        performance.now() - started,
        errorCode,
        sceneId,
      )) {
        console.warn(`tool audit ${auditId} was no longer running at completion`)
      }
    } catch (error) {
      console.error(`tool audit ${auditId} completion failed: ${safeErrorName(error)}`)
    }
  }

  private recordSceneChange(
    identity: AuditedToolIdentity,
    toolCallAuditId: string,
    toolName: string,
    sceneId: string | undefined,
    beforeVersion: number | undefined,
    afterVersion: number | undefined,
    args: Record<string, unknown>,
  ): void {
    try {
      this.writer.recordSceneChange({
        ...identity,
        ...(sceneId ? { sceneId } : {}),
        changeId: crypto.randomUUID(),
        toolCallAuditId,
        changeType: toolName,
        ...(beforeVersion !== undefined ? { beforeVersion } : {}),
        ...(afterVersion !== undefined ? { afterVersion } : {}),
        nodeCount: affectedNodeCount(toolName, args),
        summary: {
          beforeVersionKnown: beforeVersion !== undefined,
          afterVersionKnown: afterVersion !== undefined,
        },
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error(`scene change audit for ${toolName} failed: ${safeErrorName(error)}`)
    }
  }
}

export function summarizeToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(args)
  const safeEntries = entries.filter(([key]) => safeIdentifier(key) !== undefined)
  const keys = safeEntries.map(([key]) => key).sort()
  const arrayLengths: Record<string, number> = {}
  const objectKeyCounts: Record<string, number> = {}
  for (const [key, value] of safeEntries) {
    if (Array.isArray(value)) arrayLengths[key] = value.length
    else if (isRecord(value)) objectKeyCounts[key] = Object.keys(value).length
  }
  return {
    keys,
    ...(safeEntries.length < entries.length ? { invalidKeyCount: entries.length - safeEntries.length } : {}),
    ...(Object.keys(arrayLengths).length > 0 ? { arrayLengths } : {}),
    ...(Object.keys(objectKeyCounts).length > 0 ? { objectKeyCounts } : {}),
  }
}

function affectedNodeCount(toolName: string, args: Record<string, unknown>): number {
  for (const key of ['patches', 'nodes', 'items']) {
    const value = args[key]
    if (Array.isArray(value)) return value.length
  }
  if (toolName === 'undo') {
    const steps = finiteInteger(args.steps)
    return steps ?? 0
  }
  return 1
}

function sceneIdFromArgs(toolName: string, args: Record<string, unknown>): string | undefined {
  const projectId = nonEmptyString(args.projectId)
  if (projectId) return projectId
  return SCENE_ID_ARGUMENT_TOOLS.has(toolName) ? nonEmptyString(args.id) : undefined
}

function sceneIdFromPayload(payload: Record<string, unknown>): string | undefined {
  return nonEmptyString(payload.projectId)
    ?? nonEmptyString(payload.sceneId)
}

function responsePayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  if (isRecord(value.structuredContent)) return value.structuredContent
  if (Array.isArray(value.content)) {
    const text = value.content.find(block => isRecord(block) && block.type === 'text')
    if (isRecord(text) && typeof text.text === 'string') {
      try {
        const parsed = JSON.parse(text.text)
        return isRecord(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }
  }
  return value
}

function auditErrorCode(error: unknown): string {
  if (isCancellation(error)) return 'cancelled'
  if (error instanceof Error) {
    if (/timeout/i.test(error.name) || /timed?\s*out/i.test(error.message)) return 'timeout'
    if (/econnrefused|connection refused/i.test(error.message)) return 'connection_refused'
  }
  return 'mcp_error'
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError'
      || error.name === 'GenerationCancelledError'
      || /\b(cancelled|canceled|aborted)\b/i.test(error.message))
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error'
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeIdentifier(value: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : undefined
}

function sanitizeValidationSummary(summary: Record<string, unknown>): Record<string, unknown> {
  let droppedValueCount = 0
  let truncatedValueCount = 0
  const result: Record<string, unknown> = {}
  const safeValue = (value: unknown): string | number | boolean | Array<string | number | boolean> | undefined => {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') return safeIdentifier(value)
    if (!Array.isArray(value)) return undefined
    if (value.length > 100) truncatedValueCount += value.length - 100
    const items: Array<string | number | boolean> = []
    for (const item of value.slice(0, 100)) {
      const sanitized = typeof item === 'string'
        ? safeIdentifier(item)
        : typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean'
          ? item
          : undefined
      if (sanitized === undefined) droppedValueCount++
      else items.push(sanitized)
    }
    return items
  }
  for (const [key, value] of Object.entries(summary)) {
    const safeKey = safeIdentifier(key)
    const sanitized = safeValue(value)
    if (!safeKey || sanitized === undefined) {
      droppedValueCount++
      continue
    }
    result[safeKey] = sanitized
  }
  if (droppedValueCount > 0) result.droppedValueCount = droppedValueCount
  if (truncatedValueCount > 0) result.truncatedValueCount = truncatedValueCount
  return result
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_TRACKED_IDENTITIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
    ? value
    : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
