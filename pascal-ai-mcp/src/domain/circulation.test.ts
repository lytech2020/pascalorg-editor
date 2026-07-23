import { describe, expect, test } from 'bun:test'
import {
  findDoorlessRooms,
  findIsolatedBedrooms,
  findStrayWindows,
  type WallWithOpenings,
  type ZoneSummary,
} from './circulation'

const zones: ZoneSummary[] = [
  { id: 'bed', name: '卧室', polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] },
  { id: 'hall', name: '走廊', polygon: [[4, 0], [8, 0], [8, 3], [4, 3]] },
]

const wall = (
  id: string,
  start: [number, number],
  end: [number, number],
  type: 'door' | 'window',
): WallWithOpenings => ({ id, start, end, openings: [{ type }] })

describe('circulation domain', () => {
  test('detects doorless rooms from hosted wall openings', () => {
    expect(findDoorlessRooms(zones, [wall('door', [4, 0], [4, 3], 'door')])).toEqual([])
    expect(findDoorlessRooms(zones, [])).toEqual(['卧室', '走廊'])
  })

  test('requires bedrooms to reach a passable room without crossing a blocked service room', () => {
    expect(findIsolatedBedrooms(zones, [wall('door', [4, 0], [4, 3], 'door')])).toEqual([])
    const kitchen: ZoneSummary = {
      id: 'kitchen',
      name: '厨房',
      polygon: [[4, 0], [8, 0], [8, 3], [4, 3]],
    }
    const living: ZoneSummary = {
      id: 'living',
      name: '客厅',
      polygon: [[8, 0], [12, 0], [12, 3], [8, 3]],
    }
    expect(findIsolatedBedrooms(
      [zones[0]!, kitchen, living],
      [wall('door', [4, 0.5], [4, 2.5], 'door')],
    )).toEqual(['卧室'])
  })

  test('flags windows hosted away from the exterior bounds', () => {
    expect(findStrayWindows(zones, [wall('inside', [4, 0], [4, 3], 'window')])).toEqual(['inside'])
    expect(findStrayWindows(zones, [wall('outside', [0, 0], [0, 3], 'window')])).toEqual([])
  })
})
