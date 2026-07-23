import type { ReadinessReport } from './readiness-service'

export type OpsRequestMetrics = {
  queuedCount: number
  oldestQueuedAt?: string
  expiredRunningLeases: number
  recentTerminalCount: number
  recentFailureCount: number
  failureCodes: Array<{ code: string; count: number }>
}

export type OpsThresholds = {
  queueWarningMs: number
  queueCriticalMs: number
  failureWindowMs: number
  failureMinimumSamples: number
  failureWarningRate: number
  failureCriticalRate: number
}

export type OpsSeverity = 'warning' | 'critical'

export type OpsFinding = {
  severity: OpsSeverity
  reasonCode: string
  details: Record<string, string | number | boolean>
}

export type OpsReadinessSnapshot =
  | { reachable: true; report: ReadinessReport }
  | { reachable: false; errorCode: string }

export type OpsReport = {
  checkedAt: string
  healthy: boolean
  exitCode: 0 | 1 | 2
  readiness: OpsReadinessSnapshot
  metrics?: OpsRequestMetrics & {
    oldestQueuedAgeMs: number
    recentFailureRate: number
  }
  findings: OpsFinding[]
}

export type OpsDependencies = {
  readiness: () => Promise<OpsReadinessSnapshot>
  metrics: (now: Date, failureWindowMs: number) => OpsRequestMetrics
}

export class OpsService {
  constructor(
    private readonly dependencies: OpsDependencies,
    private readonly config: OpsThresholds,
  ) {}

  async check(now = new Date()): Promise<OpsReport> {
    const findings: OpsFinding[] = []
    const readiness = await this.readiness(findings)
    let metrics: OpsReport['metrics']
    try {
      const snapshot = this.dependencies.metrics(now, this.config.failureWindowMs)
      const oldestQueuedAgeMs = snapshot.oldestQueuedAt
        ? Math.max(0, now.getTime() - Date.parse(snapshot.oldestQueuedAt))
        : 0
      const recentFailureRate = snapshot.recentTerminalCount > 0
        ? snapshot.recentFailureCount / snapshot.recentTerminalCount
        : 0
      metrics = { ...snapshot, oldestQueuedAgeMs, recentFailureRate }
      this.addQueueFindings(findings, metrics)
    } catch {
      findings.push({
        severity: 'critical',
        reasonCode: 'ops_metrics_unavailable',
        details: {},
      })
    }
    findings.sort((a, b) => a.reasonCode.localeCompare(b.reasonCode))
    const exitCode = findings.some(finding => finding.severity === 'critical')
      ? 2
      : findings.length > 0 ? 1 : 0
    return {
      checkedAt: now.toISOString(),
      healthy: exitCode === 0,
      exitCode,
      readiness,
      ...(metrics ? { metrics } : {}),
      findings,
    }
  }

  private async readiness(findings: OpsFinding[]): Promise<OpsReadinessSnapshot> {
    let snapshot: OpsReadinessSnapshot
    try {
      snapshot = await this.dependencies.readiness()
    } catch {
      snapshot = { reachable: false, errorCode: 'readiness_check_failed' }
    }
    if (!snapshot.reachable) {
      findings.push({
        severity: 'critical',
        reasonCode: safeReasonCode(snapshot.errorCode, 'readiness_unavailable'),
        details: {},
      })
      return snapshot
    }
    const { checks } = snapshot.report
    if (!checks.database.ready) addCritical(findings, 'database_unavailable')
    if (!checks.checkpoints.ready) addCritical(findings, 'checkpoints_unavailable')
    if (!checks.templates.acceptsTraffic) addCritical(findings, 'template_library_unavailable')
    if (!checks.mcp.ready) {
      findings.push({
        severity: 'critical',
        reasonCode: 'mcp_unavailable',
        details: {
          state: safeReasonCode(checks.mcp.state, 'unknown'),
          failures: checks.mcp.failureCount,
        },
      })
    }
    if (!checks.telemetry.ready) {
      findings.push({
        severity: 'critical',
        reasonCode: 'telemetry_degraded',
        details: { failures: checks.telemetry.failureCount },
      })
    }
    if (checks.modelProvider.degraded) {
      findings.push({
        severity: 'warning',
        reasonCode: 'model_provider_unconfigured',
        details: {},
      })
    }
    return snapshot
  }

  private addQueueFindings(
    findings: OpsFinding[],
    metrics: NonNullable<OpsReport['metrics']>,
  ): void {
    if (metrics.oldestQueuedAgeMs >= this.config.queueCriticalMs) {
      findings.push({
        severity: 'critical',
        reasonCode: 'queue_wait_critical',
        details: {
          queued: metrics.queuedCount,
          oldestQueuedAgeMs: metrics.oldestQueuedAgeMs,
        },
      })
    } else if (metrics.oldestQueuedAgeMs >= this.config.queueWarningMs) {
      findings.push({
        severity: 'warning',
        reasonCode: 'queue_wait_high',
        details: {
          queued: metrics.queuedCount,
          oldestQueuedAgeMs: metrics.oldestQueuedAgeMs,
        },
      })
    }
    if (metrics.expiredRunningLeases > 0) {
      findings.push({
        severity: 'critical',
        reasonCode: 'running_lease_expired',
        details: { count: metrics.expiredRunningLeases },
      })
    }
    if (metrics.recentTerminalCount < this.config.failureMinimumSamples) return
    if (metrics.recentFailureRate >= this.config.failureCriticalRate) {
      findings.push({
        severity: 'critical',
        reasonCode: 'request_failure_rate_critical',
        details: failureDetails(metrics),
      })
    } else if (metrics.recentFailureRate >= this.config.failureWarningRate) {
      findings.push({
        severity: 'warning',
        reasonCode: 'request_failure_rate_high',
        details: failureDetails(metrics),
      })
    }
  }
}

export type OpsAlertEvent = {
  level: OpsSeverity | 'recovered'
  event: 'ops_alert'
  reasonCode: string
  at: string
  details: Record<string, string | number | boolean>
}

type ActiveAlert = {
  severity: OpsSeverity
  lastEmittedAtMs: number
}

export class OpsAlertTracker {
  private readonly active = new Map<string, ActiveAlert>()

  constructor(private readonly cooldownMs: number) {}

  update(report: OpsReport, now = new Date(report.checkedAt)): OpsAlertEvent[] {
    const events: OpsAlertEvent[] = []
    const current = new Map(report.findings.map(finding => [finding.reasonCode, finding]))
    for (const finding of report.findings) {
      const previous = this.active.get(finding.reasonCode)
      if (
        !previous
        || previous.severity !== finding.severity
        || now.getTime() - previous.lastEmittedAtMs >= this.cooldownMs
      ) {
        events.push({
          level: finding.severity,
          event: 'ops_alert',
          reasonCode: finding.reasonCode,
          at: now.toISOString(),
          details: finding.details,
        })
        this.active.set(finding.reasonCode, {
          severity: finding.severity,
          lastEmittedAtMs: now.getTime(),
        })
      }
    }
    for (const [reasonCode] of this.active) {
      if (current.has(reasonCode)) continue
      events.push({
        level: 'recovered',
        event: 'ops_alert',
        reasonCode,
        at: now.toISOString(),
        details: {},
      })
      this.active.delete(reasonCode)
    }
    return events.sort((a, b) => a.reasonCode.localeCompare(b.reasonCode))
  }
}

function addCritical(findings: OpsFinding[], reasonCode: string): void {
  findings.push({ severity: 'critical', reasonCode, details: {} })
}

function failureDetails(
  metrics: NonNullable<OpsReport['metrics']>,
): Record<string, string | number | boolean> {
  return {
    terminal: metrics.recentTerminalCount,
    failed: metrics.recentFailureCount,
    ratePermille: Math.round(metrics.recentFailureRate * 1_000),
    errorKinds: metrics.failureCodes.length,
  }
}

function safeReasonCode(value: string, fallback: string): string {
  return /^[a-z0-9._:-]{1,64}$/i.test(value) ? value : fallback
}
