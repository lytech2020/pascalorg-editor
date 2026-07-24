import { describe, expect, test } from 'bun:test'
import { checkFurniturePlacement, checkModificationProtection } from '../agent'
import { evaluateCompletionGates, type GateReport } from '../completion-gates'
import type { LayoutPlan } from '../layout-plan'
import { DEFAULT_NORM_PROFILE } from '../norms/profile'
import { validateLayoutPlan, type PlanValidation } from '../plan-validator'
import type { DiagnosticsSummary } from './generate-service'
import {
  createValidationRegistry,
  directValidationResults,
  readMcpValidationSources,
  recordDirectValidationResults,
  VALIDATOR_IDS,
  validationUnavailableReason,
  validationValue,
} from './validation-service'

function rect(x: number, z: number, width: number, depth: number): Array<[number, number]> {
  return [[x, z], [x + width, z], [x + width, z + depth], [x, z + depth]]
}

function plan(): LayoutPlan {
  return {
    footprint: { width: 8, depth: 6 },
    entry: { roomId: 'living-1' },
    rooms: [
      { id: 'living-1', name: '客厅', type: 'living', polygon: rect(0, 0, 8, 3.5), requiresExteriorWindow: true },
      { id: 'bedroom-1', name: '卧室', type: 'bedroom', polygon: rect(0, 3.5, 5.5, 2.5), requiresExteriorWindow: true },
      { id: 'bath-1', name: '卫生间', type: 'bathroom', polygon: rect(5.5, 3.5, 2.5, 2.5), requiresExteriorWindow: false },
    ],
    connections: [
      { from: 'living-1', to: 'bedroom-1', type: 'door' },
      { from: 'living-1', to: 'bath-1', type: 'door' },
    ],
  }
}

function diagnostics(): DiagnosticsSummary {
  return {
    validation: { valid: false, errors: ['schema'] },
    verificationIssues: ['integrity'],
    collisions: [{ aId: 'a', bId: 'b', kind: 'overlap' }],
    doorlessRooms: [],
    strayWindows: [],
    requirementMismatches: [],
    isolatedBedrooms: [],
    furniturePlacementIssues: [],
  }
}

describe('validation application service', () => {
  test('layout wrapper is field-for-field equivalent to the existing validator', async () => {
    const registry = createValidationRegistry()
    const input = { plan: plan(), targets: { totalAreaSqm: 48 }, profile: DEFAULT_NORM_PROFILE }
    const results = await registry.runStage('plan', { layoutPlan: input })
    expect(validationValue<PlanValidation>(results, VALIDATOR_IDS.layoutPlan)).toEqual(
      validateLayoutPlan(input.plan, input.targets, input.profile),
    )
    expect(directValidationResults(results).map(result => result.validatorId)).toEqual(['layout-plan'])
  })

  test('keeps a plan fatal as a stopping failure', async () => {
    const invalid = plan()
    invalid.rooms[1]!.polygon = rect(20, 20, 1, 1)
    const results = await createValidationRegistry().runStage('plan', {
      layoutPlan: {
        plan: invalid,
        targets: { totalAreaSqm: 48 },
        profile: DEFAULT_NORM_PROFILE,
      },
    })
    expect(results.find(result => result.validatorId === VALIDATOR_IDS.layoutPlan)).toMatchObject({
      status: 'failed',
      disposition: 'stop',
    })
  })

  test('completion wrapper preserves the existing gate report', async () => {
    const registry = createValidationRegistry()
    const completion = {
      zones: [{ id: 'room', name: '客厅', polygon: rect(0, 0, 4, 4) }],
      walls: [{ id: 'outside', start: [0, 0] as [number, number], end: [4, 0] as [number, number], openings: [{ type: 'door' }] }],
      items: [],
      targets: {},
    }
    const results = await registry.runStage('verification', { completion })
    expect(validationValue<GateReport>(results, VALIDATOR_IDS.completionGates)).toEqual(
      evaluateCompletionGates(completion.zones, completion.walls, completion.items, completion.targets),
    )
  })

  test('keeps component checks aggregate and the legacy audit record set unchanged', async () => {
    const registry = createValidationRegistry()
    const results = await registry.runStage('verification', {
      mcpValidation: {
        valid: false,
        errors: ['schema'],
        verificationIssues: ['integrity'],
        collisions: [{ aId: 'a', bId: 'b', kind: 'overlap' }],
      },
      furniturePlacementIssues: [],
      sceneDiagnostics: diagnostics(),
    })
    expect(results.map(result => result.validatorId)).toEqual([
      'mcp-validate-scene',
      'mcp-verify-scene',
      'collision-check',
      'furniture-placement',
      'scene-diagnostics',
    ])
    const recorded: Array<[string, number]> = []
    recordDirectValidationResults(results, result => recorded.push([result.validatorId, result.issueCount]))
    expect(recorded).toEqual([['scene-diagnostics', 3]])
  })

  test('runs modification protection through the registry without adding a second audit row', async () => {
    const expected = checkModificationProtection({}, {
      'zone-1': {
        type: 'zone',
        name: '新增书房',
        polygon: rect(0, 0, 1, 1),
      },
    }, '新增一个 10-12㎡ 的书房')
    const results = await createValidationRegistry().runStage('modify', {
      modificationProtection: { evaluate: () => expected },
    })
    expect(validationValue<string[]>(results, VALIDATOR_IDS.modificationProtection)).toEqual(expected)
    expect(directValidationResults(results)).toEqual([])
  })

  test('records local patch scope as a direct stopping result without node details', async () => {
    const results = await createValidationRegistry().runStage('modify', {
      localPatchScope: {
        findings: [{
          code: 'unexpected_node_modified',
          nodeId: 'private-user-node-name',
          fields: ['polygon'],
        }],
      },
    })
    expect(directValidationResults(results)).toEqual([
      expect.objectContaining({
        validatorId: 'local-patch-scope',
        status: 'failed',
        disposition: 'stop',
        summary: {
          findingCount: 1,
          findingKinds: ['unexpected_node_modified'],
        },
      }),
    ])
    const recorded: unknown[] = []
    recordDirectValidationResults(results, result => recorded.push(result.summary))
    expect(JSON.stringify(recorded)).not.toContain('private-user-node-name')
  })

  test('records modification preservation and postconditions with stable code-only summaries', async () => {
    const results = await createValidationRegistry().runStage('modify', {
      modificationPreservation: {
        findings: [
          { code: 'unrelated_room_changed', roomId: 'private-room-name' },
          { code: 'footprint_changed' },
        ],
      },
      modificationPostconditions: {
        findings: [
          { code: 'room_area_target_not_met', operationIndex: 3 },
        ],
      },
    })
    expect(directValidationResults(results)).toEqual([
      expect.objectContaining({
        validatorId: 'modification-preservation',
        status: 'failed',
        disposition: 'stop',
        issueCount: 2,
        summary: {
          findingCount: 2,
          findingKinds: ['footprint_changed', 'unrelated_room_changed'],
        },
      }),
      expect.objectContaining({
        validatorId: 'modification-postconditions',
        status: 'failed',
        disposition: 'stop',
        issueCount: 1,
        summary: {
          findingCount: 1,
          findingKinds: ['room_area_target_not_met'],
        },
      }),
    ])
    const recorded: unknown[] = []
    recordDirectValidationResults(results, result => recorded.push(result.summary))
    expect(JSON.stringify(recorded)).not.toContain('private-room-name')
  })

  test('keeps furniture placement failures repairable and aggregate', async () => {
    const expected = checkFurniturePlacement([], [], [])
    const equivalent = await createValidationRegistry().runStage('furniture', {
      furniturePlacementIssues: expected,
    })
    expect(validationValue<typeof expected>(equivalent, VALIDATOR_IDS.furniturePlacement)).toEqual(expected)

    const results = await createValidationRegistry().runStage('furniture', {
      furniturePlacementIssues: [{
        kind: 'out_of_bounds',
        itemId: 'chair-1',
        message: 'outside room',
      }],
    })
    expect(results).toEqual([
      expect.objectContaining({
        validatorId: VALIDATOR_IDS.furniturePlacement,
        status: 'failed',
        disposition: 'repair',
        issueCount: 1,
        auditMode: 'aggregate',
      }),
    ])
  })

  test('represents unavailable MCP validation without claiming success', async () => {
    const results = await createValidationRegistry().runStage('verification', {
      unavailable: { validatorId: VALIDATOR_IDS.sceneDiagnostics, reason: 'timeout' },
    })
    expect(directValidationResults(results)).toEqual([
      expect.objectContaining({
        validatorId: 'scene-diagnostics',
        status: 'unavailable',
        disposition: 'unavailable',
        summary: { reason: 'timeout' },
      }),
    ])
  })

  test('calls each existing MCP validation tool once and never retries failures', async () => {
    const calls: string[] = []
    const values = await readMcpValidationSources(async name => {
      calls.push(name)
      return name
    })
    expect(calls.sort()).toEqual(['check_collisions', 'validate_scene', 'verify_scene'])
    expect(values).toEqual({
      validationRaw: 'validate_scene',
      verificationRaw: 'verify_scene',
      collisionsRaw: 'check_collisions',
    })

    let attempts = 0
    await expect(readMcpValidationSources(async name => {
      attempts++
      if (name === 'validate_scene') throw new Error('connection refused')
      return name
    })).rejects.toThrow('connection refused')
    expect(attempts).toBe(3)
    expect(validationUnavailableReason(new DOMException('aborted', 'AbortError'))).toBe('cancelled')
    expect(validationUnavailableReason(new Error('request timed out'))).toBe('timeout')
    expect(validationUnavailableReason(new Error('connection refused'))).toBe('tool_error')
  })
})
