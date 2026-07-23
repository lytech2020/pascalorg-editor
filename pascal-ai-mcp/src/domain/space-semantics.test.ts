import { describe, expect, test } from 'bun:test'
import {
  inferOutdoorSemantic,
  roomTypeForUsage,
  semanticForRoomType,
} from './space-semantics'

describe('space semantics domain', () => {
  test('maps layout room types to stable scene-space categories', () => {
    expect(semanticForRoomType('bedroom')).toEqual({ usage: 'bedroom', category: 'indoor_room' })
    expect(semanticForRoomType('hallway')).toEqual({ usage: 'hallway', category: 'circulation' })
    expect(semanticForRoomType('balcony')).toEqual({ usage: 'balcony', category: 'outdoor' })
  })

  test('keeps unknown usages forward compatible', () => {
    expect(roomTypeForUsage('bedroom')).toBe('bedroom')
    expect(roomTypeForUsage('future-custom-space')).toBeUndefined()
  })

  test('recognizes outdoor names without classifying ordinary rooms as gardens', () => {
    expect(inferOutdoorSemantic('Back garden')).toEqual({ usage: 'garden', category: 'outdoor' })
    expect(inferOutdoorSemantic('中庭')).toEqual({ usage: 'garden', category: 'outdoor' })
    expect(inferOutdoorSemantic('客厅')).toBeUndefined()
  })
})
