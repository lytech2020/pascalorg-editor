export type Segment = { start: [number, number]; end: [number, number] }
export type SegmentOrientation = { axis: 'x' | 'z'; constant: number; lo: number; hi: number }

export const WALL_COINCIDENCE_EPSILON_M = 0.05
export const MIN_MEANINGFUL_OVERLAP_M = 0.03

export function pointsClose(p: [number, number], q: [number, number]): boolean {
  return Math.hypot(p[0] - q[0], p[1] - q[1]) <= WALL_COINCIDENCE_EPSILON_M
}

export function wallsCoincide(a: Segment, b: Segment): boolean {
  return (pointsClose(a.start, b.start) && pointsClose(a.end, b.end))
    || (pointsClose(a.start, b.end) && pointsClose(a.end, b.start))
}

export function segmentOrientation(seg: Segment): SegmentOrientation | null {
  const [sx, sz] = seg.start
  const [ex, ez] = seg.end
  if (Math.abs(sx - ex) <= WALL_COINCIDENCE_EPSILON_M) {
    return { axis: 'z', constant: (sx + ex) / 2, lo: Math.min(sz, ez), hi: Math.max(sz, ez) }
  }
  if (Math.abs(sz - ez) <= WALL_COINCIDENCE_EPSILON_M) {
    return { axis: 'x', constant: (sz + ez) / 2, lo: Math.min(sx, ex), hi: Math.max(sx, ex) }
  }
  return null
}

export function collinearOverlap(
  a: Segment,
  b: Segment,
): SegmentOrientation | null {
  const oa = segmentOrientation(a)
  const ob = segmentOrientation(b)
  if (!oa || !ob || oa.axis !== ob.axis) return null
  if (Math.abs(oa.constant - ob.constant) > WALL_COINCIDENCE_EPSILON_M) return null
  const lo = Math.max(oa.lo, ob.lo)
  const hi = Math.min(oa.hi, ob.hi)
  if (hi - lo <= MIN_MEANINGFUL_OVERLAP_M) return null
  return { axis: oa.axis, constant: (oa.constant + ob.constant) / 2, lo, hi }
}

export function segmentsCoverSameLine(a: Segment, b: Segment): boolean {
  return wallsCoincide(a, b) || collinearOverlap(a, b) !== null
}

export function orientationToSegment(o: SegmentOrientation): Segment {
  return o.axis === 'x'
    ? { start: [o.lo, o.constant], end: [o.hi, o.constant] }
    : { start: [o.constant, o.lo], end: [o.constant, o.hi] }
}
