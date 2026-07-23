#!/usr/bin/env bun

import { Database } from 'bun:sqlite'
import {
  existsSync,
  readdirSync,
  statfsSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  classifyDiskUsage,
  parseDiskThresholds,
  storageExitCode,
  type StorageSeverity,
} from './storage-check-core'

const databaseFile = resolve(
  process.env.AI_MCP_DATABASE_FILE?.trim() || './.data/ai.db',
)
const artifactsDir = resolve(
  process.env.AI_MCP_REQUEST_ARTIFACTS_DIR?.trim() || './.data/request-artifacts',
)

try {
  const thresholds = parseDiskThresholds({
    warning: process.env.AI_MCP_DISK_WARNING_PERCENT,
    critical: process.env.AI_MCP_DISK_CRITICAL_PERCENT,
  })
  const fileSystem = statfsSync(dirname(databaseFile))
  const totalBytes = fileSystem.blocks * fileSystem.bsize
  const availableBytes = fileSystem.bavail * fileSystem.bsize
  const usedPercent = totalBytes === 0
    ? 100
    : Math.round((1 - availableBytes / totalBytes) * 10_000) / 100
  const severities: StorageSeverity[] = [
    classifyDiskUsage(usedPercent, thresholds),
  ]
  const database = databaseSummary(databaseFile)
  if (database.status !== 'available') severities.push('warning')
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    severity: severityFor(severities),
    disk: {
      usedPercent,
      totalBytes,
      availableBytes,
      thresholds,
    },
    storage: {
      databaseBytes: existsSync(databaseFile) ? statSync(databaseFile).size : null,
      artifactsBytes: existsSync(artifactsDir) ? directorySize(artifactsDir) : null,
    },
    database,
    policy: {
      auditDeletionAllowed: false,
      artifactCleanupCommand: 'bun run data:cleanup',
      abandonedSceneCleanupCommand: 'bun run scenes:cleanup',
    },
  }
  console.log(JSON.stringify(report))
  process.exit(storageExitCode(severities))
} catch (error) {
  console.error(JSON.stringify({
    event: 'storage_check_invalid',
    errorCode: 'storage_check_failed',
    message: error instanceof Error ? error.message : 'unknown error',
  }))
  process.exit(2)
}

function databaseSummary(file: string): {
  status: 'available' | 'missing' | 'unreadable'
  schemaVersion: number | null
  auditRows: Record<string, number>
} {
  if (!existsSync(file)) return { status: 'missing', schemaVersion: null, auditRows: {} }
  try {
    const database = new Database(file, { readonly: true, strict: true })
    try {
      const schema = database.query(
        'SELECT MAX(version) AS version FROM schema_migrations',
      ).get() as { version: number | null }
      const tableNames = [
        'ai_model_calls',
        'ai_tool_calls',
        'ai_scene_changes',
        'ai_validation_results',
        'workflow_steps',
        'guardrail_events',
      ]
      const auditRows: Record<string, number> = {}
      for (const table of tableNames) {
        const exists = database.query(
          "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ?",
        ).get(table)
        if (!exists) continue
        const count = database.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number
        }
        auditRows[table] = count.count
      }
      return {
        status: 'available',
        schemaVersion: schema.version,
        auditRows,
      }
    } finally {
      database.close()
    }
  } catch {
    return { status: 'unreadable', schemaVersion: null, auditRows: {} }
  }
}

function directorySize(directory: string): number {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += directorySize(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}

function severityFor(severities: StorageSeverity[]): StorageSeverity {
  if (severities.includes('critical')) return 'critical'
  if (severities.includes('warning')) return 'warning'
  return 'healthy'
}
