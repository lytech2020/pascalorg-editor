import { issueText } from '../lang/i18n'
import type { DesignBrief, RequirementFact } from '../types'
import type { ZoneSummary } from './circulation'

export const AREA_TOLERANCE_RATIO = 0.1
export const FLOOR_AREA_FACT_KEYS = [
  'total_area',
  'total_area_sqm',
  'floor_area_sqm',
  'area_sqm',
  'room_area_sqm',
  'area',
]
export const MIN_MEANINGFUL_ZONE_OVERLAP_SQM = 0.05

export type MismatchFinding = {
  message: string
  l10n: {
    id: 'zoneOverlap' | 'totalAreaOff' | 'bedroomShortfall' | 'missingSupportSpace'
    params: Record<string, string | number>
  }
}

export function polygonArea(polygon: Array<[number, number]>): number {
  let sum = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, z1] = polygon[i]!
    const [x2, z2] = polygon[(i + 1) % polygon.length]!
    sum += x1 * z2 - x2 * z1
  }
  return Math.abs(sum) / 2
}

export function pointInPolygon(
  x: number,
  z: number,
  polygon: Array<[number, number]>,
): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!
    const [xj, zj] = polygon[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export function computeZoneAreaStats(zones: ZoneSummary[]): {
  sumArea: number
  unionArea: number
  overlapArea: number
  overlappingPairs: Array<{ aName: string; bName: string; areaSqMeters: number }>
} {
  const sumArea = zones.reduce((total, zone) => total + polygonArea(zone.polygon), 0)
  const xs = [...new Set(zones.flatMap(zone => zone.polygon.map(([x]) => x)))].sort((a, b) => a - b)
  const zs = [...new Set(zones.flatMap(zone => zone.polygon.map(([, z]) => z)))].sort((a, b) => a - b)
  let unionArea = 0
  let overlapArea = 0
  const pairAreas = new Map<string, { aName: string; bName: string; areaSqMeters: number }>()
  for (let i = 0; i < xs.length - 1; i++) {
    const cellWidth = xs[i + 1]! - xs[i]!
    if (cellWidth <= 0) continue
    const cx = (xs[i]! + xs[i + 1]!) / 2
    for (let j = 0; j < zs.length - 1; j++) {
      const cellDepth = zs[j + 1]! - zs[j]!
      if (cellDepth <= 0) continue
      const cz = (zs[j]! + zs[j + 1]!) / 2
      const covering = zones.filter(zone => pointInPolygon(cx, cz, zone.polygon))
      if (covering.length === 0) continue
      const cellArea = cellWidth * cellDepth
      unionArea += cellArea
      if (covering.length < 2) continue
      overlapArea += cellArea
      for (let a = 0; a < covering.length; a++) {
        for (let b = a + 1; b < covering.length; b++) {
          const key = [covering[a]!.id, covering[b]!.id].sort().join('|')
          const entry = pairAreas.get(key) ?? {
            aName: covering[a]!.name || covering[a]!.id,
            bName: covering[b]!.name || covering[b]!.id,
            areaSqMeters: 0,
          }
          entry.areaSqMeters += cellArea
          pairAreas.set(key, entry)
        }
      }
    }
  }
  return { sumArea, unionArea, overlapArea, overlappingPairs: [...pairAreas.values()] }
}

export function checkAreaRequirements(zones: ZoneSummary[], brief: DesignBrief): MismatchFinding[] {
  if (zones.length === 0) return []
  const issues: MismatchFinding[] = []
  const stats = computeZoneAreaStats(zones)
  for (const pair of stats.overlappingPairs) {
    if (pair.areaSqMeters <= MIN_MEANINGFUL_ZONE_OVERLAP_SQM) continue
    const params = { a: pair.aName, b: pair.bName, area: round1(pair.areaSqMeters) }
    issues.push({ message: issueText('zh', 'zoneOverlap', params), l10n: { id: 'zoneOverlap', params } })
  }
  const target = numericFact(brief, FLOOR_AREA_FACT_KEYS)
  if (target !== undefined && target > 0) {
    const actual = stats.unionArea
    if (Math.abs(actual - target) > target * AREA_TOLERANCE_RATIO) {
      const deviation = Math.round((Math.abs(actual - target) / target) * 100)
      const params = {
        target,
        actual: round1(actual),
        deviation,
        tolerance: Math.round(AREA_TOLERANCE_RATIO * 100),
      }
      issues.push({ message: issueText('zh', 'totalAreaOff', params), l10n: { id: 'totalAreaOff', params } })
    }
  }
  return issues
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function numericFactValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC')
  const areaMatch = normalized.match(
    /(-?\d+(?:\.\d+)?)\s*(?:m2|m²|㎡|平方米|平米|平方公尺)/iu,
  )
  const numericMatches = [...normalized.matchAll(/-?\d+(?:\.\d+)?/g)]
  const selected = areaMatch?.[1] ?? (
    numericMatches.length === 1 ? numericMatches[0]?.[0] : undefined
  )
  if (!selected) return undefined
  const parsed = Number.parseFloat(selected)
  return Number.isFinite(parsed) ? parsed : undefined
}

function numericFact(brief: DesignBrief, keys: string[]): number | undefined {
  const facts: RequirementFact[] = [
    ...brief.existingCondition,
    ...brief.designGoals,
    ...brief.hardConstraints,
    ...brief.assumptions,
  ]
  const value = facts.find(fact => keys.includes(fact.key.toLowerCase()))?.value
  return numericFactValue(value)
}
