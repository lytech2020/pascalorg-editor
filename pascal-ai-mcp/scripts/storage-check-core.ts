export type StorageSeverity = 'healthy' | 'warning' | 'critical'

export type DiskThresholds = {
  warningPercent: number
  criticalPercent: number
}

export function parseDiskThresholds(input: {
  warning?: string
  critical?: string
}): DiskThresholds {
  const warningPercent = parsePercent(input.warning, 70)
  const criticalPercent = parsePercent(input.critical, 85)
  if (warningPercent >= criticalPercent) {
    throw new Error('disk warning threshold must be lower than critical threshold')
  }
  return { warningPercent, criticalPercent }
}

export function classifyDiskUsage(
  usedPercent: number,
  thresholds: DiskThresholds,
): StorageSeverity {
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error('disk usage must be between 0 and 100')
  }
  if (usedPercent >= thresholds.criticalPercent) return 'critical'
  if (usedPercent >= thresholds.warningPercent) return 'warning'
  return 'healthy'
}

export function storageExitCode(severities: StorageSeverity[]): 0 | 1 | 2 {
  if (severities.includes('critical')) return 2
  if (severities.includes('warning')) return 1
  return 0
}

function parsePercent(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new Error('disk threshold must be greater than 0 and lower than 100')
  }
  return parsed
}
