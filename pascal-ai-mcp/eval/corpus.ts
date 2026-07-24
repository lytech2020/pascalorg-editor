import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalCase } from './evaluate-run'

export const EVAL_CASES_DIR = join(import.meta.dir, 'cases')

export type EvalCorpus = {
  cases: EvalCase[]
  caseIds: string[]
  caseCount: number
  numericRange: { first: number; last: number } | null
  missingNumericCaseIds: string[]
}

function numericCaseId(caseId: string): number | undefined {
  const match = /^case-(\d+)(?:-|$)/.exec(caseId)
  return match ? Number.parseInt(match[1]!, 10) : undefined
}

export function loadEvalCorpus(casesDir = EVAL_CASES_DIR): EvalCorpus {
  const files = readdirSync(casesDir).filter(file => file.endsWith('.json')).sort()
  const parsed = files.map(file => JSON.parse(readFileSync(join(casesDir, file), 'utf8')) as EvalCase)
  const independent = parsed.filter(testCase => !testCase.basedOn)
  const dependent = parsed.filter(testCase => testCase.basedOn)
  const cases = [...independent, ...dependent]
  const caseIds = cases.map(testCase => testCase.id)
  const numericIds = caseIds
    .map(numericCaseId)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b)
  const numericRange = numericIds.length > 0
    ? { first: numericIds[0]!, last: numericIds[numericIds.length - 1]! }
    : null
  const numericSet = new Set(numericIds)
  const missingNumericCaseIds: string[] = []
  if (numericRange) {
    for (let value = numericRange.first; value <= numericRange.last; value++) {
      if (!numericSet.has(value)) missingNumericCaseIds.push(`case-${String(value).padStart(2, '0')}`)
    }
  }
  return {
    cases,
    caseIds,
    caseCount: cases.length,
    numericRange,
    missingNumericCaseIds,
  }
}
