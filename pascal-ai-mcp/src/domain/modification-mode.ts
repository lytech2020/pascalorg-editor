export const MODIFICATION_MODES = ['local_patch', 'plan_rebuild'] as const

export type ModificationMode = typeof MODIFICATION_MODES[number]

export const MODIFICATION_MODE_REASONS = [
  'rename_only',
  'furniture_only',
  'rename_and_furniture',
  'clear_room_furniture',
  'add_room',
  'remove_room',
  'resize_room',
  'mixed_structural',
  'unsupported_or_unknown',
] as const

export type ModificationModeReason = typeof MODIFICATION_MODE_REASONS[number]

export type ModificationOperation = {
  op: string
}

export type ModificationModeDecision = {
  mode: ModificationMode
  reasonCode: ModificationModeReason
  operationTypes: string[]
}

const FURNITURE_OPERATIONS = new Set([
  'add_furniture',
  'remove_furniture',
  'swap_furniture',
  'clear_room_furniture',
])

// R4: a bulk furniture clear is destructive enough to require an explicit
// count-and-confirm turn before it writes, even though it stays a local patch.
export function planRequiresBatchConfirmation(
  operations: readonly ModificationOperation[],
): boolean {
  return operations.some(operation => operation.op === 'clear_room_furniture')
}

const STRUCTURAL_OPERATIONS = new Set([
  'add_room',
  'remove_room',
  'resize_room',
])

export function classifyModificationMode(
  operations: readonly ModificationOperation[],
): ModificationModeDecision {
  const operationTypes = [...new Set(operations.map(operation => operation.op))].sort()
  if (
    operations.length === 0
    || operations.some(operation =>
      operation.op !== 'rename_room'
      && !FURNITURE_OPERATIONS.has(operation.op)
      && !STRUCTURAL_OPERATIONS.has(operation.op))
  ) {
    return {
      mode: 'plan_rebuild',
      reasonCode: 'unsupported_or_unknown',
      operationTypes,
    }
  }

  const structuralTypes = operationTypes.filter(operation => STRUCTURAL_OPERATIONS.has(operation))
  if (structuralTypes.length > 0) {
    const reasonCode = structuralTypes.length > 1 || operationTypes.length > 1
      ? 'mixed_structural'
      : structuralReason(structuralTypes[0]!)
    return { mode: 'plan_rebuild', reasonCode, operationTypes }
  }

  const hasRename = operationTypes.includes('rename_room')
  const hasFurniture = operationTypes.some(operation => FURNITURE_OPERATIONS.has(operation))
  const hasClear = operationTypes.includes('clear_room_furniture')
  return {
    mode: 'local_patch',
    reasonCode: hasRename && hasFurniture
      ? 'rename_and_furniture'
      : hasRename ? 'rename_only'
        : hasClear ? 'clear_room_furniture'
          : 'furniture_only',
    operationTypes,
  }
}

export function needsModificationConfirmation(
  decision: ModificationModeDecision,
  confirmed: boolean | undefined,
): boolean {
  return decision.mode === 'plan_rebuild' && confirmed !== true
}

export function confirmedModificationMatches(
  decision: ModificationModeDecision,
  planHash: string,
  pending: {
    mode?: ModificationMode
    reasonCode?: ModificationModeReason
    planHash?: string
    confirmed?: boolean
  },
): boolean {
  return pending.confirmed === true
    && pending.mode === decision.mode
    && pending.reasonCode === decision.reasonCode
    && pending.planHash === planHash
}

function structuralReason(operation: string): ModificationModeReason {
  if (operation === 'add_room') return 'add_room'
  if (operation === 'remove_room') return 'remove_room'
  return 'resize_room'
}
