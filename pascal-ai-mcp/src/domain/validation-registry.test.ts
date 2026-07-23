import { describe, expect, test } from 'bun:test'
import { ValidationRegistry, type ValidationCheck } from './validation-registry'

type Context = { available: boolean; issues: number }

function check(id: string, stages: ValidationCheck<Context>['stages']): ValidationCheck<Context> {
  return {
    id,
    stages,
    scope: 'test',
    severity: 'error',
    inputRequirements: ['available'],
    auditMode: 'direct',
    canRun: context => context.available,
    evaluate: context => ({
      status: context.issues === 0 ? 'passed' : 'failed',
      issueCount: context.issues,
      summary: { issues: context.issues },
      disposition: context.issues === 0 ? 'continue' : 'stop',
      value: context.issues,
    }),
  }
}

describe('validation registry', () => {
  test('selects checks by stage and skips checks whose inputs are unavailable', async () => {
    const registry = new ValidationRegistry<Context>()
    registry.register(check('plan-check', ['plan']))
    registry.register(check('shared-check', ['plan', 'modify']))

    expect((await registry.runStage('plan', { available: true, issues: 2 }))
      .map(result => result.validatorId)).toEqual(['plan-check', 'shared-check'])
    expect(await registry.runStage('modify', { available: false, issues: 0 })).toEqual([])
    expect(await registry.runStage('verification', { available: true, issues: 0 })).toEqual([])
  })

  test('rejects duplicate stable ids', () => {
    const registry = new ValidationRegistry<Context>()
    registry.register(check('same-id', ['plan']))
    expect(() => registry.register(check('same-id', ['modify']))).toThrow(
      'validation check already registered: same-id',
    )
  })
})
