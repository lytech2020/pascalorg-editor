import { describe, expect, test } from 'bun:test'
import {
  classifyModificationMode,
  confirmedModificationMatches,
  needsModificationConfirmation,
  planRequiresBatchConfirmation,
} from './modification-mode'

describe('modification mode classifier', () => {
  test.each([
    ['rename_room', 'local_patch', 'rename_only'],
    ['add_furniture', 'local_patch', 'furniture_only'],
    ['remove_furniture', 'local_patch', 'furniture_only'],
    ['swap_furniture', 'local_patch', 'furniture_only'],
    ['clear_room_furniture', 'local_patch', 'clear_room_furniture'],
    ['add_room', 'plan_rebuild', 'add_room'],
    ['remove_room', 'plan_rebuild', 'remove_room'],
    ['resize_room', 'plan_rebuild', 'resize_room'],
  ] as const)('%s has a stable mode and reason', (op, mode, reasonCode) => {
    expect(classifyModificationMode([{ op }])).toEqual({
      mode,
      reasonCode,
      operationTypes: [op],
    })
  })

  // P1-1: a clear (alone or mixed with rename) stays a LOCAL patch but must be
  // flagged for batch confirmation — so the confirmation gate fires on every
  // local path, not just a pure furniture-only plan.
  test('clear ops require batch confirmation, alone or mixed with rename', () => {
    expect(planRequiresBatchConfirmation([{ op: 'clear_room_furniture' }])).toBe(true)
    expect(planRequiresBatchConfirmation([{ op: 'rename_room' }, { op: 'clear_room_furniture' }])).toBe(true)
    expect(classifyModificationMode([{ op: 'rename_room' }, { op: 'clear_room_furniture' }]).mode).toBe('local_patch')
    // Non-clear local plans are not batch-gated.
    expect(planRequiresBatchConfirmation([{ op: 'add_furniture' }])).toBe(false)
  })

  test('rename plus furniture remains local', () => {
    expect(classifyModificationMode([
      { op: 'rename_room' },
      { op: 'add_furniture' },
    ])).toEqual({
      mode: 'local_patch',
      reasonCode: 'rename_and_furniture',
      operationTypes: ['add_furniture', 'rename_room'],
    })
  })

  test('any structural operation upgrades a mixed request to rebuild', () => {
    expect(classifyModificationMode([
      { op: 'add_furniture' },
      { op: 'resize_room' },
    ])).toEqual({
      mode: 'plan_rebuild',
      reasonCode: 'mixed_structural',
      operationTypes: ['add_furniture', 'resize_room'],
    })
  })

  test('empty and unknown operations never guess local patch', () => {
    expect(classifyModificationMode([])).toMatchObject({
      mode: 'plan_rebuild',
      reasonCode: 'unsupported_or_unknown',
    })
    expect(classifyModificationMode([{ op: 'move_wall' }])).toEqual({
      mode: 'plan_rebuild',
      reasonCode: 'unsupported_or_unknown',
      operationTypes: ['move_wall'],
    })
  })

  test('only an unconfirmed rebuild requires confirmation', () => {
    const local = classifyModificationMode([{ op: 'rename_room' }])
    const rebuild = classifyModificationMode([{ op: 'resize_room' }])
    expect(needsModificationConfirmation(local, undefined)).toBe(false)
    expect(needsModificationConfirmation(rebuild, undefined)).toBe(true)
    expect(needsModificationConfirmation(rebuild, true)).toBe(false)
  })

  test('confirmation is bound to the exact classified operation plan', () => {
    const rebuild = classifyModificationMode([{ op: 'resize_room' }])
    const pending = {
      mode: rebuild.mode,
      reasonCode: rebuild.reasonCode,
      planHash: 'hash-a',
      confirmed: true,
    }
    expect(confirmedModificationMatches(rebuild, 'hash-a', pending)).toBe(true)
    expect(confirmedModificationMatches(rebuild, 'hash-b', pending)).toBe(false)
    expect(confirmedModificationMatches(
      classifyModificationMode([{ op: 'remove_room' }]),
      'hash-a',
      pending,
    )).toBe(false)
  })
})
