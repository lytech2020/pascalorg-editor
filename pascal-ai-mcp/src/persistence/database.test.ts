import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from './database'

describe('AppDatabase migrations', () => {
  test('applies migrations once and remains safe to reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-db-'))
    const file = join(dir, 'ai.db')
    try {
      const first = new AppDatabase(file)
      expect(
        first.connection.query('SELECT version, name FROM schema_migrations').all(),
      ).toEqual([
        { version: 1, name: 'create_ai_model_calls' },
        { version: 2, name: 'create_ai_sessions_messages_requests' },
        { version: 3, name: 'turn_ai_requests_into_durable_queue' },
        { version: 4, name: 'add_request_idempotency_and_workflow_steps' },
        { version: 5, name: 'index_running_workflow_steps' },
        { version: 6, name: 'track_fresh_scene_build_lifecycle' },
        { version: 7, name: 'add_langgraph_workflow_checkpoints' },
        { version: 8, name: 'add_tool_scene_validation_audit' },
        { version: 9, name: 'add_private_request_artifacts' },
        { version: 10, name: 'add_scope_guardrail_audit' },
        { version: 11, name: 'add_ai_scene_space_semantics' },
        { version: 12, name: 'add_template_match_audit' },
        { version: 13, name: 'add_modification_mode_to_workflow_steps' },
        { version: 14, name: 'track_request_execution_source' },
      ])
      expect(
        first.connection.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_model_calls'").get(),
      ).toEqual({ name: 'ai_model_calls' })
      first.close()

      const reopened = new AppDatabase(file)
      expect(
        reopened.connection.query('SELECT COUNT(*) AS count FROM schema_migrations').get(),
      ).toEqual({ count: 14 })
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rolls back work when a shared transaction fails', () => {
    const database = new AppDatabase(':memory:')
    try {
      expect(() => database.transaction(() => {
        database.connection.exec('CREATE TABLE transaction_probe (id INTEGER) STRICT;')
        throw new Error('rollback')
      })).toThrow('rollback')
      expect(
        database.connection.query("SELECT name FROM sqlite_master WHERE name = 'transaction_probe'").get(),
      ).toBeNull()
    } finally {
      database.close()
    }
  })

  test('readiness verifies a real SQLite write transaction', () => {
    const database = new AppDatabase(':memory:')
    expect(database.isWritable()).toBe(true)
    database.close()
    expect(database.isWritable()).toBe(false)
  })

  test('orphan recovery scans only the partial running-step index', () => {
    const database = new AppDatabase(':memory:')
    try {
      const plan = database.connection.query(`
        EXPLAIN QUERY PLAN
        UPDATE workflow_steps
        SET status = 'failed_recoverable', completed_at = ?
        WHERE status = 'running'
          AND EXISTS (
            SELECT 1 FROM ai_requests AS request
            WHERE request.request_id = workflow_steps.request_id
              AND request.status IN ('succeeded', 'failed', 'cancelled')
          )
      `).all('2026-07-21T00:00:00.000Z') as Array<{ detail: string }>
      expect(plan.some(row => row.detail.includes('workflow_steps_running_request_idx'))).toBe(true)
      expect(plan.some(row => row.detail === 'SCAN workflow_steps')).toBe(false)
    } finally {
      database.close()
    }
  })
})
