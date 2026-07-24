import { describe, expect, test } from 'bun:test'
import type { LayoutPlan } from '../layout-plan'
import { checkWetRoomFurnitureFeasibility } from './furniture-feasibility'

function plan(name: string, polygon: Array<[number, number]>): LayoutPlan {
  return {
    footprint: { width: 5, depth: 5 },
    entry: { roomId: 'bath' },
    rooms: [{
      id: 'bath',
      name,
      type: 'bathroom',
      polygon,
      requiresExteriorWindow: false,
    }],
    connections: [],
  }
}

describe('wet-room furniture feasibility', () => {
  test('accepts a compact Japanese toilet with room for its toilet fixture', () => {
    expect(checkWetRoomFurnitureFeasibility(
      plan('トイレ', [[0, 0], [1.2, 0], [1.2, 1.6], [0, 1.6]]),
      'jp',
    )).toEqual([])
  })

  test('rejects an impossibly narrow full bathroom before scene construction', () => {
    expect(checkWetRoomFurnitureFeasibility(
      plan('卫生间', [[0, 0], [0.55, 0], [0.55, 1.2], [0, 1.2]]),
    )).toMatchObject([{
      code: 'required_wet_fixture_set_unplaceable',
      roomId: 'bath',
    }])
  })
})
