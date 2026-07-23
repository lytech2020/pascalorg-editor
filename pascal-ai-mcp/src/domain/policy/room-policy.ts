import { isDiningKitchenName } from '../../lang/room-vocab'
import type { RoomKind } from '../../layout-metrics'
import type { RoomType } from '../../layout-plan'
import type { NormProfile } from '../../norms/profile'

export const TYPE_TO_KIND: Record<RoomType, RoomKind> = {
  bedroom: 'bedroom',
  bathroom: 'bathroom',
  kitchen: 'kitchen',
  living: 'living',
  living_kitchen: 'living',
  dining: 'other',
  hallway: 'circulation',
  entry: 'circulation',
  study: 'other',
  storage: 'other',
  balcony: 'other',
  other: 'other',
}

export function areaBoundFor(
  profile: NormProfile,
  context: Parameters<NormProfile['roomAreaBounds']>[0],
  type: RoomType,
  name: string,
  hasStandaloneKitchen = false,
): ReturnType<NormProfile['roomAreaBounds']>[RoomKind] {
  if (type === 'living_kitchen' && profile.dkAreaBounds && isDiningKitchenName(name)) {
    return profile.dkAreaBounds(context)
  }
  if (type === 'living' && hasStandaloneKitchen && profile.ldAreaBounds) {
    return profile.ldAreaBounds(context)
  }
  return profile.roomAreaBounds(context)[TYPE_TO_KIND[type]]
}
