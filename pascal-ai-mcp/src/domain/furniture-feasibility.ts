import { findWallPlacement, footprintAt, type Footprint2D } from '../furniture-executor'
import { requiredFurnitureFor } from '../furniture-checklist'
import type { LayoutPlan } from '../layout-plan'

export type FurnitureFeasibilityFinding = {
  code: 'required_wet_fixture_set_unplaceable'
  roomId: string
  requirementKey: string
}

const COMPACT_WET_FIXTURE_DIMS: Record<string, [number, number, number]> = {
  washbasin: [0.5, 0.8, 0.42],
  toilet: [0.62, 0.8, 0.72],
  shower_or_bathtub: [0.78, 2, 0.78],
}

export function checkWetRoomFurnitureFeasibility(
  plan: LayoutPlan,
  market?: string,
): FurnitureFeasibilityFinding[] {
  const findings: FurnitureFeasibilityFinding[] = []
  for (const room of plan.rooms.filter(candidate => candidate.type === 'bathroom')) {
    const occupied: Footprint2D[] = []
    const requirements = requiredFurnitureFor(room.type, room.name, market)
      .filter(requirement => requirement.key in COMPACT_WET_FIXTURE_DIMS)
      .sort((left, right) => right.placementPriority - left.placementPriority)
    for (const requirement of requirements) {
      const dims = COMPACT_WET_FIXTURE_DIMS[requirement.key]!
      const placement = findWallPlacement({
        polygon: room.polygon,
        itemDims: dims,
        occupied,
        keepClear: [],
      })
      if (!placement) {
        findings.push({
          code: 'required_wet_fixture_set_unplaceable',
          roomId: room.id,
          requirementKey: requirement.key,
        })
        break
      }
      occupied.push(footprintAt(
        placement.position[0],
        placement.position[2],
        dims[0],
        dims[2],
        placement.rotationY,
      ))
    }
  }
  return findings
}
