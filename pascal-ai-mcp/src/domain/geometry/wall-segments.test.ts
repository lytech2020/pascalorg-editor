import { describe, expect, test } from 'bun:test'
import {
  collinearOverlap,
  orientationToSegment,
  pointsClose,
  segmentOrientation,
  segmentsCoverSameLine,
  wallsCoincide,
} from './wall-segments'

describe('wall segment domain geometry', () => {
  test('recognizes coincident walls in either direction within tolerance', () => {
    const a = { start: [0, 0], end: [4, 0] } satisfies { start: [number, number]; end: [number, number] }
    const b = { start: [4, 0.01], end: [0, 0.01] } satisfies { start: [number, number]; end: [number, number] }
    expect(pointsClose(a.start, b.end)).toBe(true)
    expect(wallsCoincide(a, b)).toBe(true)
  })

  test('returns only meaningful collinear overlap', () => {
    expect(collinearOverlap(
      { start: [0, 0], end: [6, 0] },
      { start: [2, 0], end: [4, 0] },
    )).toEqual({ axis: 'x', constant: 0, lo: 2, hi: 4 })
    expect(segmentsCoverSameLine(
      { start: [0, 0], end: [1, 0] },
      { start: [2, 0], end: [3, 0] },
    )).toBe(false)
  })

  test('rejects diagonal segments and round-trips axis-aligned orientation', () => {
    expect(segmentOrientation({ start: [0, 0], end: [1, 1] })).toBeNull()
    expect(orientationToSegment({ axis: 'z', constant: 2, lo: 1, hi: 5 })).toEqual({
      start: [2, 1],
      end: [2, 5],
    })
  })
})
