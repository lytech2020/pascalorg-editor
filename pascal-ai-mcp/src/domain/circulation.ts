import { classifyRoomTypeByName } from '../lang/room-vocab'
import { kitchenIsCirculation, type RoomType } from '../layout-plan'
import { segmentsCoverSameLine } from './geometry/wall-segments'

export type ZoneSummary = { id: string; name: string; polygon: Array<[number, number]> }
export type WallOpening = { type: string }
export type WallWithOpenings = {
  id: string
  start: [number, number]
  end: [number, number]
  openings: WallOpening[]
  thickness?: number
  height?: number
  name?: string
}

type CirculationRoomKind = 'bedroom' | 'blocked-service' | 'passable'
const EXTERIOR_BOUNDARY_EPSILON_M = 0.15

export function findDoorlessRooms(zones: ZoneSummary[], walls: WallWithOpenings[]): string[] {
  const doorless: string[] = []
  for (const zone of zones) {
    let hasDoor = false
    for (let i = 0; i < zone.polygon.length && !hasDoor; i++) {
      const edge = { start: zone.polygon[i]!, end: zone.polygon[(i + 1) % zone.polygon.length]! }
      hasDoor = walls.some(
        wall => segmentsCoverSameLine(wall, edge) && wall.openings.some(opening => opening.type === 'door'),
      )
    }
    if (!hasDoor) doorless.push(zone.name || zone.id)
  }
  return doorless
}

export function findIsolatedBedrooms(
  zones: ZoneSummary[],
  walls: WallWithOpenings[],
  zoneTypes: Record<string, RoomType> = {},
): string[] {
  const kindById = new Map<string, CirculationRoomKind>()
  const typeFor = (zone: ZoneSummary) => zoneTypes[zone.id] ?? classifyRoomTypeByName(zone.name || '')
  for (const zone of zones) kindById.set(zone.id, circulationKind(typeFor(zone)))

  const allTypes = zones.map(typeFor)
  if (kitchenIsCirculation({
    bedrooms: [...kindById.values()].filter(kind => kind === 'bedroom').length,
    hallways: allTypes.filter(type => type === 'hallway').length,
    livingLike: allTypes.filter(type =>
      type === 'living' || type === 'living_kitchen' || type === 'dining').length,
  })) {
    for (const zone of zones) {
      if (typeFor(zone) === 'kitchen') kindById.set(zone.id, 'passable')
    }
  }

  const bounds = zoneBounds(zones)
  const adjacency = new Map<string, Set<string>>()
  const exteriorDoorZoneIds = new Set<string>()
  for (const zone of zones) adjacency.set(zone.id, new Set())
  for (const wall of walls) {
    if (!wall.openings.some(opening => opening.type === 'door')) continue
    const hostIds = wallHostZoneIds(wall, zones)
    if (hostIds.length === 1 && bounds && segmentMidpointIsOnBounds(wall, bounds)) {
      exteriorDoorZoneIds.add(hostIds[0]!)
    }
    for (let i = 0; i < hostIds.length; i++) {
      for (let j = i + 1; j < hostIds.length; j++) {
        adjacency.get(hostIds[i]!)?.add(hostIds[j]!)
        adjacency.get(hostIds[j]!)?.add(hostIds[i]!)
      }
    }
  }

  const isolated: string[] = []
  for (const zone of zones) {
    if (kindById.get(zone.id) !== 'bedroom' || exteriorDoorZoneIds.has(zone.id)) continue
    const visited = new Set<string>([zone.id])
    const queue = [zone.id]
    let reachedPassable = false
    while (queue.length > 0 && !reachedPassable) {
      const current = queue.shift()!
      for (const neighborId of adjacency.get(current) ?? []) {
        if (visited.has(neighborId)) continue
        visited.add(neighborId)
        if (kindById.get(neighborId) === 'passable') {
          reachedPassable = true
          break
        }
      }
    }
    if (!reachedPassable) isolated.push(zone.name || zone.id)
  }
  return isolated
}

export function findStrayWindows(zones: ZoneSummary[], walls: WallWithOpenings[]): string[] {
  const bounds = zoneBounds(zones)
  if (!bounds) return []
  return walls
    .filter(wall => wall.openings.some(opening => opening.type === 'window'))
    .filter(wall => !segmentMidpointIsOnBounds(wall, bounds))
    .map(wall => wall.id)
}

function circulationKind(type: RoomType): CirculationRoomKind {
  if (type === 'bedroom') return 'bedroom'
  if (type === 'kitchen' || type === 'bathroom') return 'blocked-service'
  return 'passable'
}

function wallHostZoneIds(
  wall: { start: [number, number]; end: [number, number] },
  zones: ZoneSummary[],
): string[] {
  return zones.filter(zone => zone.polygon.some((start, index) =>
    segmentsCoverSameLine(wall, { start, end: zone.polygon[(index + 1) % zone.polygon.length]! }),
  )).map(zone => zone.id)
}

function zoneBounds(
  zones: ZoneSummary[],
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (zones.length === 0) return null
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (const zone of zones) {
    for (const [x, z] of zone.polygon) {
      bounds.minX = Math.min(bounds.minX, x)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.minZ = Math.min(bounds.minZ, z)
      bounds.maxZ = Math.max(bounds.maxZ, z)
    }
  }
  return bounds
}

function segmentMidpointIsOnBounds(
  segment: { start: [number, number]; end: [number, number] },
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
): boolean {
  const midX = (segment.start[0] + segment.end[0]) / 2
  const midZ = (segment.start[1] + segment.end[1]) / 2
  return Math.abs(midX - bounds.minX) <= EXTERIOR_BOUNDARY_EPSILON_M
    || Math.abs(midX - bounds.maxX) <= EXTERIOR_BOUNDARY_EPSILON_M
    || Math.abs(midZ - bounds.minZ) <= EXTERIOR_BOUNDARY_EPSILON_M
    || Math.abs(midZ - bounds.maxZ) <= EXTERIOR_BOUNDARY_EPSILON_M
}
