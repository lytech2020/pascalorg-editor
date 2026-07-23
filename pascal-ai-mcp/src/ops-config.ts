import type { OpsThresholds } from './application/ops-service'

export type OpsConfig = OpsThresholds & {
  checkIntervalMs: number
  alertCooldownMs: number
  queueWarningMs: number
  queueCriticalMs: number
  failureWindowMs: number
  failureMinimumSamples: number
  failureWarningRate: number
  failureCriticalRate: number
}

export function loadOpsConfig(env: NodeJS.ProcessEnv = process.env): OpsConfig {
  const queueWarningMs = positiveInt(env.AI_MCP_OPS_QUEUE_WARNING_MS, 30_000)
  const queueCriticalMs = Math.max(
    queueWarningMs,
    positiveInt(env.AI_MCP_OPS_QUEUE_CRITICAL_MS, 120_000),
  )
  const failureWarningRate = boundedRate(env.AI_MCP_OPS_FAILURE_WARNING_RATE, 0.2)
  const failureCriticalRate = Math.max(
    failureWarningRate,
    boundedRate(env.AI_MCP_OPS_FAILURE_CRITICAL_RATE, 0.5),
  )
  return {
    checkIntervalMs: positiveInt(env.AI_MCP_OPS_CHECK_INTERVAL_MS, 60_000),
    alertCooldownMs: positiveInt(env.AI_MCP_OPS_ALERT_COOLDOWN_MS, 300_000),
    queueWarningMs,
    queueCriticalMs,
    failureWindowMs: positiveInt(env.AI_MCP_OPS_FAILURE_WINDOW_MS, 300_000),
    failureMinimumSamples: positiveInt(env.AI_MCP_OPS_FAILURE_MIN_SAMPLES, 5),
    failureWarningRate,
    failureCriticalRate,
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function boundedRate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}
