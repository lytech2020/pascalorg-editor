import {
  evaluateCompletionGates,
  type GateItem,
  type GateReport,
  type GateTargets,
  type GateWall,
  type GateZone,
} from '../completion-gates'
import {
  ValidationRegistry,
  type ValidationResult,
  type ValidationStage,
} from '../domain/validation-registry'
import type { LayoutPlan } from '../layout-plan'
import type { NormProfile } from '../norms/profile'
import { validateLayoutPlan, type PlanTargets, type PlanValidation } from '../plan-validator'
import type { FurniturePlacementIssue } from '../types'
import type { LocalPatchScopeFinding } from '../domain/local-patch-scope'
import type { DiagnosticsSummary } from './generate-service'

export const VALIDATOR_IDS = {
  layoutPlan: 'layout-plan',
  completionGates: 'completion-gates',
  mcpValidateScene: 'mcp-validate-scene',
  mcpVerifyScene: 'mcp-verify-scene',
  collisionCheck: 'collision-check',
  furniturePlacement: 'furniture-placement',
  modificationProtection: 'modification-protection',
  localPatchScope: 'local-patch-scope',
  sceneDiagnostics: 'scene-diagnostics',
} as const

export type DirectValidatorId =
  | typeof VALIDATOR_IDS.layoutPlan
  | typeof VALIDATOR_IDS.completionGates
  | typeof VALIDATOR_IDS.sceneDiagnostics
  | typeof VALIDATOR_IDS.localPatchScope

export type ValidationUnavailableReason = 'cancelled' | 'timeout' | 'tool_error'

export type ValidationContext = {
  layoutPlan?: {
    plan: LayoutPlan
    targets: PlanTargets
    profile: NormProfile
    validation?: PlanValidation
  }
  layoutPlanFailure?: { failureCount: number }
  completion?: {
    zones: GateZone[]
    walls: GateWall[]
    items: GateItem[]
    targets: GateTargets
  }
  mcpValidation?: {
    valid: boolean
    errors: string[]
    verificationIssues: string[]
    collisions: Array<{ aId: string; bId: string; kind: string }>
  }
  furniturePlacementIssues?: FurniturePlacementIssue[]
  modificationProtection?: { evaluate: () => string[] | Promise<string[]> }
  localPatchScope?: { findings: LocalPatchScopeFinding[] }
  sceneDiagnostics?: DiagnosticsSummary
  unavailable?: {
    validatorId: DirectValidatorId
    reason: ValidationUnavailableReason
  }
}

export type McpValidationSources = {
  validationRaw: unknown
  verificationRaw: unknown
  collisionsRaw: unknown
}

export type ValidationToolCaller = (
  name: 'validate_scene' | 'verify_scene' | 'check_collisions',
  args: Record<string, unknown>,
) => Promise<unknown>

export async function readMcpValidationSources(
  callTool: ValidationToolCaller,
): Promise<McpValidationSources> {
  const [validationRaw, verificationRaw, collisionsRaw] = await Promise.all([
    callTool('validate_scene', {}),
    callTool('verify_scene', {}),
    callTool('check_collisions', {}),
  ])
  return { validationRaw, verificationRaw, collisionsRaw }
}

export function validationUnavailableReason(error: unknown): ValidationUnavailableReason {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || /\b(cancelled|canceled|aborted)\b/i.test(error.message)) {
      return 'cancelled'
    }
    if (/timeout/i.test(error.name) || /timed?\s*out/i.test(error.message)) return 'timeout'
  }
  return 'tool_error'
}

export function createValidationRegistry(): ValidationRegistry<ValidationContext> {
  const registry = new ValidationRegistry<ValidationContext>()

  registry.register({
    id: VALIDATOR_IDS.layoutPlan,
    stages: ['plan', 'modify'],
    scope: 'layout-plan',
    severity: 'error',
    inputRequirements: ['layoutPlan or layoutPlanFailure'],
    auditMode: 'direct',
    canRun: context => context.layoutPlan !== undefined || context.layoutPlanFailure !== undefined,
    evaluate: context => {
      if (context.layoutPlanFailure) {
        const failureCount = context.layoutPlanFailure.failureCount
        return {
          status: 'failed' as const,
          issueCount: failureCount,
          summary: { fatalCount: failureCount, warningCount: 0 },
          disposition: 'stop' as const,
          value: undefined,
        }
      }
      const input = context.layoutPlan!
      const validation = input.validation
        ?? validateLayoutPlan(input.plan, input.targets, input.profile)
      return layoutPlanOutput(validation)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.completionGates,
    stages: ['structure', 'furniture', 'modify', 'verification'],
    scope: 'scene-completion',
    severity: 'error',
    inputRequirements: ['zones', 'walls', 'items', 'targets'],
    auditMode: 'direct',
    canRun: context => context.completion !== undefined
      || context.unavailable?.validatorId === VALIDATOR_IDS.completionGates,
    evaluate: context => {
      if (context.unavailable?.validatorId === VALIDATOR_IDS.completionGates) {
        return unavailableOutput(context.unavailable.reason)
      }
      const input = context.completion!
      const report = evaluateCompletionGates(input.zones, input.walls, input.items, input.targets)
      return {
        status: report.passed ? 'passed' as const : 'failed' as const,
        issueCount: report.failures.length,
        summary: {
          failedGates: [...new Set(report.failures.map(failure => failure.gate))].sort(),
          failureKinds: [...new Set(report.failures.map(failure => failure.id))].sort(),
        },
        disposition: report.passed ? 'continue' as const : 'repair' as const,
        value: report,
      }
    },
  })

  registry.register({
    id: VALIDATOR_IDS.mcpValidateScene,
    stages: ['structure', 'furniture', 'modify', 'verification'],
    scope: 'scene-schema',
    severity: 'error',
    inputRequirements: ['validate_scene result'],
    auditMode: 'aggregate',
    canRun: context => context.mcpValidation !== undefined,
    evaluate: context => {
      const input = context.mcpValidation!
      return componentOutput(input.errors.length, input.valid && input.errors.length === 0, input.errors)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.mcpVerifyScene,
    stages: ['structure', 'furniture', 'modify', 'verification'],
    scope: 'scene-integrity',
    severity: 'error',
    inputRequirements: ['verify_scene result'],
    auditMode: 'aggregate',
    canRun: context => context.mcpValidation !== undefined,
    evaluate: context => {
      const issues = context.mcpValidation!.verificationIssues
      return componentOutput(issues.length, issues.length === 0, issues)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.collisionCheck,
    stages: ['furniture', 'modify', 'verification'],
    scope: 'scene-collisions',
    severity: 'error',
    inputRequirements: ['check_collisions result'],
    auditMode: 'aggregate',
    canRun: context => context.mcpValidation !== undefined,
    evaluate: context => {
      const collisions = context.mcpValidation!.collisions
      return componentOutput(collisions.length, collisions.length === 0, collisions)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.furniturePlacement,
    stages: ['furniture', 'modify', 'verification'],
    scope: 'furniture-placement',
    severity: 'error',
    inputRequirements: ['furniture placement issues'],
    auditMode: 'aggregate',
    canRun: context => context.furniturePlacementIssues !== undefined,
    evaluate: context => {
      const issues = context.furniturePlacementIssues!
      return componentOutput(issues.length, issues.length === 0, issues)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.modificationProtection,
    stages: ['modify'],
    scope: 'modification-protection',
    severity: 'error',
    inputRequirements: ['before snapshot', 'after snapshot', 'confirmed request'],
    auditMode: 'aggregate',
    canRun: context => context.modificationProtection !== undefined,
    evaluate: async context => {
      const issues = await context.modificationProtection!.evaluate()
      return componentOutput(issues.length, issues.length === 0, issues)
    },
  })

  registry.register({
    id: VALIDATOR_IDS.localPatchScope,
    stages: ['modify'],
    scope: 'local-patch-scope',
    severity: 'error',
    inputRequirements: ['before scene', 'after scene', 'allowed node fields'],
    auditMode: 'direct',
    canRun: context => context.localPatchScope !== undefined
      || context.unavailable?.validatorId === VALIDATOR_IDS.localPatchScope,
    evaluate: context => {
      if (context.unavailable?.validatorId === VALIDATOR_IDS.localPatchScope) {
        return unavailableOutput(context.unavailable.reason)
      }
      const findings = context.localPatchScope!.findings
      return {
        status: findings.length === 0 ? 'passed' as const : 'failed' as const,
        issueCount: findings.length,
        summary: {
          findingCount: findings.length,
          findingKinds: [...new Set(findings.map(finding => finding.code))].sort(),
        },
        disposition: findings.length === 0 ? 'continue' as const : 'stop' as const,
        value: findings,
      }
    },
  })

  registry.register({
    id: VALIDATOR_IDS.sceneDiagnostics,
    stages: ['structure', 'furniture', 'modify', 'verification'],
    scope: 'scene-diagnostics',
    severity: 'error',
    inputRequirements: ['normalized scene diagnostics'],
    auditMode: 'direct',
    canRun: context => context.sceneDiagnostics !== undefined
      || context.unavailable?.validatorId === VALIDATOR_IDS.sceneDiagnostics,
    evaluate: context => {
      if (context.unavailable?.validatorId === VALIDATOR_IDS.sceneDiagnostics) {
        return unavailableOutput(context.unavailable.reason)
      }
      const diagnostics = context.sceneDiagnostics!
      const summary = diagnosticIssueCounts(diagnostics)
      const issueCount = Object.values(summary).reduce((sum, count) => sum + count, 0)
      return {
        status: issueCount === 0 ? 'passed' as const : 'failed' as const,
        issueCount,
        summary,
        disposition: issueCount === 0 ? 'continue' as const : 'repair' as const,
        value: diagnostics,
      }
    },
  })

  return registry
}

export function directValidationResults(results: ValidationResult[]): ValidationResult[] {
  return results.filter(result => result.auditMode === 'direct')
}

export function recordDirectValidationResults(
  results: ValidationResult[],
  record: (result: ValidationResult) => void,
): void {
  for (const result of directValidationResults(results)) record(result)
}

export function validationValue<T>(results: ValidationResult[], validatorId: string): T {
  const result = results.find(entry => entry.validatorId === validatorId)
  if (!result) throw new Error(`validation result is unavailable: ${validatorId}`)
  return result.value as T
}

function layoutPlanOutput(validation: PlanValidation) {
  const fatalCount = validation.fatal.length
  return {
    status: fatalCount === 0 ? 'passed' as const : 'failed' as const,
    issueCount: fatalCount + validation.warnings.length,
    summary: {
      fatalCount,
      warningCount: validation.warnings.length,
      score: validation.score,
    },
    disposition: fatalCount === 0 ? 'continue' as const : 'stop' as const,
    value: validation,
  }
}

function componentOutput<T>(issueCount: number, passed: boolean, value: T) {
  return {
    status: passed ? 'passed' as const : 'failed' as const,
    issueCount,
    summary: { issueCount },
    disposition: passed ? 'continue' as const : 'repair' as const,
    value,
  }
}

function unavailableOutput(reason: ValidationUnavailableReason) {
  return {
    status: 'unavailable' as const,
    issueCount: 0,
    summary: { reason },
    disposition: 'unavailable' as const,
    value: undefined,
  }
}

function diagnosticIssueCounts(diagnostics: DiagnosticsSummary): Record<string, number> {
  return {
    validationErrors: diagnostics.validation.errors.length,
    verificationIssues: diagnostics.verificationIssues.length,
    collisions: diagnostics.collisions.length,
    doorlessRooms: diagnostics.doorlessRooms.length,
    strayWindows: diagnostics.strayWindows.length,
    requirementMismatches: diagnostics.requirementMismatches.length,
    isolatedBedrooms: diagnostics.isolatedBedrooms.length,
    furniturePlacementIssues: diagnostics.furniturePlacementIssues?.length ?? 0,
  }
}
