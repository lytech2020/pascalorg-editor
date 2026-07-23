import type { Database } from 'bun:sqlite'
import type { OpsRequestMetrics } from '../application/ops-service'

type QueueRow = {
  queued_count: number
  oldest_queued_at: string | null
  expired_running_leases: number
}

type OutcomeRow = {
  status: 'succeeded' | 'failed' | 'cancelled'
  error_code: string | null
  count: number
}

export class OpsMetricsRepository {
  constructor(private readonly database: Database) {}

  snapshot(now: Date, failureWindowMs: number): OpsRequestMetrics {
    const nowIso = now.toISOString()
    const queue = this.database.query(`
      SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued_count,
        MIN(CASE WHEN status = 'queued' THEN queued_at END) AS oldest_queued_at,
        SUM(CASE
          WHEN status = 'running'
            AND owner_instance_id LIKE 'worker:%'
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          THEN 1 ELSE 0
        END) AS expired_running_leases
      FROM ai_requests
    `).get(nowIso) as QueueRow
    const since = new Date(now.getTime() - failureWindowMs).toISOString()
    const outcomes = this.database.query(`
      SELECT status, error_code, COUNT(*) AS count
      FROM ai_requests
      WHERE completed_at >= ?
        AND execution_source = 'worker'
        AND status IN ('succeeded', 'failed', 'cancelled')
      GROUP BY status, error_code
      ORDER BY status, error_code
    `).all(since) as OutcomeRow[]
    const failureCodes = new Map<string, number>()
    let recentTerminalCount = 0
    let recentFailureCount = 0
    for (const outcome of outcomes) {
      recentTerminalCount += outcome.count
      if (outcome.status !== 'failed') continue
      recentFailureCount += outcome.count
      const code = safeReasonCode(outcome.error_code)
      failureCodes.set(code, (failureCodes.get(code) ?? 0) + outcome.count)
    }
    return {
      queuedCount: queue.queued_count ?? 0,
      ...(queue.oldest_queued_at ? { oldestQueuedAt: queue.oldest_queued_at } : {}),
      expiredRunningLeases: queue.expired_running_leases ?? 0,
      recentTerminalCount,
      recentFailureCount,
      failureCodes: [...failureCodes]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
        .slice(0, 10),
    }
  }
}

function safeReasonCode(value: string | null): string {
  return value && /^[a-z0-9._:-]{1,64}$/i.test(value) ? value : 'unknown_error'
}
