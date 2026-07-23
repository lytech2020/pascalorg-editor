import { describe, expect, test } from 'bun:test'
import {
  OpsAlertTracker,
  OpsService,
  type OpsReadinessSnapshot,
  type OpsRequestMetrics,
  type OpsThresholds,
} from './ops-service'
import type { ReadinessReport } from './readiness-service'

const config: OpsThresholds = {
  queueWarningMs: 30_000,
  queueCriticalMs: 120_000,
  failureWindowMs: 300_000,
  failureMinimumSamples: 5,
  failureWarningRate: 0.2,
  failureCriticalRate: 0.5,
}

function readiness(overrides: Partial<ReadinessReport['checks']> = {}): OpsReadinessSnapshot {
  return { reachable: true, report: readinessReport(overrides) }
}

function readinessReport(
  overrides: Partial<ReadinessReport['checks']> = {},
): ReadinessReport {
  return {
    ready: true,
    checks: {
      database: { ready: true },
      checkpoints: { ready: true, graphVersion: 'graph-v1' },
      templates: {
        ready: true,
        files: 15,
        loaded: 15,
        good: 14,
        bad: 1,
        failed: 0,
        acceptsTraffic: true,
      },
      mcp: { ready: true, state: 'ready', generation: 1, failureCount: 0 },
      telemetry: { ready: true, failureCount: 0 },
      modelProvider: { ready: true, configured: true, degraded: false },
      ...overrides,
    },
  }
}

function metrics(overrides: Partial<OpsRequestMetrics> = {}): OpsRequestMetrics {
  return {
    queuedCount: 0,
    expiredRunningLeases: 0,
    recentTerminalCount: 10,
    recentFailureCount: 0,
    failureCodes: [],
    ...overrides,
  }
}

describe('ops service', () => {
  test('reuses readiness and stays healthy when dependencies and queue are healthy', async () => {
    const report = await new OpsService({
      readiness: async () => readiness(),
      metrics: () => metrics(),
    }, config).check(new Date('2026-07-23T10:00:00.000Z'))
    expect(report).toMatchObject({ healthy: true, exitCode: 0, findings: [] })
  })

  test('classifies readiness, queue, lease and failure-rate faults with stable codes', async () => {
    const report = await new OpsService({
      readiness: async () => readiness({
        database: { ready: false },
        checkpoints: { ready: false, graphVersion: 'graph-v1' },
        templates: {
          ...readinessReport().checks.templates,
          ready: false,
          acceptsTraffic: false,
        },
        mcp: {
          ready: false,
          state: 'degraded',
          generation: 2,
          failureCount: 3,
          lastErrorCode: 'private-host-must-not-appear',
        },
        telemetry: { ready: false, failureCount: 4 },
      }),
      metrics: () => metrics({
        queuedCount: 4,
        oldestQueuedAt: '2026-07-23T09:57:00.000Z',
        expiredRunningLeases: 2,
        recentTerminalCount: 10,
        recentFailureCount: 6,
        failureCodes: [{ code: 'model_unavailable', count: 6 }],
      }),
    }, config).check(new Date('2026-07-23T10:00:00.000Z'))
    expect(report.exitCode).toBe(2)
    expect(report.findings.map(finding => finding.reasonCode)).toEqual([
      'checkpoints_unavailable',
      'database_unavailable',
      'mcp_unavailable',
      'queue_wait_critical',
      'request_failure_rate_critical',
      'running_lease_expired',
      'telemetry_degraded',
      'template_library_unavailable',
    ])
    expect(JSON.stringify(report.findings)).not.toContain('private-host')
  })

  test('uses a fixed safe code when readiness or metrics collection fails', async () => {
    const report = await new OpsService({
      readiness: async () => {
        throw new Error('Authorization=secret prompt=user text')
      },
      metrics: () => {
        throw new Error('database path and user text')
      },
    }, config).check()
    expect(report.findings).toEqual([
      { severity: 'critical', reasonCode: 'ops_metrics_unavailable', details: {} },
      { severity: 'critical', reasonCode: 'readiness_check_failed', details: {} },
    ])
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('user text')
  })
})

describe('ops alert tracker', () => {
  test('emits once, cools down, recovers once, then emits on a new fault', () => {
    const tracker = new OpsAlertTracker(60_000)
    const unhealthy = {
      checkedAt: '2026-07-23T10:00:00.000Z',
      healthy: false,
      exitCode: 1 as const,
      readiness: readiness(),
      findings: [{
        severity: 'warning' as const,
        reasonCode: 'queue_wait_high',
        details: { queued: 2 },
      }],
    }
    expect(tracker.update(unhealthy)).toMatchObject([
      { level: 'warning', reasonCode: 'queue_wait_high' },
    ])
    expect(tracker.update(
      { ...unhealthy, checkedAt: '2026-07-23T10:00:30.000Z' },
    )).toEqual([])
    expect(tracker.update(
      { ...unhealthy, checkedAt: '2026-07-23T10:01:01.000Z' },
    )).toMatchObject([{ level: 'warning', reasonCode: 'queue_wait_high' }])
    const healthy = {
      checkedAt: '2026-07-23T10:01:02.000Z',
      healthy: true,
      exitCode: 0 as const,
      readiness: readiness(),
      findings: [],
    }
    expect(tracker.update(healthy)).toMatchObject([
      { level: 'recovered', reasonCode: 'queue_wait_high' },
    ])
    expect(tracker.update(healthy)).toEqual([])
    expect(tracker.update({
      ...unhealthy,
      checkedAt: '2026-07-23T10:01:03.000Z',
    })).toMatchObject([{ level: 'warning', reasonCode: 'queue_wait_high' }])
  })
})
