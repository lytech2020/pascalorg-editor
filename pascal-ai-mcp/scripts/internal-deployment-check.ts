#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectReleaseVersionSummary } from './release-check-core'
import {
  internalDeploymentDecision,
  parseInternalDeploymentArgs,
  readExternalEvidence,
  selectedInternalDeploymentChecks,
  type InternalDeploymentCheck,
} from './internal-deployment-check-core'

type CommandResult = {
  command: string[]
  status: 'passed' | 'failed'
  exitCode: number
  elapsedMs: number
}

type CheckResult = {
  id: string
  title: string
  status: 'passed' | 'failed'
  commands: CommandResult[]
  evidence: InternalDeploymentCheck['evidence']
}

const root = join(import.meta.dir, '..')

try {
  const options = parseInternalDeploymentArgs(process.argv.slice(2))
  const versions = collectReleaseVersionSummary(root)
  const checks = selectedInternalDeploymentChecks(options)
  const results: CheckResult[] = []
  let failureReason: string | undefined

  if (versions.dirty && !options.allowDirty) {
    failureReason = 'dirty_worktree'
  } else {
    for (const check of checks) {
      const commandResults = check.commands.map(command => runCommand(check.id, command))
      results.push({
        id: check.id,
        title: check.title,
        status: commandResults.every(result => result.status === 'passed') ? 'passed' : 'failed',
        commands: commandResults,
        evidence: check.evidence,
      })
    }
  }

  const external = readExternalEvidence(options.evidenceDir, versions.commit)
  const automatedPassed = !failureReason
    && results.length === checks.length
    && results.every(result => result.status === 'passed')
  const decision = internalDeploymentDecision({
    automatedPassed,
    dirty: versions.dirty,
    fullCheckSet: checks.length === 6,
    external,
  })
  const go = decision.go
  const generatedAt = new Date().toISOString()
  const report = {
    schemaVersion: 1,
    generatedAt,
    versions,
    requestedChecks: checks.map(check => check.id),
    automatedOnly: options.automatedOnly,
    automatedPassed,
    goNoGo: go ? 'GO' : 'NO-GO',
    failureReason,
    checks: results,
    externalEvidence: external,
    blockers: decision.blockers,
  }
  const reportDir = join(
    root,
    'eval',
    'report',
    'deployment',
    generatedAt.replace(/[:.]/g, '-'),
  )
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(reportDir, 'summary.md'), renderMarkdown(report))

  console.log(JSON.stringify({
    event: 'internal_deployment_result',
    automatedPassed,
    goNoGo: report.goNoGo,
    blockers: report.blockers,
    commit: versions.commit,
    dirty: versions.dirty,
    reportDir,
  }))
  process.exit(options.automatedOnly ? (automatedPassed ? 0 : 1) : (go ? 0 : 1))
} catch (error) {
  console.error(JSON.stringify({
    event: 'internal_deployment_invalid',
    errorCode: 'invalid_internal_deployment_configuration',
    message: error instanceof Error ? error.message : 'unknown error',
  }))
  process.exit(2)
}

function runCommand(checkId: string, command: string[]): CommandResult {
  console.log(`\n[internal:check] ${checkId}: ${command.join(' ')}`)
  const startedAt = performance.now()
  const result = Bun.spawnSync(command, {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return {
    command,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    elapsedMs: Math.round(performance.now() - startedAt),
  }
}

function renderMarkdown(report: {
  generatedAt: string
  automatedPassed: boolean
  goNoGo: string
  blockers: string[]
  versions: ReturnType<typeof collectReleaseVersionSummary>
  checks: CheckResult[]
  externalEvidence: ReturnType<typeof readExternalEvidence>
}): string {
  return [
    '# Pascal AI internal deployment assessment',
    '',
    `- generatedAt: ${report.generatedAt}`,
    `- commit: ${report.versions.commit}`,
    `- dirty: ${report.versions.dirty}`,
    `- databaseSchema: ${report.versions.databaseSchema.version}`,
    `- automated: ${report.automatedPassed ? 'PASS' : 'FAIL'}`,
    `- decision: ${report.goNoGo}`,
    `- blockers: ${report.blockers.join(', ') || 'none'}`,
    '',
    '## Automated checks',
    '',
    ...report.checks.flatMap(check => [
      `### ${check.id} ${check.title}`,
      '',
      `- result: ${check.status.toUpperCase()}`,
      ...check.commands.map(command =>
        `- ${command.status.toUpperCase()} \`${command.command.join(' ')}\` (${command.elapsedMs}ms)`),
      ...check.evidence.map(item =>
        `- evidence: ${item.scenario} — ${item.test}${item.requestId ? `; requestId=${item.requestId}` : ''}${item.sessionId ? `; sessionId=${item.sessionId}` : ''}`),
      '',
    ]),
    '## External evidence',
    '',
    `- accepted: ${report.externalEvidence.accepted.map(item => item.kind).join(', ') || 'none'}`,
    `- missing: ${report.externalEvidence.missing.join(', ') || 'none'}`,
    `- invalid: ${report.externalEvidence.invalid.map(item => `${item.kind}:${item.reason}`).join(', ') || 'none'}`,
    '',
    'A NO-GO caused only by missing external evidence means the zero-cost automated checks passed, but paid provider, browser, live startup, or controlled old-commit rollback evidence has not yet been attached.',
    '',
  ].join('\n')
}
