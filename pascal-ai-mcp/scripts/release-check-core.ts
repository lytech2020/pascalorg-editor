import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/persistence/database'
import { promptRegistryEntries } from '../src/prompts/registry'
import { TEMPLATE_SCHEMA_VERSION } from '../src/template-schema'

export type ReleaseGateOptions = {
  allowDirty: boolean
  providerEval: boolean
  providerCases: string[]
  providerRepeat: number
}

export type ReleaseCheck = {
  id: string
  command: string[]
  paid: boolean
}

export type ReleaseVersionSummary = {
  commit: string
  dirty: boolean
  databaseSchema: {
    version: number
    name: string
    source: 'schema_migrations'
  }
  templateSchemaVersion: number
  prompts: ReturnType<typeof promptRegistryEntries>
}

export function parseReleaseGateArgs(args: string[]): ReleaseGateOptions {
  let allowDirty = false
  let providerEval = false
  let providerCases: string[] = []
  let providerRepeat = 1
  for (const arg of args) {
    if (arg === '--') continue
    if (arg === '--allow-dirty') {
      allowDirty = true
      continue
    }
    if (arg === '--with-provider-eval') {
      providerEval = true
      continue
    }
    if (arg.startsWith('--provider-only=')) {
      providerCases = [...new Set(
        arg.slice('--provider-only='.length).split(',').map(value => value.trim()).filter(Boolean),
      )]
      continue
    }
    if (arg.startsWith('--provider-repeat=')) {
      const parsed = Number.parseInt(arg.slice('--provider-repeat='.length), 10)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
        throw new Error('--provider-repeat must be an integer from 1 to 5')
      }
      providerRepeat = parsed
      continue
    }
    throw new Error(`unknown release gate argument: ${arg}`)
  }
  if (!providerEval && (providerCases.length > 0 || providerRepeat !== 1)) {
    throw new Error('provider options require --with-provider-eval')
  }
  if (providerEval && (providerCases.length < 1 || providerCases.length > 3)) {
    throw new Error('--with-provider-eval requires 1 to 3 explicit --provider-only case ids')
  }
  for (const caseId of providerCases) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(caseId)) {
      throw new Error(`invalid provider case id: ${caseId}`)
    }
  }
  return { allowDirty, providerEval, providerCases, providerRepeat }
}

export function releaseChecks(options: ReleaseGateOptions): {
  free: ReleaseCheck[]
  provider?: ReleaseCheck
} {
  const free: ReleaseCheck[] = [
    {
      id: 'typecheck',
      command: ['bun', 'run', 'check-types'],
      paid: false,
    },
    {
      id: 'tests',
      command: ['bun', 'test', '--max-concurrency=1'],
      paid: false,
    },
    {
      id: 'templates',
      command: ['bun', 'run', 'templates:check', '--', '--no-artifacts'],
      paid: false,
    },
    {
      id: 'deterministic-eval',
      command: ['bun', 'run', 'eval:deterministic'],
      paid: false,
    },
  ]
  if (!options.providerEval) return { free }
  return {
    free,
    provider: {
      id: 'provider-eval',
      command: [
        'bun',
        'eval/run-eval.ts',
        '--allow-provider-cost',
        `--only=${options.providerCases.join(',')}`,
        `--repeat=${options.providerRepeat}`,
      ],
      paid: true,
    },
  }
}

export function collectReleaseVersionSummary(root: string): ReleaseVersionSummary {
  const commit = commandOutput(['git', 'rev-parse', 'HEAD'], root)
  const dirty = commandOutput(['git', 'status', '--porcelain', '--untracked-files=all'], root)
    .length > 0
  const directory = mkdtempSync(join(tmpdir(), 'pascal-release-schema-'))
  try {
    const database = new AppDatabase(join(directory, 'schema.db'))
    try {
      const row = database.connection.query(`
        SELECT version, name
        FROM schema_migrations
        WHERE version = (SELECT MAX(version) FROM schema_migrations)
      `).get() as { version: number; name: string } | null
      if (!row) throw new Error('schema_migrations is empty')
      return {
        commit,
        dirty,
        databaseSchema: {
          version: row.version,
          name: row.name,
          source: 'schema_migrations',
        },
        templateSchemaVersion: TEMPLATE_SCHEMA_VERSION,
        prompts: promptRegistryEntries().sort((a, b) => a.id.localeCompare(b.id)),
      }
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function commandOutput(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`command failed while collecting release metadata: ${command.join(' ')}`)
  }
  return result.stdout.toString().trim()
}
