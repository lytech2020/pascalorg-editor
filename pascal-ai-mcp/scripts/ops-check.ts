import { Database } from 'bun:sqlite'
import { OpsService, type OpsReadinessSnapshot } from '../src/application/ops-service'
import type { ReadinessReport } from '../src/application/readiness-service'
import { loadConfig } from '../src/config'
import { loadOpsConfig } from '../src/ops-config'
import { OpsMetricsRepository } from '../src/persistence/ops-metrics-repository'

const config = loadConfig()
const opsConfig = loadOpsConfig()
let metricsDatabase: Database | undefined
try {
  metricsDatabase = new Database(config.databaseFile, { readonly: true, strict: true })
} catch {
  metricsDatabase = undefined
}

const service = new OpsService({
  readiness: () => readReadiness(config.readinessToken, readinessUrl()),
  metrics: (now, failureWindowMs) => {
    if (!metricsDatabase) throw new Error('ops metrics database unavailable')
    return new OpsMetricsRepository(metricsDatabase).snapshot(now, failureWindowMs)
  },
}, opsConfig)

try {
  const report = await service.check()
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.exitCode
} finally {
  metricsDatabase?.close()
}

function readinessUrl(): string {
  const configured = process.env.AI_MCP_OPS_READY_URL?.trim()
  if (configured) return configured
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host
  return `http://${host}:${config.port}/ready`
}

async function readReadiness(
  token: string | undefined,
  url: string,
): Promise<OpsReadinessSnapshot> {
  if (!token) return { reachable: false, errorCode: 'readiness_token_missing' }
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return { reachable: false, errorCode: 'readiness_endpoint_unreachable' }
  }
  if (response.status === 401) {
    return { reachable: false, errorCode: 'readiness_unauthorized' }
  }
  if (response.status !== 200 && response.status !== 503) {
    return { reachable: false, errorCode: 'readiness_http_error' }
  }
  try {
    const payload: unknown = await response.json()
    const report = parseReadinessReport(payload)
    if (!report) {
      return { reachable: false, errorCode: 'readiness_invalid_response' }
    }
    return { reachable: true, report }
  } catch {
    return { reachable: false, errorCode: 'readiness_invalid_response' }
  }
}

function parseReadinessReport(value: unknown): ReadinessReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const report = value as Record<string, unknown>
  if (typeof report.ready !== 'boolean') return undefined
  const checks = report.checks
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return undefined
  const record = checks as Record<string, unknown>
  const database = objectRecord(record.database)
  const checkpoints = objectRecord(record.checkpoints)
  const templates = objectRecord(record.templates)
  const mcp = objectRecord(record.mcp)
  const telemetry = objectRecord(record.telemetry)
  const modelProvider = objectRecord(record.modelProvider)
  if (!(
    database
    && typeof database.ready === 'boolean'
    && checkpoints
    && typeof checkpoints.ready === 'boolean'
    && typeof checkpoints.graphVersion === 'string'
    && templates
    && typeof templates.ready === 'boolean'
    && typeof templates.acceptsTraffic === 'boolean'
    && mcp
    && typeof mcp.ready === 'boolean'
    && typeof mcp.state === 'string'
    && safeCount(mcp.generation)
    && safeCount(mcp.failureCount)
    && telemetry
    && typeof telemetry.ready === 'boolean'
    && safeCount(telemetry.failureCount)
    && modelProvider
    && modelProvider.ready === true
    && typeof modelProvider.configured === 'boolean'
    && typeof modelProvider.degraded === 'boolean'
  )) return undefined
  if (
    !safeIdentifier(checkpoints.graphVersion)
    || !safeIdentifier(mcp.state)
    || (mcp.lastErrorCode !== undefined && !safeIdentifier(mcp.lastErrorCode))
    || (mcp.nextRetryAt !== undefined && !safeIsoDate(mcp.nextRetryAt))
  ) return undefined
  const templateCounts = ['files', 'loaded', 'good', 'bad', 'failed'] as const
  if (templateCounts.some(key => !safeCount(templates[key]))) return undefined
  return {
    ready: report.ready,
    checks: {
      database: { ready: database.ready },
      checkpoints: {
        ready: checkpoints.ready,
        graphVersion: checkpoints.graphVersion,
      },
      templates: {
        ready: templates.ready,
        files: templates.files as number,
        loaded: templates.loaded as number,
        good: templates.good as number,
        bad: templates.bad as number,
        failed: templates.failed as number,
        acceptsTraffic: templates.acceptsTraffic,
      },
      mcp: {
        ready: mcp.ready,
        state: mcp.state,
        generation: mcp.generation,
        failureCount: mcp.failureCount,
        ...(typeof mcp.lastErrorCode === 'string'
          ? { lastErrorCode: mcp.lastErrorCode }
          : {}),
        ...(typeof mcp.nextRetryAt === 'string' ? { nextRetryAt: mcp.nextRetryAt } : {}),
      },
      telemetry: {
        ready: telemetry.ready,
        failureCount: telemetry.failureCount,
      },
      modelProvider: {
        ready: true,
        configured: modelProvider.configured,
        degraded: modelProvider.degraded,
      },
    },
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function safeIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}
