#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type CheckResult = {
  name: string
  command: string[]
  ok: boolean
  exitCode: number
  elapsedMs: number
}

const root = join(import.meta.dir, '..')
const checks = [
  {
    name: 'planning-and-template-regression',
    command: [
      'bun',
      'test',
      'src/plan-builder.test.ts',
      'src/template-seed.test.ts',
      'src/template-schema.test.ts',
      'src/layout-partitioner.test.ts',
      'src/plan-validator.test.ts',
    ],
  },
  {
    name: 'eval-corpus-contract',
    command: ['bun', 'eval/run-eval.ts', '--dry-run'],
  },
] as const

const results: CheckResult[] = []
for (const check of checks) {
  const started = performance.now()
  const run = Bun.spawnSync([...check.command], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  results.push({
    name: check.name,
    command: [...check.command],
    ok: run.exitCode === 0,
    exitCode: run.exitCode,
    elapsedMs: Math.round(performance.now() - started),
  })
}

const generatedAt = new Date().toISOString()
const report = {
  schemaVersion: 1,
  mode: 'deterministic' as const,
  generatedAt,
  zeroToken: true,
  ok: results.every(result => result.ok),
  checks: results,
}
const timestamp = generatedAt.replace(/[:.]/g, '-')
const reportDir = join(root, 'eval', 'report', 'deterministic', timestamp)
mkdirSync(reportDir, { recursive: true })
writeFileSync(join(reportDir, 'summary.json'), JSON.stringify(report, null, 2))
writeFileSync(join(reportDir, 'summary.md'), [
  '# pascal-ai-mcp deterministic eval',
  '',
  `- schemaVersion: ${report.schemaVersion}`,
  `- generatedAt: ${report.generatedAt}`,
  `- zeroToken: ${report.zeroToken}`,
  `- result: ${report.ok ? 'PASS' : 'FAIL'}`,
  '',
  '## Checks',
  '',
  ...results.map(result =>
    `- ${result.ok ? 'PASS' : 'FAIL'} ${result.name} (${result.elapsedMs}ms, exit=${result.exitCode})`),
  '',
].join('\n'))

console.log(`\nDeterministic report: ${reportDir}`)
process.exit(report.ok ? 0 : 1)
