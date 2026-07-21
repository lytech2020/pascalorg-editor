import type { Database } from 'bun:sqlite'

export type Migration = {
  version: number
  name: string
  up: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'create_ai_model_calls',
    up: `
      CREATE TABLE ai_model_calls (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        call_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN (
          'extract',
          'modify-ops',
          'inspect',
          'scene-agent',
          'scene-intent',
          'plan:intent',
          'plan:geometry'
        )),
        provider TEXT NOT NULL,
        requested_model TEXT NOT NULL,
        model TEXT,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        status TEXT NOT NULL CHECK (status IN (
          'ok',
          'http_error',
          'network_error',
          'cancelled',
          'invalid_response'
        )),
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        reasoning_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        finish_reason TEXT,
        http_status INTEGER,
        provider_error_code TEXT,
        error_summary TEXT,
        provider_request_id TEXT,
        prompt_version TEXT,
        prompt_hash TEXT NOT NULL,
        request_params TEXT NOT NULL CHECK (json_valid(request_params)),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        UNIQUE (call_id, attempt_no)
      ) STRICT;

      CREATE INDEX ai_model_calls_request_started_idx
        ON ai_model_calls(request_id, started_at);
      CREATE INDEX ai_model_calls_provider_model_started_idx
        ON ai_model_calls(provider, model, started_at);
      CREATE UNIQUE INDEX ai_model_calls_provider_request_idx
        ON ai_model_calls(provider, provider_request_id)
        WHERE provider_request_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: 'create_ai_sessions_messages_requests',
    up: `
      CREATE TABLE ai_sessions (
        session_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0),
        user_id TEXT,
        org_id TEXT,
        project_id TEXT,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE ai_messages (
        session_id TEXT NOT NULL REFERENCES ai_sessions(session_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        message_json TEXT NOT NULL CHECK (json_valid(message_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      ) STRICT;

      CREATE TABLE ai_requests (
        request_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        client_request_id TEXT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'confirm', 'cancel')),
        status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed')),
        scene_id TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX ai_messages_session_sequence_idx
        ON ai_messages(session_id, sequence);
      CREATE INDEX ai_requests_session_started_idx
        ON ai_requests(session_id, started_at);
      CREATE INDEX ai_requests_trace_started_idx
        ON ai_requests(trace_id, started_at);

      CREATE TABLE legacy_session_imports (
        source_path TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        imported_sessions INTEGER NOT NULL CHECK (imported_sessions >= 0),
        skipped_sessions INTEGER NOT NULL CHECK (skipped_sessions >= 0),
        imported_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'turn_ai_requests_into_durable_queue',
    up: `
      DROP INDEX ai_requests_session_started_idx;
      DROP INDEX ai_requests_trace_started_idx;
      ALTER TABLE ai_requests RENAME TO ai_requests_v2;

      CREATE TABLE ai_requests (
        request_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        client_request_id TEXT,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('chat', 'confirm', 'cancel')),
        status TEXT NOT NULL CHECK (status IN (
          'queued', 'running', 'succeeded', 'failed', 'cancelled'
        )),
        scene_id TEXT,
        input_json TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        error_code TEXT,
        owner_instance_id TEXT,
        lease_expires_at TEXT,
        heartbeat_at TEXT,
        run_attempts INTEGER NOT NULL DEFAULT 0 CHECK (run_attempts >= 0),
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;

      INSERT INTO ai_requests (
        request_id, trace_id, client_request_id, session_id, kind, status,
        scene_id, input_json, result_json, error_code, owner_instance_id,
        lease_expires_at, heartbeat_at, run_attempts, queued_at, started_at,
        completed_at
      )
      SELECT
        request_id, trace_id, client_request_id, session_id, kind,
        CASE WHEN status = 'started' THEN 'failed' ELSE status END,
        scene_id, NULL, NULL,
        CASE WHEN status = 'started' THEN 'process_interrupted' ELSE error_code END,
        NULL, NULL, NULL, CASE WHEN status = 'started' THEN 1 ELSE 0 END,
        started_at, started_at,
        CASE WHEN status = 'started' THEN COALESCE(completed_at, started_at) ELSE completed_at END
      FROM ai_requests_v2;

      DROP TABLE ai_requests_v2;

      CREATE INDEX ai_requests_session_queued_idx
        ON ai_requests(session_id, queued_at);
      CREATE INDEX ai_requests_trace_queued_idx
        ON ai_requests(trace_id, queued_at);
      CREATE INDEX ai_requests_queue_idx
        ON ai_requests(status, queued_at);
      CREATE INDEX ai_requests_lease_idx
        ON ai_requests(status, lease_expires_at);
    `,
  },
  {
    version: 4,
    name: 'add_request_idempotency_and_workflow_steps',
    up: `
      ALTER TABLE ai_requests ADD COLUMN idempotency_key TEXT;
      ALTER TABLE ai_requests ADD COLUMN input_hash TEXT;
      ALTER TABLE ai_requests ADD COLUMN idempotency_subject TEXT NOT NULL DEFAULT 'local';

      CREATE UNIQUE INDEX ai_requests_idempotency_scope_idx
        ON ai_requests(idempotency_subject, session_id, kind, COALESCE(scene_id, ''), idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE workflow_steps (
        step_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES ai_requests(request_id),
        session_id TEXT NOT NULL,
        scene_id TEXT,
        operation_key TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        status TEXT NOT NULL CHECK (status IN (
          'running', 'succeeded', 'failed', 'cancelled', 'failed_recoverable'
        )),
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (request_id, operation_key, attempt_no)
      ) STRICT;

      CREATE INDEX workflow_steps_request_started_idx
        ON workflow_steps(request_id, started_at);
      CREATE INDEX workflow_steps_session_started_idx
        ON workflow_steps(session_id, started_at);
    `,
  },
  {
    version: 5,
    name: 'index_running_workflow_steps',
    up: `
      CREATE INDEX workflow_steps_running_request_idx
        ON workflow_steps(request_id)
        WHERE status = 'running';
    `,
  },
]

export function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `)
  database.transaction(() => {
    // Read versions only after acquiring the write lock. Otherwise two
    // processes can both observe an empty migration table before either
    // creates the application tables.
    const applied = new Set(
      (database.query('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map(row => row.version),
    )
    const insertMigration = database.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
    )
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      database.exec(migration.up)
      insertMigration.run(migration.version, migration.name, new Date().toISOString())
    }
  }).immediate()
}
