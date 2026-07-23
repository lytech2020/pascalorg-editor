import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const INTERNAL_DEPLOYMENT_EVIDENCE_KINDS = [
  'provider',
  'browser',
  'startup',
  'rollback',
] as const

export type InternalDeploymentEvidenceKind =
  typeof INTERNAL_DEPLOYMENT_EVIDENCE_KINDS[number]

export type InternalDeploymentOptions = {
  allowDirty: boolean
  automatedOnly: boolean
  evidenceDir?: string
  only: string[]
}

export type InternalDeploymentCheck = {
  id: `E${number}`
  title: string
  commands: string[][]
  evidence: Array<{
    scenario: string
    test: string
    requestId?: string
    sessionId?: string
  }>
}

export type ExternalEvidence = {
  schemaVersion: 1
  kind: InternalDeploymentEvidenceKind
  commit: string
  executedAt: string
  ok: true
  notes: string
}

export function internalDeploymentDecision(input: {
  automatedPassed: boolean
  dirty: boolean
  fullCheckSet: boolean
  external: ReturnType<typeof readExternalEvidence>
}): {
  go: boolean
  blockers: string[]
} {
  const blockers = [
    ...input.external.missing.map(kind => `missing_${kind}_evidence`),
    ...input.external.invalid.map(item => `invalid_${item.kind}_evidence:${item.reason}`),
    ...(input.dirty ? ['dirty_worktree'] : []),
    ...(input.fullCheckSet ? [] : ['partial_automated_check_set']),
    ...(input.automatedPassed ? [] : ['automated_check_failed']),
  ]
  return {
    go: input.automatedPassed
      && !input.dirty
      && input.fullCheckSet
      && input.external.missing.length === 0
      && input.external.invalid.length === 0,
    blockers,
  }
}

export const INTERNAL_DEPLOYMENT_CHECKS: InternalDeploymentCheck[] = [
  {
    id: 'E3',
    title: 'Session and checkpoint recovery',
    commands: [[
      'bun',
      'test',
      '--max-concurrency=1',
      'src/durable-workflow.test.ts',
      'src/durable-agent.integration.test.ts',
      'src/request-worker.test.ts',
    ]],
    evidence: [
      {
        scenario: 'checkpoint interrupt survives database reopen',
        test: 'durable-workflow: parks at an interrupt and resumes',
        requestId: 'request-1/request-2',
        sessionId: 'session-1',
      },
      {
        scenario: 'only a verified plan boundary is safely requeued',
        test: 'durable-agent: expired recovery directly enforces the safe plan boundary',
        requestId: 'req-safe/req-scene/req-unsafe',
        sessionId: 'session-safe/session-scene/session-unsafe',
      },
      {
        scenario: 'queued work survives process reconstruction and reaches a terminal state',
        test: 'request-worker: restarted worker executes persisted work',
      },
    ],
  },
  {
    id: 'E4',
    title: 'Dependency degradation and recovery',
    commands: [[
      'bun',
      'test',
      '--max-concurrency=1',
      'src/mcp.test.ts',
      'src/openai-compatible.test.ts',
      'src/application/readiness-service.test.ts',
      'src/application/ops-service.test.ts',
      'scripts/ops-check.integration.test.ts',
      'src/server.integration.test.ts',
    ]],
    evidence: [
      {
        scenario: 'MCP exits, readiness degrades, reconnect recovers without replaying a write',
        test: 'mcp + server integration tests',
      },
      {
        scenario: 'database, template and telemetry failures use stable degraded codes',
        test: 'readiness-service + ops-service tests',
      },
      {
        scenario: 'model cancellation and network failure do not become false success',
        test: 'openai-compatible attempt telemetry tests',
      },
    ],
  },
  {
    id: 'E5',
    title: 'Concurrency, queueing and backpressure',
    commands: [[
      'bun',
      'test',
      '--max-concurrency=1',
      'src/request-worker.test.ts',
      'src/server.integration.test.ts',
    ]],
    evidence: [
      {
        scenario: 'two processes submit one idempotency key and create one request',
        test: 'request-worker: two processes submitting the same key concurrently',
      },
      {
        scenario: 'same-session work is serialized while cancel remains highest priority',
        test: 'request-worker: claiming prioritizes cancel and serializes session or scene',
      },
      {
        scenario: 'queue depth returns the configured backpressure result',
        test: 'request-worker: enforces queue depth',
      },
    ],
  },
  {
    id: 'E6',
    title: 'Stopped-data backup and rollback',
    commands: [[
      'bun',
      'test',
      '--max-concurrency=1',
      'scripts/stopped-data-backup.test.ts',
    ]],
    evidence: [
      {
        scenario: 'stopped SQLite and artifacts are checksummed, upgraded, then restored to an empty target',
        test: 'stopped-data-backup test',
      },
    ],
  },
  {
    id: 'E7',
    title: 'Log and storage growth controls',
    commands: [[
      'bun',
      'test',
      '--max-concurrency=1',
      'scripts/storage-check.test.ts',
    ]],
    evidence: [
      {
        scenario: 'disk thresholds and audit growth are classified without deleting data',
        test: 'storage-check tests',
      },
    ],
  },
  {
    id: 'E8',
    title: 'AI CRUD deterministic acceptance',
    commands: [
      [
        'bun',
        'test',
        '--max-concurrency=1',
        'scripts/crud-matrix.test.ts',
        'src/domain/modification-mode.test.ts',
        'src/domain/local-patch-scope.test.ts',
        'src/modify-ops.test.ts',
        'src/furniture-modify.test.ts',
        'src/application/modify-service.test.ts',
        'src/application/existing-scene-service.test.ts',
        'src/scene-executor.test.ts',
        'eval/assertions.test.ts',
        'eval/evaluate-run.test.ts',
      ],
      ['bun', 'run', 'eval:deterministic'],
    ],
    evidence: [
      {
        scenario: 'create, rename, resize and remove rooms follow plan-first boundaries',
        test: 'modify ops + deterministic eval cases 13/14/19/20/21/24',
      },
      {
        scenario: 'add, remove and replace furniture stay inside local-patch scope',
        test: 'furniture modify + deterministic eval cases 16/17/18',
      },
      {
        scenario: 'unsupported direct opening edits are rejected instead of entering free-form writes',
        test: 'modification-mode unknown operation regression',
      },
      {
        scenario: 'read-only inspection is separated from mutating tool execution',
        test: 'agent and evaluation assertion contracts',
      },
    ],
  },
]

export function parseInternalDeploymentArgs(args: string[]): InternalDeploymentOptions {
  let allowDirty = false
  let automatedOnly = false
  let evidenceDir: string | undefined
  let only: string[] = []
  for (const arg of args) {
    if (arg === '--') continue
    if (arg === '--allow-dirty') {
      allowDirty = true
      continue
    }
    if (arg === '--automated-only') {
      automatedOnly = true
      continue
    }
    if (arg.startsWith('--evidence-dir=')) {
      evidenceDir = resolve(arg.slice('--evidence-dir='.length))
      continue
    }
    if (arg.startsWith('--only=')) {
      only = [...new Set(
        arg.slice('--only='.length).split(',').map(value => value.trim().toUpperCase()).filter(Boolean),
      )]
      continue
    }
    throw new Error(`unknown internal deployment argument: ${arg}`)
  }
  const knownIds = new Set(INTERNAL_DEPLOYMENT_CHECKS.map(check => check.id))
  for (const id of only) {
    if (!knownIds.has(id as InternalDeploymentCheck['id'])) {
      throw new Error(`unknown internal deployment check: ${id}`)
    }
  }
  return { allowDirty, automatedOnly, evidenceDir, only }
}

export function selectedInternalDeploymentChecks(
  options: InternalDeploymentOptions,
): InternalDeploymentCheck[] {
  if (options.only.length === 0) return INTERNAL_DEPLOYMENT_CHECKS
  const selected = new Set(options.only)
  return INTERNAL_DEPLOYMENT_CHECKS.filter(check => selected.has(check.id))
}

export function readExternalEvidence(
  directory: string | undefined,
  commit: string,
): {
  accepted: ExternalEvidence[]
  missing: InternalDeploymentEvidenceKind[]
  invalid: Array<{ kind: InternalDeploymentEvidenceKind; reason: string }>
} {
  const accepted: ExternalEvidence[] = []
  const missing: InternalDeploymentEvidenceKind[] = []
  const invalid: Array<{ kind: InternalDeploymentEvidenceKind; reason: string }> = []
  for (const kind of INTERNAL_DEPLOYMENT_EVIDENCE_KINDS) {
    const file = directory ? resolve(directory, `${kind}.json`) : undefined
    if (!file || !existsSync(file)) {
      missing.push(kind)
      continue
    }
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ExternalEvidence>
      if (
        value.schemaVersion !== 1
        || value.kind !== kind
        || value.commit !== commit
        || value.ok !== true
        || typeof value.executedAt !== 'string'
        || Number.isNaN(Date.parse(value.executedAt))
        || typeof value.notes !== 'string'
        || value.notes.trim().length === 0
      ) {
        invalid.push({ kind, reason: 'invalid_or_wrong_commit' })
        continue
      }
      accepted.push(value as ExternalEvidence)
    } catch {
      invalid.push({ kind, reason: 'invalid_json' })
    }
  }
  return { accepted, missing, invalid }
}
