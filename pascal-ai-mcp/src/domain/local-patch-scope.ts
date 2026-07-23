export type SceneNodeSnapshot = Record<string, Record<string, unknown>>

export type LocalPatchAllowance = {
  nodeId: string
  fields: readonly string[] | 'all'
}

export type LocalPatchScopeFinding = {
  code:
    | 'unexpected_node_added'
    | 'unexpected_node_removed'
    | 'unexpected_node_modified'
  nodeId: string
  fields: string[]
}

export function validateLocalPatchScope(
  before: SceneNodeSnapshot,
  after: SceneNodeSnapshot,
  allowances: readonly LocalPatchAllowance[],
): LocalPatchScopeFinding[] {
  const allowed = new Map(allowances.map(allowance => [allowance.nodeId, allowance.fields]))
  const findings: LocalPatchScopeFinding[] = []
  const nodeIds = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()

  for (const nodeId of nodeIds) {
    const previous = before[nodeId]
    const current = after[nodeId]
    const permitted = allowed.get(nodeId)
    if (!previous && current) {
      if (permitted !== 'all') {
        findings.push({ code: 'unexpected_node_added', nodeId, fields: Object.keys(current).sort() })
      }
      continue
    }
    if (previous && !current) {
      if (permitted !== 'all') {
        findings.push({ code: 'unexpected_node_removed', nodeId, fields: Object.keys(previous).sort() })
      }
      continue
    }
    if (!previous || !current) continue

    const changed = changedFields(previous, current)
    if (changed.length === 0 || permitted === 'all') continue
    const permittedFields = new Set(permitted ?? [])
    const unexpected = changed.filter(field => !permittedFields.has(field))
    if (unexpected.length > 0) {
      findings.push({ code: 'unexpected_node_modified', nodeId, fields: unexpected })
    }
  }
  return findings
}

function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(field => stableJson(before[field]) !== stableJson(after[field]))
    .sort()
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
