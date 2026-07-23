import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  internalDeploymentDecision,
  parseInternalDeploymentArgs,
  readExternalEvidence,
  selectedInternalDeploymentChecks,
} from './internal-deployment-check-core'

describe('internal deployment check', () => {
  test('selects explicit checks and keeps external work opt-in', () => {
    const options = parseInternalDeploymentArgs([
      '--allow-dirty',
      '--automated-only',
      '--only=e3,E8,e3',
      '--evidence-dir=./evidence',
    ])
    expect(options.allowDirty).toBe(true)
    expect(options.automatedOnly).toBe(true)
    expect(options.only).toEqual(['E3', 'E8'])
    expect(selectedInternalDeploymentChecks(options).map(check => check.id)).toEqual(['E3', 'E8'])
  })

  test('rejects unknown checks instead of silently skipping them', () => {
    expect(() => parseInternalDeploymentArgs(['--only=E10'])).toThrow(
      'unknown internal deployment check',
    )
  })

  test('accepts only complete evidence from the exact commit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pascal-deployment-evidence-'))
    writeFileSync(join(directory, 'provider.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'provider',
      commit: 'commit-a',
      executedAt: '2026-07-23T10:00:00.000Z',
      ok: true,
      notes: 'three explicit paid cases passed twice',
    }))
    writeFileSync(join(directory, 'browser.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'browser',
      commit: 'wrong-commit',
      executedAt: '2026-07-23T10:00:00.000Z',
      ok: true,
      notes: 'browser flow passed',
    }))

    const evidence = readExternalEvidence(directory, 'commit-a')
    expect(evidence.accepted.map(item => item.kind)).toEqual(['provider'])
    expect(evidence.missing).toEqual(['startup', 'rollback'])
    expect(evidence.invalid).toEqual([
      { kind: 'browser', reason: 'invalid_or_wrong_commit' },
    ])
  })

  test('a dirty worktree can pass development automation but can never declare GO', () => {
    const decision = internalDeploymentDecision({
      automatedPassed: true,
      dirty: true,
      fullCheckSet: true,
      external: {
        accepted: [
          evidence('provider'),
          evidence('browser'),
          evidence('startup'),
          evidence('rollback'),
        ],
        missing: [],
        invalid: [],
      },
    })
    expect(decision).toEqual({
      go: false,
      blockers: ['dirty_worktree'],
    })
  })
})

function evidence(kind: 'provider' | 'browser' | 'startup' | 'rollback') {
  return {
    schemaVersion: 1 as const,
    kind,
    commit: 'commit-a',
    executedAt: '2026-07-23T10:00:00.000Z',
    ok: true as const,
    notes: 'passed',
  }
}
