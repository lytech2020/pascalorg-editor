import { createHash } from 'node:crypto'
import type { ModifyPlan } from '../modify-ops'

export type ParsedModifyPlan = {
  plan: ModifyPlan | null
  errors: string[]
}

export async function resolveModifyPlanForExecution(options: {
  confirmed: boolean
  pendingPlan?: ModifyPlan
  translate: () => Promise<ParsedModifyPlan>
}): Promise<ParsedModifyPlan> {
  if (options.confirmed && options.pendingPlan) {
    return { plan: structuredClone(options.pendingPlan), errors: [] }
  }
  return options.translate()
}

export function canonicalModifyPlanHash(plan: ModifyPlan): string {
  return createHash('sha256').update(stableJson(plan)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
