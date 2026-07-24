import { describe, expect, test } from 'bun:test'
import matrix from '../eval/crud-matrix.json'
import { loadEvalCorpus } from '../eval/corpus'

describe('AI CRUD acceptance matrix', () => {
  test('covers every verb and required target without claiming unsupported writes succeed', () => {
    expect(matrix.schemaVersion).toBe(1)
    const ids = matrix.operations.map(operation => operation.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const verb of ['create', 'read', 'update', 'delete', 'mixed']) {
      expect(matrix.operations.some(operation => operation.verb === verb)).toBe(true)
    }
    for (const target of ['room', 'opening', 'furniture', 'scene']) {
      expect(matrix.operations.some(operation => operation.target === target)).toBe(true)
    }
    for (const operation of matrix.operations) {
      expect(operation.deterministicEvidence.length).toBeGreaterThan(0)
      expect(['supported', 'safe_rejection', 'failed_recoverable']).toContain(
        operation.disposition,
      )
    }
    expect(
      matrix.operations.find(operation => operation.id === 'direct-opening-edit')?.disposition,
    ).toBe('safe_rejection')
    expect(
      matrix.operations.find(operation => operation.id === 'move-furniture-with-position')
        ?.disposition,
    ).toBe('safe_rejection')
  })

  test('keeps paid provider coverage explicit and bounded to existing cases', async () => {
    const caseIds = new Set(loadEvalCorpus().caseIds)
    const providerCases = new Set(
      matrix.operations.flatMap(operation => operation.providerCases),
    )
    for (const caseId of providerCases) expect(caseIds.has(caseId)).toBe(true)
  })
})
