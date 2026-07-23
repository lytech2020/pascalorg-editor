export const VALIDATION_STAGES = [
  'plan',
  'structure',
  'furniture',
  'modify',
  'verification',
] as const

export type ValidationStage = typeof VALIDATION_STAGES[number]
export type ValidationStatus = 'passed' | 'failed' | 'unavailable'
export type ValidationSeverity = 'warning' | 'error'
export type ValidationDisposition = 'continue' | 'repair' | 'confirm' | 'stop' | 'unavailable'
export type ValidationAuditMode = 'direct' | 'aggregate'

export type ValidationSummaryValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>

export type ValidationResult<T = unknown> = {
  validatorId: string
  status: ValidationStatus
  issueCount: number
  summary: Record<string, ValidationSummaryValue>
  disposition: ValidationDisposition
  auditMode: ValidationAuditMode
  value: T
}

export type ValidationCheck<TContext, TValue = unknown> = {
  id: string
  stages: readonly ValidationStage[]
  scope: string
  severity: ValidationSeverity
  inputRequirements: readonly string[]
  auditMode: ValidationAuditMode
  canRun: (context: TContext) => boolean
  evaluate: (context: TContext) => ValidationCheckOutput<TValue> | Promise<ValidationCheckOutput<TValue>>
}

export type ValidationCheckOutput<T> = Omit<ValidationResult<T>, 'validatorId' | 'auditMode'>

export class ValidationRegistry<TContext> {
  private readonly checks = new Map<string, ValidationCheck<TContext, unknown>>()

  register<TValue>(check: ValidationCheck<TContext, TValue>): void {
    if (this.checks.has(check.id)) throw new Error(`validation check already registered: ${check.id}`)
    this.checks.set(check.id, check as ValidationCheck<TContext, unknown>)
  }

  definitionsFor(stage: ValidationStage): ReadonlyArray<ValidationCheck<TContext, unknown>> {
    return [...this.checks.values()].filter(check => check.stages.includes(stage))
  }

  async runStage(stage: ValidationStage, context: TContext): Promise<ValidationResult[]> {
    const results: ValidationResult[] = []
    for (const check of this.definitionsFor(stage)) {
      if (!check.canRun(context)) continue
      const output = await check.evaluate(context)
      results.push({
        validatorId: check.id,
        auditMode: check.auditMode,
        ...output,
      })
    }
    return results
  }
}
