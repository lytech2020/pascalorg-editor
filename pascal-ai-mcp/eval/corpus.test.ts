import { describe, expect, test } from 'bun:test'
import { loadEvalCorpus } from './corpus'

describe('eval corpus manifest', () => {
  test('derives the authoritative count and numeric gaps from eval/cases', () => {
    const corpus = loadEvalCorpus()
    expect(corpus.caseCount).toBe(corpus.caseIds.length)
    expect(corpus.caseCount).toBe(23)
    expect(corpus.numericRange).toEqual({ first: 2, last: 24 })
    expect(corpus.missingNumericCaseIds).toEqual([])
    expect(corpus.caseIds).not.toContain('case-01')
  })
})
