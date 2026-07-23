import { describe, expect, test } from 'bun:test'
import {
  classifyDiskUsage,
  parseDiskThresholds,
  storageExitCode,
} from './storage-check-core'

describe('storage growth policy', () => {
  test('uses the documented 70/85 percent thresholds', () => {
    const thresholds = parseDiskThresholds({})
    expect(thresholds).toEqual({ warningPercent: 70, criticalPercent: 85 })
    expect(classifyDiskUsage(69.99, thresholds)).toBe('healthy')
    expect(classifyDiskUsage(70, thresholds)).toBe('warning')
    expect(classifyDiskUsage(85, thresholds)).toBe('critical')
  })

  test('rejects an inverted policy instead of weakening the critical boundary', () => {
    expect(() => parseDiskThresholds({ warning: '90', critical: '80' })).toThrow(
      'warning threshold must be lower',
    )
  })

  test('maps warning and critical storage state to scheduler-friendly exit codes', () => {
    expect(storageExitCode(['healthy'])).toBe(0)
    expect(storageExitCode(['healthy', 'warning'])).toBe(1)
    expect(storageExitCode(['warning', 'critical'])).toBe(2)
  })
})
