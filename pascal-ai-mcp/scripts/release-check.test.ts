import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  collectReleaseVersionSummary,
  parseReleaseGateArgs,
  releaseChecks,
} from './release-check-core'

describe('release gate', () => {
  test('keeps provider evaluation out of the default zero-cost gate', () => {
    const options = parseReleaseGateArgs([])
    expect(options).toEqual({
      allowDirty: false,
      providerEval: false,
      providerCases: [],
      providerRepeat: 1,
    })
    const checks = releaseChecks(options)
    expect(checks.provider).toBeUndefined()
    expect(checks.free.map(check => check.id)).toEqual([
      'typecheck',
      'tests',
      'templates',
      'deterministic-eval',
    ])
    expect(checks.free.every(check => !check.paid)).toBe(true)
  })

  test('requires an explicit paid flag and one to three selected cases', () => {
    expect(() => parseReleaseGateArgs([
      '--provider-only=case-02-studio',
    ])).toThrow('require --with-provider-eval')
    expect(() => parseReleaseGateArgs([
      '--with-provider-eval',
    ])).toThrow('requires 1 to 3')
    expect(() => parseReleaseGateArgs([
      '--with-provider-eval',
      '--provider-only=a,b,c,d',
    ])).toThrow('requires 1 to 3')

    const options = parseReleaseGateArgs([
      '--with-provider-eval',
      '--provider-only=case-02-studio,case-03-two-bed-standard',
      '--provider-repeat=3',
    ])
    const provider = releaseChecks(options).provider
    expect(provider?.paid).toBe(true)
    expect(provider?.command).toEqual([
      'bun',
      'eval/run-eval.ts',
      '--allow-provider-cost',
      '--only=case-02-studio,case-03-two-bed-standard',
      '--repeat=3',
    ])
  })

  test('reads schema version from a migrated schema_migrations table', () => {
    const root = join(import.meta.dir, '..')
    const summary = collectReleaseVersionSummary(root)
    expect(summary.databaseSchema).toEqual({
      version: 14,
      name: 'track_request_execution_source',
      source: 'schema_migrations',
    })
    expect(summary.templateSchemaVersion).toBe(2)
    expect(summary.prompts).toHaveLength(9)
    expect(summary.prompts.every(prompt => prompt.promptHash.length === 64)).toBe(true)
    expect(summary.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
