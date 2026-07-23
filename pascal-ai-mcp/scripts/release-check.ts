#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectReleaseVersionSummary,
  parseReleaseGateArgs,
  releaseChecks,
  type ReleaseCheck,
} from './release-check-core'

type CheckResult = {
  id: string
  command: string[]
  paid: boolean
  status: 'passed' | 'failed' | 'skipped'
  exitCode?: number
  elapsedMs: number
  reason?: string
}

const root = join(import.meta.dir, '..')

try {
  const options = parseReleaseGateArgs(process.argv.slice(2))
  const versions = collectReleaseVersionSummary(root)
  const checks = releaseChecks(options)
  const results: CheckResult[] = []
  let failureReason: string | undefined

  if (versions.dirty && !options.allowDirty) {
    failureReason = 'dirty_worktree'
  } else {
    for (const check of checks.free) results.push(runCheck(check))
    if (checks.provider) {
      if (results.every(result => result.status === 'passed')) {
        results.push(runCheck(checks.provider))
      } else {
        results.push({
          id: checks.provider.id,
          command: checks.provider.command,
          paid: true,
          status: 'skipped',
          elapsedMs: 0,
          reason: 'free_gate_failed',
        })
      }
    }
  }

  const ok = !failureReason && results.every(result => result.status === 'passed')
  const generatedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    generatedAt,
    ok,
    mode: options.providerEval ? 'free-and-provider' : 'free',
    allowDirty: options.allowDirty,
    failureReason,
    versions,
    provider: {
      requested: options.providerEval,
      cases: options.providerCases,
      repeat: options.providerRepeat,
    },
    checks: results,
  }
  const reportDir = join(
    root,
    'eval',
    'report',
    'release',
    generatedAt.replace(/[:.]/g, '-'),
  )
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(reportDir, 'summary.md'), renderMarkdown(report))
  console.log(JSON.stringify({
    event: 'release_gate_result',
    ok,
    mode: report.mode,
    failureReason,
    commit: versions.commit,
    dirty: versions.dirty,
    databaseSchemaVersion: versions.databaseSchema.version,
    templateSchemaVersion: versions.templateSchemaVersion,
    promptVersions: versions.prompts.map(prompt => ({
      id: prompt.id,
      version: prompt.version,
      hash: prompt.promptHash,
    })),
    reportDir,
  }))
  process.exit(ok ? 0 : 1)
} catch (error) {
  console.error(JSON.stringify({
    event: 'release_gate_invalid',
    errorCode: 'invalid_release_gate_configuration',
    message: error instanceof Error ? error.message : 'unknown error',
  }))
  process.exit(2)
}

function runCheck(check: ReleaseCheck): CheckResult {
  console.log(`\n[release:check] ${check.id}: ${check.command.join(' ')}`)
  const startedAt = performance.now()
  const result = Bun.spawnSync(check.command, {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return {
    id: check.id,
    command: check.command,
    paid: check.paid,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    elapsedMs: Math.round(performance.now() - startedAt),
  }
}

function renderMarkdown(report: {
  generatedAt: string
  ok: boolean
  mode: string
  failureReason?: string
  versions: ReturnType<typeof collectReleaseVersionSummary>
  checks: CheckResult[]
}): string {
  return [
    '# Pascal AI release gate',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- result: ${report.ok ? 'PASS' : 'FAIL'}`,
    `- mode: ${report.mode}`,
    `- failureReason: ${report.failureReason ?? 'none'}`,
    `- commit: ${report.versions.commit}`,
    `- dirty: ${report.versions.dirty}`,
    `- databaseSchema: ${report.versions.databaseSchema.version} (${report.versions.databaseSchema.name}, source=${report.versions.databaseSchema.source})`,
    `- templateSchema: ${report.versions.templateSchemaVersion}`,
    '',
    '## Prompt versions',
    '',
    ...report.versions.prompts.map(prompt =>
      `- ${prompt.promptVersion}: ${prompt.promptHash}`),
    '',
    '## Checks',
    '',
    ...report.checks.map(check =>
      `- ${check.status.toUpperCase()} ${check.id} (paid=${check.paid}, exit=${check.exitCode ?? 'n/a'}, ${check.elapsedMs}ms${check.reason ? `, ${check.reason}` : ''})`),
    '',
  ].join('\n')
}
