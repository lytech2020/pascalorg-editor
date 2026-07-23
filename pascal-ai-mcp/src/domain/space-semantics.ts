import { ROOM_TYPES, type RoomType } from '../layout-plan'

export type SpaceCategory = 'indoor_room' | 'service' | 'circulation' | 'outdoor' | 'unknown'
export type SpaceSemanticSource =
  | 'layout_plan'
  | 'template'
  | 'legacy_session_cache'
  | 'legacy_name_inference'
  | 'manual'

export type SpaceSemantic = {
  usage: string
  category: SpaceCategory
}

export type SceneSpaceRecord = {
  sceneId: string
  zoneId: string
  usage: string
  category: SpaceCategory
  source: SpaceSemanticSource
  confidence: number
  templateId?: string
  planRoomId?: string
  planVersion?: string
  sceneVersion?: number
  createdAt: string
  updatedAt: string
}

export const LAYOUT_PLAN_SEMANTICS_VERSION = 'layout-plan-v1'

const ROOM_TYPE_CATEGORIES: Record<RoomType, SpaceCategory> = {
  bedroom: 'indoor_room',
  living: 'indoor_room',
  living_kitchen: 'indoor_room',
  dining: 'indoor_room',
  kitchen: 'service',
  bathroom: 'service',
  study: 'indoor_room',
  hallway: 'circulation',
  entry: 'circulation',
  storage: 'service',
  balcony: 'outdoor',
  other: 'unknown',
}

const OUTDOOR_NAME = /(?:garden|yard|courtyard|terrace|庭|庭院|花园|花園|中庭|ガーデン|庭園)/i

export function semanticForRoomType(type: RoomType): SpaceSemantic {
  return { usage: type, category: ROOM_TYPE_CATEGORIES[type] }
}

export function roomTypeForUsage(usage: string): RoomType | undefined {
  return (ROOM_TYPES as readonly string[]).includes(usage) ? usage as RoomType : undefined
}

export function inferOutdoorSemantic(name: string): SpaceSemantic | undefined {
  return OUTDOOR_NAME.test(name) ? { usage: 'garden', category: 'outdoor' } : undefined
}
