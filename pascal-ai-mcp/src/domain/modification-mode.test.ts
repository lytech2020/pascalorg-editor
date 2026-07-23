import { describe, expect, test } from 'bun:test'
import {
  classifyModificationMode,
  confirmedModificationMatches,
  needsModificationConfirmation,
} from './modification-mode'

describe('modification mode classifier', () => {
  test.each([
    ['rename_room', 'local_patch', 'rename_only'],
    ['add_furniture', 'local_patch', 'furniture_only'],
    ['remove_furniture', 'local_patch', 'furniture_only'],
    ['swap_furniture', 'local_patch', 'furniture_only'],
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
